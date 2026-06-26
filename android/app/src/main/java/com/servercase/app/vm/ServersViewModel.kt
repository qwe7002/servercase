package com.servercase.app.vm

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.servercase.app.data.ConnectionState
import com.servercase.app.data.GlobalSettings
import com.servercase.app.data.ServerConfig
import com.servercase.app.data.ServerRepository
import com.servercase.app.data.ServerSecrets
import com.servercase.app.data.ServerStatus
import com.servercase.app.data.SettingsRepository
import com.servercase.app.data.StatusParser
import com.servercase.app.data.SyncPayload
import com.servercase.app.data.bitwarden.BitwardenLockState
import com.servercase.app.data.bitwarden.BitwardenStatus
import com.servercase.app.data.bitwarden.BitwardenVault
import com.servercase.app.data.merging
import com.servercase.app.data.secrets
import com.servercase.app.data.ssh.SshClient
import com.servercase.app.data.strippingSecrets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import java.io.File

data class UiState(
    val servers: List<ServerConfig> = emptyList(),
    val connState: Map<String, ConnectionState> = emptyMap(),
    val status: Map<String, ServerStatus> = emptyMap(),
    val errors: Map<String, String> = emptyMap(),
    val settings: GlobalSettings = GlobalSettings(),
    val bitwardenStatus: BitwardenStatus? = null,
    val settingsMessage: String? = null,
)

class ServersViewModel(app: Application) : AndroidViewModel(app) {

    private val repo = ServerRepository(app)
    private val settingsRepo = SettingsRepository(app)
    private val vault = BitwardenVault()
    private val json = Json { prettyPrint = true; encodeDefaults = true; ignoreUnknownKeys = true }

    private val clients = HashMap<String, SshClient>()
    private val collectors = HashMap<String, StatusParser.CollectorState>()
    private var pollJob: Job? = null
    private var autoSyncJob: Job? = null

    /** Secrets loaded from the unlocked vault, merged into servers in memory. */
    private var vaultSecrets: Map<String, ServerSecrets> = emptyMap()

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch {
            repo.servers.collect { list -> _ui.update { it.copy(servers = applySecrets(list)) } }
        }
        viewModelScope.launch {
            settingsRepo.settings.collect { s ->
                _ui.update { it.copy(settings = s) }
                vault.configure(s.bitwarden)
                restartAutoSync(s)
            }
        }
    }

    private fun vaultEnabled() = _ui.value.settings.bitwarden.enabled

    private fun applySecrets(list: List<ServerConfig>): List<ServerConfig> =
        if (vaultSecrets.isEmpty()) list
        else list.map { server -> vaultSecrets[server.id]?.let(server::merging) ?: server }

    // --- CRUD -------------------------------------------------------------
    fun upsert(server: ServerConfig) = viewModelScope.launch {
        val list = _ui.value.servers.toMutableList()
        val idx = list.indexOfFirst { it.id == server.id }
        if (idx >= 0) list[idx] = server else list += server
        _ui.update { it.copy(servers = list) }
        if (vaultEnabled()) {
            vaultSecrets = vaultSecrets + (server.id to server.secrets())
            runCatching { vault.setSecrets(server.id, server.secrets()) }
        }
        saveServers(list)
    }

    fun delete(id: String) = viewModelScope.launch {
        disconnect(id)
        val list = _ui.value.servers.filterNot { it.id == id }
        _ui.update { it.copy(servers = list) }
        if (vaultEnabled()) {
            vaultSecrets = vaultSecrets - id
            runCatching { vault.deleteSecrets(id) }
        }
        saveServers(list)
    }

    private suspend fun saveServers(list: List<ServerConfig>) {
        repo.save(if (vaultEnabled()) list.map { it.strippingSecrets() } else list)
    }

    // --- Connection -------------------------------------------------------
    fun connect(server: ServerConfig) = viewModelScope.launch {
        setState(server.id, ConnectionState.CONNECTING)
        var cfg = server
        if (vaultEnabled() && server.password == null && server.privateKey == null) {
            runCatching { vault.getSecrets(server.id) }.getOrNull()?.let { cfg = server.merging(it) }
        }
        val client = SshClient(cfg)
        try {
            client.connect()
            clients[server.id] = client
            collectors[server.id] = StatusParser.CollectorState()
            setState(server.id, ConnectionState.CONNECTED)
        } catch (e: Exception) {
            _ui.update { it.copy(errors = it.errors + (server.id to (e.message ?: "connection failed"))) }
            setState(server.id, ConnectionState.ERROR)
        }
    }

    fun disconnect(id: String) {
        clients.remove(id)?.disconnect()
        collectors.remove(id)
        setState(id, ConnectionState.DISCONNECTED)
    }

    fun client(id: String): SshClient? = clients[id]

    /** Poll status for [id] every 3s while it stays connected and selected. */
    fun startPolling(id: String) {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (true) {
                val client = clients[id]
                if (client != null && client.isConnected) {
                    runCatching {
                        val raw = client.exec(StatusParser.STATUS_COMMAND)
                        val collector = collectors.getOrPut(id) { StatusParser.CollectorState() }
                        StatusParser.parse(raw, collector)
                    }.onSuccess { status ->
                        _ui.update { it.copy(status = it.status + (id to status)) }
                    }
                }
                delay(3000)
            }
        }
    }

    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    private fun setState(id: String, state: ConnectionState) {
        _ui.update { it.copy(connState = it.connState + (id to state)) }
    }

    // --- Settings ---------------------------------------------------------
    fun updateSettings(settings: GlobalSettings) = viewModelScope.launch {
        settingsRepo.save(settings)
        // Re-persist servers so secrets are stripped (vault on) or restored (off).
        val list = _ui.value.servers
        repo.save(if (settings.bitwarden.enabled) list.map { it.strippingSecrets() } else list)
    }

    fun setMessage(message: String?) = _ui.update { it.copy(settingsMessage = message) }

    // --- Bitwarden vault --------------------------------------------------
    fun refreshBitwardenStatus() = viewModelScope.launch {
        vault.configure(_ui.value.settings.bitwarden)
        val status = vault.status()
        _ui.update { it.copy(bitwardenStatus = status) }
    }

    fun unlockVault(masterPassword: String) = viewModelScope.launch {
        try {
            val status = vault.unlock(masterPassword)
            _ui.update { it.copy(bitwardenStatus = status, settingsMessage = "Vault unlocked.") }
            if (status.state == BitwardenLockState.UNLOCKED) loadSecretsFromVault()
        } catch (e: Exception) {
            setMessage(e.message ?: "Unlock failed")
        }
    }

    fun lockVault() = viewModelScope.launch {
        runCatching { vault.lock() }
        refreshBitwardenStatus()
    }

    private suspend fun loadSecretsFromVault() {
        runCatching { vault.listSecrets() }.getOrNull()?.let { secrets ->
            vaultSecrets = secrets
            _ui.update { it.copy(servers = applySecrets(it.servers)) }
        }
    }

    fun pushAllSecretsToVault() = viewModelScope.launch {
        runCatching {
            _ui.value.servers.forEach { vault.setSecrets(it.id, it.secrets()) }
            runCatching { vault.sync() }
        }.onSuccess { setMessage("All secrets pushed to the vault.") }
            .onFailure { setMessage(it.message ?: "Push failed") }
    }

    // --- Auto-sync --------------------------------------------------------
    private fun restartAutoSync(settings: GlobalSettings) {
        autoSyncJob?.cancel()
        if (!settings.autoSync.enabled) return
        val minutes = settings.autoSync.intervalMinutes.coerceAtLeast(1)
        autoSyncJob = viewModelScope.launch {
            while (true) {
                delay(minutes * 60_000L)
                writeAutoSyncFile()
            }
        }
    }

    private fun writeAutoSyncFile(): Boolean = runCatching {
        val payload = SyncPayload(
            servers = _ui.value.servers.map { it.strippingSecrets() },
            settings = _ui.value.settings,
        )
        File(getApplication<Application>().filesDir, "servercase-sync.json")
            .writeText(json.encodeToString(payload))
        val s = _ui.value.settings
        viewModelScope.launch {
            settingsRepo.save(s.copy(autoSync = s.autoSync.copy(lastSyncedAt = System.currentTimeMillis())))
        }
        true
    }.getOrDefault(false)

    fun syncNow() = viewModelScope.launch {
        setMessage(if (writeAutoSyncFile()) "Synced to app storage." else "Sync failed.")
    }

    fun exportTo(uri: Uri) = viewModelScope.launch(Dispatchers.IO) {
        runCatching {
            val payload = SyncPayload(
                servers = _ui.value.servers.map { it.strippingSecrets() },
                settings = _ui.value.settings,
            )
            getApplication<Application>().contentResolver.openOutputStream(uri)?.use {
                it.write(json.encodeToString(payload).toByteArray())
            }
        }.onSuccess { setMessage("Exported configuration.") }
            .onFailure { setMessage(it.message ?: "Export failed") }
    }

    fun importFrom(uri: Uri) = viewModelScope.launch(Dispatchers.IO) {
        runCatching {
            val text = getApplication<Application>().contentResolver.openInputStream(uri)
                ?.bufferedReader()?.use { it.readText() } ?: error("empty file")
            val payload = json.decodeFromString<SyncPayload>(text)
            repo.save(payload.servers)
            settingsRepo.save(payload.settings)
        }.onSuccess { setMessage("Configuration imported.") }
            .onFailure { setMessage(it.message ?: "Import failed") }
    }

    override fun onCleared() {
        clients.values.forEach { it.disconnect() }
        clients.clear()
    }
}

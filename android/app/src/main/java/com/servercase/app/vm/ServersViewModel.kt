package com.servercase.app.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.servercase.app.data.CloudClient
import com.servercase.app.data.CloudException
import com.servercase.app.data.CloudSession
import com.servercase.app.data.CloudSessionRepository
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
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class UiState(
    val servers: List<ServerConfig> = emptyList(),
    val connState: Map<String, ConnectionState> = emptyMap(),
    val status: Map<String, ServerStatus> = emptyMap(),
    val errors: Map<String, String> = emptyMap(),
    val settings: GlobalSettings = GlobalSettings(),
    val bitwardenStatus: BitwardenStatus? = null,
    val cloudSession: CloudSession? = null,
    val settingsMessage: String? = null,
)

class ServersViewModel(app: Application) : AndroidViewModel(app) {

    private val repo = ServerRepository(app)
    private val settingsRepo = SettingsRepository(app)
    private val cloudRepo = CloudSessionRepository(app)
    private val vault = BitwardenVault()
    private val cloud = CloudClient()

    private val clients = HashMap<String, SshClient>()
    private val collectors = HashMap<String, StatusParser.CollectorState>()
    private var pollJob: Job? = null
    private var cloudPushJob: Job? = null

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
            }
        }
        viewModelScope.launch {
            cloudRepo.session.collect { session -> _ui.update { it.copy(cloudSession = session) } }
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
        scheduleCloudAutoPush()
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
        scheduleCloudAutoPush()
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

    fun testVault() = viewModelScope.launch {
        setMessage("Testing vault…")
        try {
            setMessage(vault.test())
        } catch (e: Exception) {
            setMessage("Vault test failed: ${e.message}")
        }
    }

    // --- Cloud sync -------------------------------------------------------

    /** Bitwarden API key is a secret; never upload it. */
    private fun buildPayload(): SyncPayload {
        val s = _ui.value.settings
        return SyncPayload(
            servers = _ui.value.servers.map { it.strippingSecrets() },
            settings = s.copy(bitwarden = s.bitwarden.copy(clientId = "", clientSecret = "")),
        )
    }

    fun cloudAuthenticate(register: Boolean, email: String, password: String) = viewModelScope.launch {
        val url = _ui.value.settings.cloud.url
        try {
            val res = if (register) cloud.register(url, email, password) else cloud.login(url, email, password)
            cloudRepo.save(CloudSession(token = res.token, expiresAt = res.expiresAt, user = res.user))
            val s = _ui.value.settings
            updateSettings(s.copy(cloud = s.cloud.copy(email = res.user.email)))
            setMessage(if (register) "Account created." else "Signed in.")
        } catch (e: Exception) {
            setMessage(cloudError(e))
        }
    }

    fun cloudPush() = viewModelScope.launch { cloudPushInternal(showMessage = true) }

    private suspend fun cloudPushInternal(showMessage: Boolean) {
        val session = _ui.value.cloudSession
        if (session == null || !session.isValid) {
            if (showMessage) setMessage("Sign in to ServerCase Cloud first.")
            return
        }
        try {
            val res = cloud.putSync(_ui.value.settings.cloud.url, session.token, buildPayload(), session.syncVersion)
            cloudRepo.save(session.copy(syncVersion = res.version, syncedAt = res.updatedAt))
            if (showMessage) setMessage("Pushed to cloud (revision ${res.version}).")
        } catch (e: Exception) {
            if (showMessage) setMessage(cloudError(e))
        }
    }

    fun cloudPull() = viewModelScope.launch {
        val session = _ui.value.cloudSession
        if (session == null || !session.isValid) {
            setMessage("Sign in to ServerCase Cloud first.")
            return@launch
        }
        try {
            val res = cloud.getSync(_ui.value.settings.cloud.url, session.token)
            repo.save(res.payload.servers)
            settingsRepo.save(res.payload.settings)
            cloudRepo.save(session.copy(syncVersion = res.version, syncedAt = res.updatedAt))
            setMessage("Pulled from cloud.")
        } catch (e: Exception) {
            setMessage(cloudError(e))
        }
    }

    fun cloudSignOut() = viewModelScope.launch { cloudRepo.save(null) }

    /** Debounced auto-push after local changes, when enabled and signed in. */
    private fun scheduleCloudAutoPush() {
        val cloudSettings = _ui.value.settings.cloud
        val session = _ui.value.cloudSession
        if (!cloudSettings.enabled || !cloudSettings.autoPush || session?.isValid != true) return
        cloudPushJob?.cancel()
        cloudPushJob = viewModelScope.launch {
            delay(2_000L)
            cloudPushInternal(showMessage = false)
        }
    }

    private fun cloudError(e: Exception): String =
        if (e is CloudException && e.status == 409) {
            "The cloud copy changed since your last sync. Pull first, then push."
        } else {
            e.message ?: "Cloud request failed"
        }

    override fun onCleared() {
        clients.values.forEach { it.disconnect() }
        clients.clear()
    }
}

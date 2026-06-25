package com.servercase.app.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.servercase.app.data.ConnectionState
import com.servercase.app.data.ServerConfig
import com.servercase.app.data.ServerRepository
import com.servercase.app.data.ServerStatus
import com.servercase.app.data.StatusParser
import com.servercase.app.data.ssh.SshClient
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
)

class ServersViewModel(app: Application) : AndroidViewModel(app) {

    private val repo = ServerRepository(app)
    private val clients = HashMap<String, SshClient>()
    private val collectors = HashMap<String, StatusParser.CollectorState>()
    private var pollJob: Job? = null

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    init {
        viewModelScope.launch {
            repo.servers.collect { list -> _ui.update { it.copy(servers = list) } }
        }
    }

    // --- CRUD -------------------------------------------------------------
    fun upsert(server: ServerConfig) = viewModelScope.launch {
        val list = _ui.value.servers.toMutableList()
        val idx = list.indexOfFirst { it.id == server.id }
        if (idx >= 0) list[idx] = server else list += server
        repo.save(list)
    }

    fun delete(id: String) = viewModelScope.launch {
        disconnect(id)
        repo.save(_ui.value.servers.filterNot { it.id == id })
    }

    // --- Connection -------------------------------------------------------
    fun connect(server: ServerConfig) = viewModelScope.launch {
        setState(server.id, ConnectionState.CONNECTING)
        val client = SshClient(server)
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

    override fun onCleared() {
        clients.values.forEach { it.disconnect() }
        clients.clear()
    }
}

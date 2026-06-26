package com.servercase.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.servercase.app.data.ConnectionState
import com.servercase.app.data.ServerConfig
import com.servercase.app.ui.theme.Danger
import com.servercase.app.ui.theme.Good
import com.servercase.app.ui.theme.Warn
import com.servercase.app.vm.UiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerListScreen(
    state: UiState,
    onAdd: () -> Unit,
    onOpen: (ServerConfig) -> Unit,
    onEdit: (ServerConfig) -> Unit,
    onDelete: (ServerConfig) -> Unit,
    onOpenSettings: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("ServerCase") },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onAdd) {
                Icon(Icons.Default.Add, contentDescription = "Add server")
            }
        },
    ) { padding ->
        var query by remember { mutableStateOf("") }

        Column(Modifier.fillMaxSize().padding(padding)) {
            if (state.servers.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "No servers yet. Tap + to add one.",
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                }
                return@Column
            }

            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search servers") },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            )

            val q = query.trim().lowercase()
            val filtered = if (q.isEmpty()) state.servers else state.servers.filter {
                it.name.lowercase().contains(q) ||
                    it.host.lowercase().contains(q) ||
                    it.username.lowercase().contains(q)
            }

            @Composable
            fun row(server: ServerConfig) = ServerRow(
                server = server,
                state = state.connState[server.id] ?: ConnectionState.DISCONNECTED,
                onClick = { onOpen(server) },
                onEdit = { onEdit(server) },
                onDelete = { onDelete(server) },
            )

            if (filtered.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "No servers match \"$query\".",
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                }
                return@Column
            }

            val showGroups = state.settings.groups.isNotEmpty()
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
                if (showGroups) {
                    state.settings.groups.forEach { group ->
                        val groupServers = filtered.filter { it.groupId == group.id }
                        if (groupServers.isNotEmpty()) {
                            item(key = "h_${group.id}") { GroupHeader(group.name) }
                            items(groupServers, key = { it.id }) { server -> row(server) }
                        }
                    }
                    val ungrouped = filtered.filter { s ->
                        s.groupId == null || state.settings.groups.none { it.id == s.groupId }
                    }
                    if (ungrouped.isNotEmpty()) {
                        item(key = "h_ungrouped") { GroupHeader("Ungrouped") }
                        items(ungrouped, key = { it.id }) { server -> row(server) }
                    }
                } else {
                    items(filtered, key = { it.id }) { server -> row(server) }
                }
            }
        }
    }
}

@Composable
private fun ServerRow(
    server: ServerConfig,
    state: ConnectionState,
    onClick: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(Modifier.fillMaxWidth().padding(vertical = 6.dp).clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(state)
            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                Text(server.name, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
                Text(
                    "${server.username}@${server.host}:${server.port} · ${state.label()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
            IconButton(onClick = onEdit) { Icon(Icons.Default.Edit, contentDescription = "Edit") }
            IconButton(onClick = onDelete) { Icon(Icons.Default.Delete, contentDescription = "Delete") }
        }
    }
}

@Composable
private fun StatusDot(state: ConnectionState) {
    val color = when (state) {
        ConnectionState.CONNECTED -> Good
        ConnectionState.CONNECTING -> Warn
        ConnectionState.ERROR -> Danger
        ConnectionState.DISCONNECTED -> Color.Gray
    }
    Canvas(Modifier.size(10.dp)) { drawCircle(color) }
}

private fun ConnectionState.label(): String = when (this) {
    ConnectionState.CONNECTED -> "Connected"
    ConnectionState.CONNECTING -> "Connecting…"
    ConnectionState.ERROR -> "Error"
    ConnectionState.DISCONNECTED -> "Offline"
}

@Composable
private fun GroupHeader(name: String) {
    Text(
        name.uppercase(),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, top = 12.dp, bottom = 4.dp),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
    )
}

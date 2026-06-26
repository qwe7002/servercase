package com.servercase.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import com.servercase.app.data.BitwardenSettings
import com.servercase.app.data.GlobalSettings
import com.servercase.app.data.Snippet
import com.servercase.app.data.bitwarden.BitwardenLockState
import com.servercase.app.vm.UiState
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: UiState,
    onBack: () -> Unit,
    onUpdateSettings: (GlobalSettings) -> Unit,
    onRefreshBitwarden: () -> Unit,
    onUnlock: (String) -> Unit,
    onLock: () -> Unit,
    onPushAll: () -> Unit,
    onSyncNow: () -> Unit,
    onExport: (Uri) -> Unit,
    onImport: (Uri) -> Unit,
) {
    val settings = state.settings

    LaunchedEffect(Unit) { onRefreshBitwarden() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            BitwardenSection(state, onUpdateSettings, onUnlock, onLock, onPushAll, onRefreshBitwarden)
            SnippetsSection(settings, onUpdateSettings)
            AutoSyncSection(settings, onUpdateSettings, onSyncNow, onExport, onImport)
            state.settingsMessage?.let {
                Text(it, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun BitwardenSection(
    state: UiState,
    onUpdate: (GlobalSettings) -> Unit,
    onUnlock: (String) -> Unit,
    onLock: () -> Unit,
    onPushAll: () -> Unit,
    onRefresh: () -> Unit,
) {
    val settings = state.settings
    val bw = settings.bitwarden
    var master by remember { mutableStateOf("") }

    SectionCard("Keychain (Bitwarden)") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Store credentials in Bitwarden", Modifier.weight(1f))
            Switch(checked = bw.enabled, onCheckedChange = {
                onUpdate(settings.copy(bitwarden = bw.copy(enabled = it)))
            })
        }
        Text(
            "Usernames, passwords and SSH keys are kept in your Bitwarden vault via a bw serve bridge and sync end-to-end. When off, secrets stay on this device and are never written to the sync file.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )

        if (bw.enabled) {
            OutlinedTextField(
                value = bw.serverUrl,
                onValueChange = { onUpdate(settings.copy(bitwarden = bw.copy(serverUrl = it))) },
                label = { Text("bw serve URL (http://host:8087)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = bw.itemPrefix,
                onValueChange = { onUpdate(settings.copy(bitwarden = bw.copy(itemPrefix = it))) },
                label = { Text("Item name prefix") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            val status = state.bitwardenStatus
            Text(
                "Vault: " + when {
                    status == null -> "checking…"
                    !status.available -> "unreachable"
                    else -> status.state.name.lowercase() +
                        (status.userEmail?.let { " · $it" } ?: "")
                },
                style = MaterialTheme.typography.bodySmall,
            )

            if (status != null && status.available) {
                when (status.state) {
                    BitwardenLockState.UNAUTHENTICATED -> Text(
                        "Not logged in. Run `bw login` then `bw serve` on a trusted host.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                    BitwardenLockState.LOCKED -> {
                        OutlinedTextField(
                            value = master,
                            onValueChange = { master = it },
                            label = { Text("Master password") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Button(onClick = { onUnlock(master); master = "" }, enabled = master.isNotEmpty()) {
                            Text("Unlock")
                        }
                    }
                    BitwardenLockState.UNLOCKED -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = onPushAll) { Text("Push all secrets") }
                        OutlinedButton(onClick = onLock) { Text("Lock") }
                    }
                }
            }
            TextButton(onClick = onRefresh) { Text("Refresh status") }
        }
    }
}

@Composable
private fun SnippetsSection(settings: GlobalSettings, onUpdate: (GlobalSettings) -> Unit) {
    var editing by remember { mutableStateOf<Snippet?>(null) }
    var adding by remember { mutableStateOf(false) }

    SectionCard("Snippets") {
        Text(
            "Reusable commands you can run in any server's terminal.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        settings.snippets.forEach { snippet ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    TextButton(onClick = { editing = snippet }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Column {
                            Text(snippet.name, fontWeight = FontWeight.Medium)
                            Text(snippet.command, fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                        }
                    }
                }
                IconButton(onClick = {
                    onUpdate(settings.copy(snippets = settings.snippets.filterNot { it.id == snippet.id }))
                }) { Icon(Icons.Default.Delete, contentDescription = "Delete") }
            }
        }
        OutlinedButton(onClick = { adding = true }) { Text("Add snippet") }
    }

    if (adding) {
        SnippetDialog(null, onDismiss = { adding = false }) { snippet ->
            onUpdate(settings.copy(snippets = settings.snippets + snippet))
            adding = false
        }
    }
    editing?.let { current ->
        SnippetDialog(current, onDismiss = { editing = null }) { updated ->
            onUpdate(settings.copy(snippets = settings.snippets.map { if (it.id == updated.id) updated else it }))
            editing = null
        }
    }
}

@Composable
private fun SnippetDialog(existing: Snippet?, onDismiss: () -> Unit, onSave: (Snippet) -> Unit) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var command by remember { mutableStateOf(existing?.command ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (existing == null) "Add snippet" else "Edit snippet") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it },
                    label = { Text("Name") }, singleLine = true)
                OutlinedTextField(value = command, onValueChange = { command = it },
                    label = { Text("Command") }, textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onSave(Snippet(id = existing?.id ?: java.util.UUID.randomUUID().toString(),
                        name = name.trim(), command = command.trim()))
                },
                enabled = name.isNotBlank() && command.isNotBlank(),
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun AutoSyncSection(
    settings: GlobalSettings,
    onUpdate: (GlobalSettings) -> Unit,
    onSyncNow: () -> Unit,
    onExport: (Uri) -> Unit,
    onImport: (Uri) -> Unit,
) {
    val sync = settings.autoSync
    val exportLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/json")
    ) { uri -> uri?.let(onExport) }
    val importLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri -> uri?.let(onImport) }

    SectionCard("Auto-sync") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Automatic config sync", Modifier.weight(1f))
            Switch(checked = sync.enabled, onCheckedChange = {
                onUpdate(settings.copy(autoSync = sync.copy(enabled = it)))
            })
        }
        Text(
            "Writes the server list and settings to a JSON file. Secrets are excluded — they sync through Bitwarden.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        OutlinedTextField(
            value = sync.intervalMinutes.toString(),
            onValueChange = {
                val n = it.toIntOrNull() ?: 1
                onUpdate(settings.copy(autoSync = sync.copy(intervalMinutes = n.coerceAtLeast(1))))
            },
            label = { Text("Interval (minutes)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onSyncNow) { Text("Sync now") }
            OutlinedButton(onClick = { exportLauncher.launch("servercase-sync.json") }) { Text("Export…") }
            OutlinedButton(onClick = { importLauncher.launch(arrayOf("application/json")) }) { Text("Import…") }
        }
        sync.lastSyncedAt?.let {
            Text("Last synced ${DateFormat.getDateTimeInstance().format(Date(it))}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
    }
}

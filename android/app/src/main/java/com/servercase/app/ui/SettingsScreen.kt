package com.servercase.app.ui

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
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import com.servercase.app.data.ServerGroup
import com.servercase.app.data.Snippet
import com.servercase.app.data.TerminalColorScheme
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
    onTest: () -> Unit,
    onCloudAuthenticate: (Boolean, String, String) -> Unit,
    onCloudPush: () -> Unit,
    onCloudPull: () -> Unit,
    onCloudSignOut: () -> Unit,
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
            BitwardenSection(state, onUpdateSettings, onUnlock, onLock, onPushAll, onTest, onRefreshBitwarden)
            GroupsSection(settings, onUpdateSettings)
            SnippetsSection(settings, onUpdateSettings)
            CloudSection(state, onUpdateSettings, onCloudAuthenticate, onCloudPush, onCloudPull, onCloudSignOut)
            TerminalSection(settings, onUpdateSettings)
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
    onTest: () -> Unit,
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
            "Usernames, passwords and SSH keys are kept in your Bitwarden vault, reached directly over the Bitwarden API (no bw CLI). The master password unlocks the vault locally and is never stored. When off, secrets stay on-device and are never written to the sync file.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )

        if (bw.enabled) {
            OutlinedTextField(
                value = bw.serverUrl,
                onValueChange = { onUpdate(settings.copy(bitwarden = bw.copy(serverUrl = it))) },
                label = { Text("Server URL (blank = bitwarden.com)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = bw.email,
                onValueChange = { onUpdate(settings.copy(bitwarden = bw.copy(email = it))) },
                label = { Text("Account email") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = bw.clientId,
                onValueChange = { onUpdate(settings.copy(bitwarden = bw.copy(clientId = it))) },
                label = { Text("API key client_id") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = bw.clientSecret,
                onValueChange = { onUpdate(settings.copy(bitwarden = bw.copy(clientSecret = it))) },
                label = { Text("API key client_secret") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
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
                    !status.available -> "not configured"
                    else -> status.state.name.lowercase() +
                        (status.userEmail?.let { " · $it" } ?: "")
                },
                style = MaterialTheme.typography.bodySmall,
            )

            if (status != null && status.available) {
                when (status.state) {
                    BitwardenLockState.UNAUTHENTICATED -> Text(
                        "Enter your account email and a personal API key (web vault → Security → Keys → API Key).",
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
                        OutlinedButton(onClick = onTest) { Text("Test") }
                        OutlinedButton(onClick = onPushAll) { Text("Push all") }
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
private fun TerminalSection(settings: GlobalSettings, onUpdate: (GlobalSettings) -> Unit) {
    val t = settings.terminal
    SectionCard("Terminal") {
        Text(
            "Applies to the SSH terminal on every server, and syncs across your devices through Cloud.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        OutlinedTextField(
            value = t.fontSize.toString(),
            onValueChange = {
                val n = it.toIntOrNull() ?: 13
                onUpdate(settings.copy(terminal = t.copy(fontSize = n.coerceIn(8, 32))))
            },
            label = { Text("Font size") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        OutlinedTextField(
            value = t.scrollback.toString(),
            onValueChange = {
                val n = it.toIntOrNull() ?: 1000
                onUpdate(settings.copy(terminal = t.copy(scrollback = n.coerceIn(100, 100_000))))
            },
            label = { Text("Scrollback (lines)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        Text("Color scheme", style = MaterialTheme.typography.labelMedium)
        val schemes = TerminalColorScheme.entries
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            schemes.forEachIndexed { i, scheme ->
                SegmentedButton(
                    selected = t.colorScheme == scheme,
                    onClick = { onUpdate(settings.copy(terminal = t.copy(colorScheme = scheme))) },
                    shape = SegmentedButtonDefaults.itemShape(i, schemes.size),
                ) {
                    Text(scheme.name.lowercase().replaceFirstChar { it.uppercase() })
                }
            }
        }
    }
}

@Composable
private fun GroupsSection(settings: GlobalSettings, onUpdate: (GlobalSettings) -> Unit) {
    SectionCard("Groups") {
        Text(
            "Assign servers to a group from the server form. Deleting a group leaves its servers ungrouped.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )
        settings.groups.forEach { group ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = group.name,
                    onValueChange = { name ->
                        onUpdate(settings.copy(groups = settings.groups.map {
                            if (it.id == group.id) it.copy(name = name) else it
                        }))
                    },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = {
                    onUpdate(settings.copy(groups = settings.groups.filterNot { it.id == group.id }))
                }) { Icon(Icons.Default.Delete, contentDescription = "Delete") }
            }
        }
        OutlinedButton(onClick = {
            onUpdate(settings.copy(groups = settings.groups + ServerGroup(name = "New group")))
        }) { Text("Add group") }
    }
}

@Composable
private fun CloudSection(
    state: UiState,
    onUpdate: (GlobalSettings) -> Unit,
    onAuthenticate: (Boolean, String, String) -> Unit,
    onPush: () -> Unit,
    onPull: () -> Unit,
    onSignOut: () -> Unit,
) {
    val settings = state.settings
    val cloud = settings.cloud
    val session = state.cloudSession
    val signedIn = session != null && session.isValid
    var email by remember { mutableStateOf(cloud.email) }
    var password by remember { mutableStateOf("") }

    SectionCard("Cloud") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("ServerCase Cloud", Modifier.weight(1f))
            Switch(checked = cloud.enabled, onCheckedChange = {
                onUpdate(settings.copy(cloud = cloud.copy(enabled = it)))
            })
        }
        Text(
            "Sync your server list and settings to a ServerCase Worker. Secrets are never uploaded — they sync through Bitwarden — and your session token stays on this device.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
        )

        if (cloud.enabled) {
            OutlinedTextField(
                value = cloud.url,
                onValueChange = { onUpdate(settings.copy(cloud = cloud.copy(url = it))) },
                label = { Text("Worker URL") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )

            if (signedIn) {
                Text(
                    "Signed in as ${session.user.email}",
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onPush) { Text("Push") }
                    OutlinedButton(onClick = onPull) { Text("Pull") }
                    OutlinedButton(onClick = onSignOut) { Text("Sign out") }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Auto-push on changes", Modifier.weight(1f))
                    Switch(checked = cloud.autoPush, onCheckedChange = {
                        onUpdate(settings.copy(cloud = cloud.copy(autoPush = it)))
                    })
                }
                session.syncedAt?.let {
                    Text(
                        "Last synced ${DateFormat.getDateTimeInstance().format(Date(it))} · revision ${session.syncVersion ?: 0}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                }
            } else {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { onAuthenticate(false, email.trim(), password) },
                        enabled = cloud.url.isNotBlank() && email.isNotBlank() && password.isNotEmpty(),
                    ) { Text("Sign in") }
                    OutlinedButton(
                        onClick = { onAuthenticate(true, email.trim(), password) },
                        enabled = cloud.url.isNotBlank() && email.isNotBlank() && password.length >= 8,
                    ) { Text("Create account") }
                }
            }
        }
    }
}

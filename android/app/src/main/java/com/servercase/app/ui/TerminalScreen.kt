package com.servercase.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.servercase.app.data.Snippet
import com.servercase.app.data.TerminalSettings
import com.servercase.app.data.ssh.SshClient
import kotlinx.coroutines.flow.Flow
import java.util.UUID

private val ANSI = Regex("\\[[0-9;?]*[ -/]*[@-~]")

/** Parses a 6-digit RGB hex string (e.g. "0b0d12") into a Compose Color. */
private fun colorFromHex(hex: String): Color = Color(android.graphics.Color.parseColor("#$hex"))

/** One terminal tab: its own SSH shell channel and accumulated output. */
private class TerminalTab {
    val id: String = UUID.randomUUID().toString()
    var handle by mutableStateOf<SshClient.ShellHandle?>(null)
    var flow by mutableStateOf<Flow<String>?>(null)
    var output by mutableStateOf("")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    client: SshClient?,
    snippets: List<Snippet> = emptyList(),
    terminal: TerminalSettings = TerminalSettings(),
    onBack: () -> Unit,
) {
    val tabs = remember { mutableStateListOf(TerminalTab()) }
    var activeId by remember { mutableStateOf(tabs.first().id) }
    var input by remember { mutableStateOf("") }
    var snippetMenu by remember { mutableStateOf(false) }
    val scroll = rememberScrollState()

    val maxChars = (terminal.scrollback * 200).coerceAtLeast(4_000)
    val background = colorFromHex(terminal.colorScheme.backgroundHex)
    val foreground = colorFromHex(terminal.colorScheme.foregroundHex)

    // Drive every tab (even hidden ones) so background shells stay alive.
    tabs.forEach { tab -> key(tab.id) { TerminalTabDriver(tab, client, maxChars) } }

    val active = tabs.firstOrNull { it.id == activeId } ?: tabs.first()
    LaunchedEffect(active.output) { scroll.scrollTo(scroll.maxValue) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Terminal") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (snippets.isNotEmpty()) {
                        IconButton(onClick = { snippetMenu = true }) {
                            Icon(Icons.Default.Code, contentDescription = "Snippets")
                        }
                        DropdownMenu(expanded = snippetMenu, onDismissRequest = { snippetMenu = false }) {
                            snippets.forEach { snippet ->
                                DropdownMenuItem(
                                    text = { Text(snippet.name) },
                                    onClick = {
                                        snippetMenu = false
                                        active.handle?.write(snippet.command + "\n")
                                    },
                                )
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            TerminalTabBar(
                tabIds = tabs.map { it.id },
                activeId = activeId,
                onSelect = { activeId = it },
                onClose = { id ->
                    val idx = tabs.indexOfFirst { it.id == id }
                    if (tabs.size > 1 && idx >= 0) {
                        tabs.removeAt(idx)
                        if (activeId == id) activeId = tabs[maxOf(0, idx - 1)].id
                    }
                },
                onAdd = {
                    val tab = TerminalTab()
                    tabs.add(tab)
                    activeId = tab.id
                },
            )
            Text(
                text = active.output,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .background(background)
                    .verticalScroll(scroll)
                    .padding(12.dp),
                fontFamily = FontFamily.Monospace,
                fontSize = terminal.fontSize.sp,
                color = foreground,
            )
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("command") },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        active.handle?.write(input + "\n"); input = ""
                    }),
                )
                IconButton(onClick = { active.handle?.write(input + "\n"); input = "" }) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                }
            }
        }
    }
}

/** Opens the tab's shell (kept open while composed) and streams its output. */
@Composable
private fun TerminalTabDriver(tab: TerminalTab, client: SshClient?, maxChars: Int) {
    DisposableEffect(Unit) {
        if (client != null && client.isConnected && tab.handle == null) {
            val (handle, flow) = client.openShell(cols = 120, rows = 32)
            tab.handle = handle
            tab.flow = flow
        }
        onDispose { tab.handle?.close() }
    }
    val flow = tab.flow
    LaunchedEffect(flow) {
        flow?.collect { chunk ->
            // Keep roughly `scrollback` lines; strip ANSI control sequences.
            tab.output = (tab.output + chunk.replace(ANSI, "")).takeLast(maxChars)
        }
    }
}

@Composable
private fun TerminalTabBar(
    tabIds: List<String>,
    activeId: String,
    onSelect: (String) -> Unit,
    onClose: (String) -> Unit,
    onAdd: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        tabIds.forEachIndexed { index, id ->
            val selected = id == activeId
            Row(
                Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(
                        if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent
                    )
                    .clickable { onSelect(id) }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("${index + 1}", style = MaterialTheme.typography.labelLarge)
                if (tabIds.size > 1) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = "Close tab",
                        modifier = Modifier.size(16.dp).clickable { onClose(id) },
                    )
                }
            }
        }
        IconButton(onClick = onAdd) {
            Icon(Icons.Default.Add, contentDescription = "New tab")
        }
    }
}

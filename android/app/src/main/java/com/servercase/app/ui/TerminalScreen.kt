package com.servercase.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Code
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.background
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.servercase.app.data.Snippet
import com.servercase.app.data.TerminalSettings
import com.servercase.app.data.ssh.SshClient
import kotlinx.coroutines.flow.Flow

/** Parses a 6-digit RGB hex string (e.g. "0b0d12") into a Compose Color. */
private fun colorFromHex(hex: String): Color = Color(android.graphics.Color.parseColor("#$hex"))

private val ANSI = Regex("\\[[0-9;?]*[ -/]*[@-~]")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    client: SshClient?,
    snippets: List<Snippet> = emptyList(),
    terminal: TerminalSettings = TerminalSettings(),
    onBack: () -> Unit,
) {
    var output by remember { mutableStateOf("") }
    var input by remember { mutableStateOf("") }
    var snippetMenu by remember { mutableStateOf(false) }
    val scroll = rememberScrollState()
    val maxChars = (terminal.scrollback * 200).coerceAtLeast(4_000)
    val background = colorFromHex(terminal.colorScheme.backgroundHex)
    val foreground = colorFromHex(terminal.colorScheme.foregroundHex)

    var handle by remember { mutableStateOf<SshClient.ShellHandle?>(null) }
    var flow by remember { mutableStateOf<Flow<String>?>(null) }

    DisposableEffect(client) {
        if (client != null && client.isConnected) {
            val (shellHandle, shellFlow) = client.openShell(cols = 120, rows = 32)
            handle = shellHandle
            flow = shellFlow
        }
        onDispose { handle?.close() }
    }

    LaunchedEffect(flow) {
        flow?.collect { chunk ->
            // Keep roughly `scrollback` lines; strip ANSI control sequences.
            output = (output + chunk.replace(ANSI, "")).takeLast(maxChars)
        }
    }

    LaunchedEffect(output) { scroll.scrollTo(scroll.maxValue) }

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
                                        handle?.write(snippet.command + "\n")
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
            Text(
                text = output,
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
                        handle?.write(input + "\n"); input = ""
                    }),
                )
                IconButton(onClick = { handle?.write(input + "\n"); input = "" }) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                }
            }
        }
    }
}

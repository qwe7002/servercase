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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.servercase.app.data.ssh.SshClient
import kotlinx.coroutines.flow.Flow

private val ANSI = Regex("\\[[0-9;?]*[ -/]*[@-~]")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(client: SshClient?, onBack: () -> Unit) {
    var output by remember { mutableStateOf("") }
    var input by remember { mutableStateOf("") }
    val scroll = rememberScrollState()

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
            // Keep the last ~40k chars; strip ANSI control sequences for display.
            output = (output + chunk.replace(ANSI, "")).takeLast(40_000)
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
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            Text(
                text = output,
                modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(12.dp),
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = Color(0xFFD6DBE5),
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

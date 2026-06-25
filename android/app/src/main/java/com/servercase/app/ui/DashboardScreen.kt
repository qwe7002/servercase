package com.servercase.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.servercase.app.data.ConnectionState
import com.servercase.app.data.ServerConfig
import com.servercase.app.data.ServerStatus
import com.servercase.app.ui.components.Gauge
import com.servercase.app.ui.components.UsageBar
import com.servercase.app.ui.theme.Danger

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun DashboardScreen(
    server: ServerConfig,
    state: ConnectionState,
    status: ServerStatus?,
    error: String?,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onOpenTerminal: () -> Unit,
    onStartPolling: () -> Unit,
    onStopPolling: () -> Unit,
    onBack: () -> Unit,
) {
    DisposableEffect(server.id) {
        onStartPolling()
        onDispose { onStopPolling() }
    }

    val connected = state == ConnectionState.CONNECTED

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(server.name)
                        Text(
                            "${server.username}@${server.host}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (connected) TextButton(onClick = onDisconnect) { Text("Disconnect") }
                    else TextButton(onClick = onConnect, enabled = state != ConnectionState.CONNECTING) {
                        Text(if (state == ConnectionState.CONNECTING) "Connecting…" else "Connect")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (state == ConnectionState.ERROR && error != null) {
                Card { Text("Connection failed: $error", color = Danger, modifier = Modifier.padding(12.dp)) }
            }

            when {
                !connected -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
                    Text(
                        if (state == ConnectionState.CONNECTING) "Establishing SSH connection…"
                        else "Not connected. Tap Connect for live status.",
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    )
                }

                status == null -> Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
                    Text("Collecting status…", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                }

                else -> {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Gauge("CPU", status.cpuUsage, "load %.2f".format(status.loadAvg.first))
                        Gauge("Memory", status.memPercent, "${Format.kb(status.memUsedKb)} / ${Format.kb(status.memTotalKb)}")
                    }

                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp)) {
                            KvRow("Uptime", Format.uptime(status.uptimeSec))
                            KvRow("Network", "↓ ${Format.rate(status.netRxBytesPerSec)}   ↑ ${Format.rate(status.netTxBytesPerSec)}")
                            KvRow("Kernel", status.kernel.ifBlank { "–" })
                            KvRow("Host", status.hostname.ifBlank { "–" })
                        }
                    }

                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp)) {
                            Text("Memory", fontWeight = FontWeight.SemiBold)
                            UsageBar("RAM", "${Format.kb(status.memUsedKb)} / ${Format.kb(status.memTotalKb)}", status.memPercent)
                            if (status.swapTotalKb > 0) {
                                UsageBar("Swap", "${Format.kb(status.swapUsedKb)} / ${Format.kb(status.swapTotalKb)}", status.swapPercent)
                            }
                        }
                    }

                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp)) {
                            Text("Disks", fontWeight = FontWeight.SemiBold)
                            if (status.disks.isEmpty()) {
                                Text("No mounts reported.", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                            }
                            status.disks.forEach { d ->
                                UsageBar("${d.mount} (${d.fs})", "${Format.kb(d.usedKb)} / ${Format.kb(d.totalKb)}", d.percent)
                            }
                        }
                    }

                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedButton(onClick = onOpenTerminal, modifier = Modifier.weight(1f)) { Text("Open terminal") }
                        Button(onClick = onDisconnect, modifier = Modifier.weight(1f)) { Text("Disconnect") }
                    }
                }
            }
        }
    }
}

@Composable
private fun KvRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        Text(value, fontWeight = FontWeight.Medium)
    }
}

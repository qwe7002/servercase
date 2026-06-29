package com.servercase.app

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.google.firebase.messaging.FirebaseMessaging
import com.servercase.app.data.ConnectionState
import com.servercase.app.ui.DashboardScreen
import com.servercase.app.ui.FilesScreen
import com.servercase.app.ui.ServerFormScreen
import com.servercase.app.ui.ServerListScreen
import com.servercase.app.ui.SettingsScreen
import com.servercase.app.ui.TerminalScreen
import com.servercase.app.ui.theme.ServerCaseTheme
import com.servercase.app.vm.ServersViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ServerCaseTheme {
                val vm: ServersViewModel = viewModel()
                val state by vm.ui.collectAsState()
                val nav = rememberNavController()

                val notificationPermission = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission(),
                ) {}
                LaunchedEffect(Unit) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                    // No-op without Firebase config (FirebaseApp won't be initialised).
                    runCatching {
                        FirebaseMessaging.getInstance().token.addOnSuccessListener { vm.onFcmToken(it) }
                    }
                }

                NavHost(navController = nav, startDestination = "list") {
                    composable("list") {
                        ServerListScreen(
                            state = state,
                            onAdd = { nav.navigate("form") },
                            onOpen = { nav.navigate("dashboard/${it.id}") },
                            onReconnect = { vm.reconnect(it) },
                            onEdit = { nav.navigate("form?id=${it.id}") },
                            onDelete = { vm.delete(it.id) },
                            onOpenSettings = { nav.navigate("settings") },
                        )
                    }
                    composable("settings") {
                        SettingsScreen(
                            state = state,
                            onBack = { nav.popBackStack() },
                            onUpdateSettings = { vm.updateSettings(it) },
                            onRefreshBitwarden = { vm.refreshBitwardenStatus() },
                            onUnlock = { vm.unlockVault(it) },
                            onLock = { vm.lockVault() },
                            onPushAll = { vm.pushAllSecretsToVault() },
                            onTest = { vm.testVault() },
                            onCloudAuthenticate = { register, email, password ->
                                vm.cloudAuthenticate(register, email, password)
                            },
                            onCloudPush = { vm.cloudPush() },
                            onCloudPull = { vm.cloudPull() },
                            onCloudSignOut = { vm.cloudSignOut() },
                        )
                    }
                    composable(
                        route = "form?id={id}",
                        arguments = listOf(navArgument("id") { nullable = true; defaultValue = null }),
                    ) { entry ->
                        val id = entry.arguments?.getString("id")
                        ServerFormScreen(
                            existing = id?.let { arg -> state.servers.find { it.id == arg } },
                            groups = state.settings.groups,
                            onSave = { vm.upsert(it); nav.popBackStack() },
                            onBack = { nav.popBackStack() },
                        )
                    }
                    composable("dashboard/{id}") { entry ->
                        val id = entry.arguments?.getString("id") ?: return@composable
                        val server = state.servers.find { it.id == id } ?: return@composable
                        DashboardScreen(
                            server = server,
                            state = state.connState[id] ?: ConnectionState.DISCONNECTED,
                            status = state.status[id],
                            error = state.errors[id],
                            onConnect = { vm.connect(server) },
                            onDisconnect = { vm.disconnect(id) },
                            onOpenTerminal = { nav.navigate("terminal/$id") },
                            onOpenFiles = { nav.navigate("files/$id") },
                            onStartPolling = { vm.startPolling(id) },
                            onStopPolling = { vm.stopPolling() },
                            onBack = { nav.popBackStack() },
                        )
                    }
                    composable("terminal/{id}") { entry ->
                        val id = entry.arguments?.getString("id") ?: return@composable
                        TerminalScreen(
                            client = vm.client(id),
                            snippets = state.settings.snippets,
                            terminal = state.settings.terminal,
                            onBack = { nav.popBackStack() },
                        )
                    }
                    composable("files/{id}") { entry ->
                        val id = entry.arguments?.getString("id") ?: return@composable
                        FilesScreen(client = vm.client(id), onBack = { nav.popBackStack() })
                    }
                }
            }
        }
    }
}

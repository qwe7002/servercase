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
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import com.servercase.app.data.AuthType
import com.servercase.app.data.ServerConfig

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerFormScreen(
    existing: ServerConfig?,
    onSave: (ServerConfig) -> Unit,
    onBack: () -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var host by remember { mutableStateOf(existing?.host ?: "") }
    var port by remember { mutableStateOf((existing?.port ?: 22).toString()) }
    var username by remember { mutableStateOf(existing?.username ?: "root") }
    var authType by remember { mutableStateOf(existing?.authType ?: AuthType.PASSWORD) }
    var password by remember { mutableStateOf(existing?.password ?: "") }
    var privateKey by remember { mutableStateOf(existing?.privateKey ?: "") }
    var passphrase by remember { mutableStateOf(existing?.passphrase ?: "") }

    val canSave = name.isNotBlank() && host.isNotBlank() && username.isNotBlank()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (existing == null) "Add server" else "Edit server") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(host, { host = it }, label = { Text("Host") }, modifier = Modifier.weight(3f))
                OutlinedTextField(
                    port, { port = it.filter(Char::isDigit) },
                    label = { Text("Port") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1f),
                )
            }
            OutlinedTextField(username, { username = it }, label = { Text("Username") }, modifier = Modifier.fillMaxWidth())

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = authType == AuthType.PASSWORD,
                    onClick = { authType = AuthType.PASSWORD },
                    label = { Text("Password") },
                )
                FilterChip(
                    selected = authType == AuthType.KEY,
                    onClick = { authType = AuthType.KEY },
                    label = { Text("Private key") },
                )
            }

            if (authType == AuthType.PASSWORD) {
                OutlinedTextField(
                    password, { password = it },
                    label = { Text("Password") },
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                OutlinedTextField(
                    privateKey, { privateKey = it },
                    label = { Text("Private key (PEM)") },
                    minLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    passphrase, { passphrase = it },
                    label = { Text("Passphrase (optional)") },
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Button(
                onClick = {
                    onSave(
                        (existing ?: ServerConfig(name = name, host = host)).copy(
                            name = name.trim(),
                            host = host.trim(),
                            port = port.toIntOrNull() ?: 22,
                            username = username.trim(),
                            authType = authType,
                            password = if (authType == AuthType.PASSWORD) password else null,
                            privateKey = if (authType == AuthType.KEY) privateKey else null,
                            passphrase = if (authType == AuthType.KEY) passphrase.ifBlank { null } else null,
                        )
                    )
                },
                enabled = canSave,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Save") }
        }
    }
}

package com.servercase.app.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.servercase.app.data.ssh.RemoteFile
import com.servercase.app.data.ssh.RemoteFiles
import com.servercase.app.data.ssh.RemoteListing
import com.servercase.app.data.ssh.SshClient
import com.servercase.app.ui.theme.Warn
import kotlinx.coroutines.launch

private const val MAX_EDIT_BYTES = 512L * 1024

private data class EditingFile(val entry: RemoteFile, val content: String)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(client: SshClient?, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val files = remember(client) { client?.let { RemoteFiles(it) } }

    var path by remember { mutableStateOf(".") }
    var listing by remember { mutableStateOf<RemoteListing?>(null) }
    var loading by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<EditingFile?>(null) }
    var renaming by remember { mutableStateOf<RemoteFile?>(null) }
    var newFolder by remember { mutableStateOf(false) }
    var pendingDownload by remember { mutableStateOf<RemoteFile?>(null) }

    fun load(target: String) {
        val f = files ?: return
        scope.launch {
            loading = true
            runCatching { f.list(target) }
                .onSuccess { listing = it; path = it.path }
                .onFailure { message = it.message }
            loading = false
        }
    }

    LaunchedEffect(client) { if (files != null) load(".") }

    val downloadLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream")
    ) { uri ->
        val entry = pendingDownload
        pendingDownload = null
        if (uri != null && entry != null && files != null) scope.launch {
            runCatching {
                val bytes = files.download(entry)
                context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            }.onSuccess { message = "Saved ${entry.name}" }.onFailure { message = it.message }
        }
    }
    val uploadLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null && files != null) scope.launch {
            runCatching {
                val name = displayName(context, uri) ?: "upload.bin"
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: error("empty file")
                files.upload(bytes, path, name)
            }.onSuccess { message = "Uploaded"; load(path) }.onFailure { message = it.message }
        }
    }

    val current = editing
    if (current != null) {
        EditorView(
            file = current,
            onSave = { content ->
                val f = files ?: return@EditorView
                scope.launch {
                    runCatching { f.writeText(current.entry.path, content) }
                        .onSuccess { message = "Saved ${current.entry.name}"; editing = null }
                        .onFailure { message = it.message }
                }
            },
            onClose = { editing = null },
        )
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Files") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { newFolder = true }) {
                        Icon(Icons.Default.CreateNewFolder, contentDescription = "New folder")
                    }
                    IconButton(onClick = { uploadLauncher.launch(arrayOf("*/*")) }) {
                        Icon(Icons.Default.Upload, contentDescription = "Upload")
                    }
                    IconButton(onClick = { load(path) }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = {
                    val parent = (listing?.path ?: path).trimEnd('/').substringBeforeLast('/', "")
                    load(if (parent.isEmpty()) "/" else parent)
                }) { Icon(Icons.Default.ArrowUpward, contentDescription = "Up") }
                Text(
                    listing?.path ?: path,
                    fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
            }

            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                items(listing?.entries ?: emptyList(), key = { it.path }) { entry ->
                    FileRow(
                        entry = entry,
                        onOpen = {
                            if (entry.isDirectory) load(entry.path)
                            else if (entry.sizeBytes <= MAX_EDIT_BYTES) {
                                val f = files ?: return@FileRow
                                scope.launch {
                                    runCatching { f.readText(entry.path) }
                                        .onSuccess { editing = EditingFile(entry, it) }
                                        .onFailure { message = it.message }
                                }
                            } else message = "${entry.name} is too large to edit — use Save."
                        },
                        onRename = { renaming = entry },
                        onDelete = {
                            val f = files ?: return@FileRow
                            scope.launch {
                                runCatching { f.remove(entry.path, entry.isDirectory) }
                                    .onSuccess { load(path) }.onFailure { message = it.message }
                            }
                        },
                        onDownload = { pendingDownload = entry; downloadLauncher.launch(entry.name) },
                    )
                }
            }

            if (loading && listing == null) {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    Text("Loading…", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                }
            }
            message?.let {
                Text(it, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            }
        }
    }

    if (newFolder) {
        NameDialog("New folder", "", onDismiss = { newFolder = false }) { name ->
            newFolder = false
            val f = files ?: return@NameDialog
            scope.launch {
                runCatching { f.makeDirectory(f.join(path, name)) }
                    .onSuccess { load(path) }.onFailure { message = it.message }
            }
        }
    }
    renaming?.let { entry ->
        NameDialog("Rename", entry.name, onDismiss = { renaming = null }) { name ->
            renaming = null
            val f = files ?: return@NameDialog
            scope.launch {
                runCatching { f.rename(entry.path, f.join(path, name)) }
                    .onSuccess { load(path) }.onFailure { message = it.message }
            }
        }
    }
}

@Composable
private fun FileRow(
    entry: RemoteFile,
    onOpen: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    onDownload: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (entry.isDirectory) Icons.Default.Folder else Icons.Default.Description,
            contentDescription = null,
            tint = if (entry.isDirectory) Warn else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(entry.name)
            Text(
                detail(entry),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
        }
        Box {
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Default.MoreVert, contentDescription = "Actions")
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (!entry.isDirectory) {
                    DropdownMenuItem(
                        text = { Text("Save to device") },
                        leadingIcon = { Icon(Icons.Default.Download, null) },
                        onClick = { menu = false; onDownload() },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Rename") },
                    leadingIcon = { Icon(Icons.Default.Edit, null) },
                    onClick = { menu = false; onRename() },
                )
                DropdownMenuItem(
                    text = { Text("Delete") },
                    leadingIcon = { Icon(Icons.Default.Delete, null) },
                    onClick = { menu = false; onDelete() },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditorView(file: EditingFile, onSave: (String) -> Unit, onClose: () -> Unit) {
    var content by remember(file.entry.path) { mutableStateOf(file.content) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(file.entry.name) },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Close")
                    }
                },
                actions = { TextButton(onClick = { onSave(content) }) { Text("Save") } },
            )
        },
    ) { padding ->
        OutlinedTextField(
            value = content,
            onValueChange = { content = it },
            modifier = Modifier.fillMaxSize().padding(padding).padding(8.dp),
            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        )
    }
}

@Composable
private fun NameDialog(title: String, initial: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(value = text, onValueChange = { text = it },
                label = { Text("Name") }, singleLine = true)
        },
        confirmButton = {
            TextButton(onClick = { if (text.isNotBlank()) onConfirm(text.trim()) }, enabled = text.isNotBlank()) {
                Text("OK")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private fun detail(entry: RemoteFile): String {
    val when_ = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT)
        .format(java.util.Date(entry.modifiedAt))
    return if (entry.isDirectory) "${entry.mode} · $when_"
    else "${Format.bytes(entry.sizeBytes.toDouble())} · ${entry.mode} · $when_"
}

private fun displayName(context: Context, uri: Uri): String? {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0) return c.getString(idx)
        }
    }
    return uri.lastPathSegment?.substringAfterLast('/')
}

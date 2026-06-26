package com.servercase.app.data.ssh

import java.nio.charset.StandardCharsets
import java.util.Base64

data class RemoteFile(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val isSymlink: Boolean,
    val sizeBytes: Long,
    /** Modification time, epoch ms. */
    val modifiedAt: Long,
    /** Symbolic permission string, e.g. "rwxr-xr-x". */
    val mode: String,
)

data class RemoteListing(val path: String, val entries: List<RemoteFile>)

/**
 * A remote file manager built on plain shell commands over the existing SSH
 * connection — the same "portable command + parse" approach the status
 * collector uses, so it needs nothing on the host beyond coreutils.
 */
class RemoteFiles(private val client: SshClient) {

    suspend fun list(path: String): RemoteListing {
        val out = client.exec("cd ${quote(path)} 2>/dev/null && pwd && ls -lAL --time-style=+%s 2>/dev/null")
        val lines = out.split("\n")
        val abs = lines.firstOrNull()?.trim().orEmpty()
        require(abs.startsWith("/")) { "Cannot open $path" }
        val entries = lines.drop(1)
            .filter { it.isNotBlank() && !it.startsWith("total ") }
            .mapNotNull { parse(it, abs) }
            .sortedWith(compareByDescending<RemoteFile> { it.isDirectory }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        return RemoteListing(abs, entries)
    }

    suspend fun readText(path: String): String = client.exec("cat ${quote(path)}")

    suspend fun writeText(path: String, content: String) {
        val b64 = Base64.getEncoder().encodeToString(content.toByteArray(StandardCharsets.UTF_8))
        client.exec("printf %s ${quote(b64)} | base64 -d > ${quote(path)}")
    }

    suspend fun makeDirectory(path: String) {
        client.exec("mkdir -p ${quote(path)}")
    }

    suspend fun rename(from: String, to: String) {
        client.exec("mv ${quote(from)} ${quote(to)}")
    }

    suspend fun remove(path: String, isDirectory: Boolean) {
        client.exec((if (isDirectory) "rm -r " else "rm -f ") + quote(path))
    }

    /** Downloads a remote file and returns its decoded bytes. */
    suspend fun download(file: RemoteFile): ByteArray {
        val b64 = client.exec("base64 ${quote(file.path)}").replace("\n", "")
        return Base64.getDecoder().decode(b64)
    }

    /** Uploads raw bytes to `dir/name` on the remote host. */
    suspend fun upload(bytes: ByteArray, dir: String, name: String) {
        val b64 = Base64.getEncoder().encodeToString(bytes)
        client.exec("printf %s ${quote(b64)} | base64 -d > ${quote(join(dir, name))}")
    }

    fun join(dir: String, name: String): String {
        val base = dir.trimEnd('/')
        return if (base.isEmpty()) "/$name" else "$base/$name"
    }

    private fun parse(line: String, dir: String): RemoteFile? {
        // perms links owner group size epoch name...
        val parts = line.trim().split(Regex("\\s+"))
        if (parts.size < 7) return null
        val perms = parts[0]
        val size = parts[4].toLongOrNull() ?: 0
        val epoch = parts[5].toLongOrNull() ?: 0
        val name = parts.drop(6).joinToString(" ")
        return RemoteFile(
            name = name,
            path = join(dir, name),
            isDirectory = perms.startsWith("d"),
            isSymlink = perms.startsWith("l"),
            sizeBytes = size,
            modifiedAt = epoch * 1000,
            mode = perms.drop(1),
        )
    }

    private fun quote(s: String): String = "'" + s.replace("'", "'\\''") + "'"
}

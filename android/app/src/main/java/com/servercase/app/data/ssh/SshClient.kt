package com.servercase.app.data.ssh

import com.servercase.app.data.AuthType
import com.servercase.app.data.ServerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.transport.verification.PromiscuousVerifier
import net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile
import net.schmizz.sshj.userauth.password.PasswordUtils
import java.io.OutputStream
import java.nio.charset.StandardCharsets

/**
 * A single SSHJ connection to one server. Use [exec] for the status command and
 * [openShell] for an interactive PTY terminal.
 *
 * Note: host-key verification is promiscuous for now (matching a first-run
 * mobile UX). A production build should pin/confirm host keys instead.
 */
class SshClient(private val config: ServerConfig) {

    private var ssh: SSHClient? = null

    val isConnected: Boolean get() = ssh?.isConnected == true

    suspend fun connect() = withContext(Dispatchers.IO) {
        if (isConnected) return@withContext
        val client = SSHClient().apply {
            addHostKeyVerifier(PromiscuousVerifier())
            connectTimeout = 15_000
            timeout = 15_000
        }
        client.connect(config.host, config.port)
        when (config.authType) {
            AuthType.PASSWORD -> client.authPassword(config.username, config.password ?: "")
            AuthType.KEY -> {
                val keyFile = OpenSSHKeyFile().apply {
                    if (config.passphrase.isNullOrEmpty()) {
                        init(config.privateKey ?: "", null)
                    } else {
                        init(
                            config.privateKey ?: "",
                            null,
                            PasswordUtils.createOneOff(config.passphrase.toCharArray()),
                        )
                    }
                }
                client.authPublickey(config.username, keyFile)
            }
        }
        ssh = client
    }

    /** Run a command to completion and return stdout. */
    suspend fun exec(command: String): String = withContext(Dispatchers.IO) {
        val client = ssh ?: error("not connected")
        client.startSession().use { session ->
            val cmd = session.exec(command)
            val out = cmd.inputStream.readBytes().toString(StandardCharsets.UTF_8)
            cmd.join()
            out
        }
    }

    /**
     * Open an interactive shell. Emits output chunks as a Flow; write user input
     * through the returned [ShellHandle]. The flow closes when the shell ends.
     */
    fun openShell(cols: Int, rows: Int): Pair<ShellHandle, Flow<String>> {
        val client = ssh ?: error("not connected")
        val session = client.startSession()
        session.allocatePTY("xterm-256color", cols, rows, 0, 0, emptyMap())
        val shell = session.startShell()
        val handle = ShellHandle(session, shell.outputStream)

        val flow = callbackFlow {
            val buf = ByteArray(4096)
            val input = shell.inputStream
            try {
                while (isActive) {
                    val n = input.read(buf)
                    if (n < 0) break
                    trySend(String(buf, 0, n, StandardCharsets.UTF_8))
                }
            } finally {
                close()
            }
            awaitClose { runCatching { session.close() } }
        }.flowOn(Dispatchers.IO)
        return handle to flow
    }

    fun disconnect() {
        runCatching { ssh?.disconnect() }
        ssh = null
    }

    class ShellHandle(
        private val session: Session,
        private val stdin: OutputStream,
    ) {
        fun write(data: String) {
            stdin.write(data.toByteArray(StandardCharsets.UTF_8))
            stdin.flush()
        }

        fun close() {
            runCatching { session.close() }
        }
    }
}

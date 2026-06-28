package com.servercase.app.data

import kotlinx.serialization.Serializable
import java.util.UUID

/** A reusable shell command, runnable in any server's terminal. */
@Serializable
data class Snippet(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val command: String,
)

/**
 * Optional connection to a ServerCase Worker for cloud config sync. The session
 * token is not stored here — it lives in [CloudSessionRepository] and is never
 * written to the synced payload. Only the non-secret URL/email/preferences live
 * in settings, so they sync across devices.
 */
@Serializable
data class CloudSettings(
    val enabled: Boolean = false,
    /** Base URL of the worker, e.g. https://worker.example.com */
    val url: String = "",
    /** Account email — display and login convenience (not a secret). */
    val email: String = "",
    /** Push the config to the cloud automatically after local changes. */
    val autoPush: Boolean = false,
)

/**
 * Bitwarden keychain configuration. We speak the Bitwarden REST API directly
 * (clean-room crypto, no `bw` CLI), authenticating with a personal API key.
 */
@Serializable
data class BitwardenSettings(
    val enabled: Boolean = false,
    /** Base URL of the server; empty = cloud. Self-hosted gets /identity + /api. */
    val serverUrl: String = "",
    /** Account email — used as the KDF salt and for prelogin. */
    val email: String = "",
    /** Personal API key client_id ("user.<guid>"). */
    val clientId: String = "",
    /** Personal API key client_secret. Redacted from the sync file. */
    val clientSecret: String = "",
    /** Name prefix for vault items owned by ServerCase. */
    val itemPrefix: String = "ServerCase/",
)

/** A named group/folder used to organize the server list. */
@Serializable
data class ServerGroup(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
)

@Serializable
enum class TerminalCursorStyle { BLOCK, UNDERLINE, BAR }

/** Background/foreground hex shared with the desktop and iOS clients. */
@Serializable
enum class TerminalColorScheme(val backgroundHex: String, val foregroundHex: String) {
    CHARCOAL("0b0d12", "d6dbe5"),
    BLACK("000000", "e5e5e5"),
    LIGHT("f5f5f5", "1c1c1c"),
    SOLARIZED("002b36", "93a1a1"),
}

/** Appearance/behaviour of the SSH terminal, shared across servers and synced. */
@Serializable
data class TerminalSettings(
    val fontSize: Int = 13,
    val cursorBlink: Boolean = true,
    val cursorStyle: TerminalCursorStyle = TerminalCursorStyle.BLOCK,
    val scrollback: Int = 1000,
    val colorScheme: TerminalColorScheme = TerminalColorScheme.CHARCOAL,
)

@Serializable
data class GlobalSettings(
    val bitwarden: BitwardenSettings = BitwardenSettings(),
    val snippets: List<Snippet> = emptyList(),
    val cloud: CloudSettings = CloudSettings(),
    val terminal: TerminalSettings = TerminalSettings(),
    val groups: List<ServerGroup> = emptyList(),
)

/**
 * The login credentials for a server. Stored in Bitwarden when the vault is
 * enabled, otherwise persisted locally with the server definition.
 */
@Serializable
data class ServerSecrets(
    val username: String? = null,
    val password: String? = null,
    val privateKey: String? = null,
    val passphrase: String? = null,
)

/**
 * Snapshot exchanged with the sync file. Secrets are deliberately excluded:
 * with Bitwarden they sync through the vault, and without it they are
 * intentionally not portable.
 */
@Serializable
data class SyncPayload(
    val version: Int = 1,
    val exportedAt: Long = System.currentTimeMillis(),
    val servers: List<ServerConfig>,
    val settings: GlobalSettings,
)

fun ServerConfig.secrets(): ServerSecrets =
    ServerSecrets(username = username, password = password,
                  privateKey = privateKey, passphrase = passphrase)

/** A copy with all sensitive fields cleared, for local persistence / sync. */
fun ServerConfig.strippingSecrets(): ServerConfig =
    copy(password = null, privateKey = null, passphrase = null)

/** A copy with the given vault secrets merged in. */
fun ServerConfig.merging(s: ServerSecrets): ServerConfig =
    copy(
        username = s.username ?: username,
        password = s.password ?: password,
        privateKey = s.privateKey ?: privateKey,
        passphrase = s.passphrase ?: passphrase,
    )

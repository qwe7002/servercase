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

/** Periodic export/import of the configuration to a JSON file. */
@Serializable
data class AutoSyncSettings(
    val enabled: Boolean = false,
    val intervalMinutes: Int = 30,
    /** Epoch ms of the last successful sync. */
    val lastSyncedAt: Long? = null,
)

/**
 * Bitwarden keychain configuration. On Android we talk to the Bitwarden CLI's
 * REST bridge (`bw serve`) over HTTP rather than shelling out to the CLI.
 */
@Serializable
data class BitwardenSettings(
    val enabled: Boolean = false,
    /** Base URL of a running `bw serve`, e.g. http://127.0.0.1:8087 */
    val serverUrl: String = "",
    /** Name prefix for vault items owned by ServerCase. */
    val itemPrefix: String = "ServerCase/",
)

@Serializable
data class GlobalSettings(
    val bitwarden: BitwardenSettings = BitwardenSettings(),
    val snippets: List<Snippet> = emptyList(),
    val autoSync: AutoSyncSettings = AutoSyncSettings(),
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

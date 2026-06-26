package com.servercase.app.data.bitwarden

import com.servercase.app.data.BitwardenSettings
import com.servercase.app.data.ServerSecrets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

enum class BitwardenLockState { UNAUTHENTICATED, LOCKED, UNLOCKED }

data class BitwardenStatus(
    val available: Boolean,
    val state: BitwardenLockState,
    val serverUrl: String? = null,
    val userEmail: String? = null,
    val error: String? = null,
)

/**
 * Talks to a running Bitwarden CLI REST bridge (`bw serve`). The bridge holds
 * the unlocked session server-side, so once unlocked we just issue plain HTTP
 * calls. Each server maps to one vault item named `${prefix}${serverId}`; the
 * full [ServerSecrets] bundle lives in the item's notes, with username and
 * password mirrored into the login fields for use from the Bitwarden apps.
 */
class BitwardenVault {

    @Volatile private var base: String? = null
    @Volatile private var prefix: String = "ServerCase/"
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun configure(settings: BitwardenSettings) {
        base = settings.serverUrl.trim().ifEmpty { null }?.trimEnd('/')
        prefix = settings.itemPrefix
    }

    private fun itemName(serverId: String) = prefix + serverId

    suspend fun status(): BitwardenStatus = withContext(Dispatchers.IO) {
        if (base == null) {
            return@withContext BitwardenStatus(false, BitwardenLockState.UNAUTHENTICATED,
                error = "No bw serve URL configured")
        }
        runCatching {
            val env = json.decodeFromString<BwStatusEnvelope>(request("GET", "/status", null))
            val t = env.data?.template ?: error(env.message ?: "bw status failed")
            val state = when (t.status) {
                "unlocked" -> BitwardenLockState.UNLOCKED
                "locked" -> BitwardenLockState.LOCKED
                else -> BitwardenLockState.UNAUTHENTICATED
            }
            BitwardenStatus(true, state, t.serverUrl, t.userEmail)
        }.getOrElse {
            BitwardenStatus(false, BitwardenLockState.UNAUTHENTICATED, error = it.message)
        }
    }

    suspend fun unlock(masterPassword: String): BitwardenStatus {
        withContext(Dispatchers.IO) {
            call("POST", "/unlock", json.encodeToString(BwUnlockBody(masterPassword)))
            runCatching { call("POST", "/sync", null) }
        }
        return status()
    }

    suspend fun lock() = withContext(Dispatchers.IO) { call("POST", "/lock", null) }

    suspend fun sync() = withContext(Dispatchers.IO) { call("POST", "/sync", null) }

    suspend fun getSecrets(serverId: String): ServerSecrets? = withContext(Dispatchers.IO) {
        findItem(serverId)?.let { decodeSecrets(it) }
    }

    suspend fun listSecrets(): Map<String, ServerSecrets> = withContext(Dispatchers.IO) {
        val env = json.decodeFromString<BwListEnvelope>(
            request("GET", "/list/object/items?search=" + encode(prefix), null)
        )
        val out = HashMap<String, ServerSecrets>()
        env.data?.data.orEmpty()
            .filter { it.name.startsWith(prefix) }
            .forEach { out[it.name.removePrefix(prefix)] = decodeSecrets(it) }
        out
    }

    suspend fun setSecrets(serverId: String, secrets: ServerSecrets) = withContext(Dispatchers.IO) {
        val notes = json.encodeToString(secrets)
        val body = json.encodeToString(
            BwItemBody(
                name = itemName(serverId),
                notes = notes,
                login = BwLoginBody(secrets.username, secrets.password),
            )
        )
        val existing = findItem(serverId)
        if (existing != null) call("PUT", "/object/item/${existing.id}", body)
        else call("POST", "/object/item", body)
    }

    suspend fun deleteSecrets(serverId: String) = withContext(Dispatchers.IO) {
        findItem(serverId)?.let { call("DELETE", "/object/item/${it.id}", null) }
        Unit
    }

    // --- plumbing ---------------------------------------------------------

    private fun decodeSecrets(item: BwItem): ServerSecrets {
        item.notes?.let { notes ->
            runCatching { json.decodeFromString<ServerSecrets>(notes) }.getOrNull()?.let { return it }
        }
        return ServerSecrets(username = item.login?.username, password = item.login?.password)
    }

    private fun findItem(serverId: String): BwItem? {
        val name = itemName(serverId)
        val env = json.decodeFromString<BwListEnvelope>(
            request("GET", "/list/object/items?search=" + encode(name), null)
        )
        return env.data?.data.orEmpty().firstOrNull { it.name == name }
    }

    private fun encode(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun call(method: String, path: String, body: String?) {
        val env = json.decodeFromString<BwResult>(request(method, path, body))
        if (!env.success) error(env.message ?: "bw request failed")
    }

    private fun request(method: String, path: String, body: String?): String {
        val b = base ?: error("No bw serve URL configured")
        val conn = (URL(b + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toByteArray()) }
            }
        }
        return try {
            val ok = conn.responseCode in 200..299
            val stream = if (ok) conn.inputStream else (conn.errorStream ?: conn.inputStream)
            stream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }
}

// --- wire models ----------------------------------------------------------

@Serializable
private data class BwResult(val success: Boolean = false, val message: String? = null)

@Serializable
private data class BwUnlockBody(val password: String)

@Serializable
private data class BwLoginBody(val username: String? = null, val password: String? = null)

@Serializable
private data class BwItemBody(
    val type: Int = 1,
    val name: String,
    val notes: String,
    val login: BwLoginBody,
)

@Serializable
private data class BwStatusEnvelope(
    val success: Boolean = false,
    val message: String? = null,
    val data: BwStatusData? = null,
)

@Serializable
private data class BwStatusData(val template: BwStatusTemplate)

@Serializable
private data class BwStatusTemplate(
    val serverUrl: String? = null,
    val userEmail: String? = null,
    val status: String = "locked",
)

@Serializable
private data class BwListEnvelope(
    val success: Boolean = false,
    val message: String? = null,
    val data: BwListData? = null,
)

@Serializable
private data class BwListData(val data: List<BwItem> = emptyList())

@Serializable
private data class BwItem(
    val id: String,
    val name: String,
    val notes: String? = null,
    val login: BwLogin? = null,
)

@Serializable
private data class BwLogin(val username: String? = null, val password: String? = null)

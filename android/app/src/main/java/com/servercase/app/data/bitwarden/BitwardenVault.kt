package com.servercase.app.data.bitwarden

import com.servercase.app.data.BitwardenSettings
import com.servercase.app.data.ServerSecrets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

enum class BitwardenLockState { UNAUTHENTICATED, LOCKED, UNLOCKED }

data class BitwardenStatus(
    val available: Boolean,
    val state: BitwardenLockState,
    val serverUrl: String? = null,
    val userEmail: String? = null,
    val error: String? = null,
)

/**
 * A clean-room Bitwarden client: it speaks the Bitwarden REST API directly and
 * reimplements the account crypto, so it needs neither the `bw` CLI nor the
 * official SDK.
 *
 * Auth uses a personal API key (OAuth `client_credentials`); the master
 * password is required only to derive the vault key locally and is never sent
 * to the server or persisted. Only the PBKDF2 KDF is supported.
 *
 * Crypto: master key = PBKDF2-SHA256(masterPassword, email, iters, 32); stretch
 * via HKDF-Expand into enc/mac keys; decrypt the protected key into the 64-byte
 * user key; EncStrings are "2.iv|ct|mac" = AES-256-CBC + HMAC-SHA256, base64.
 */
class BitwardenVault {

    @Volatile private var settings = BitwardenSettings()
    @Volatile private var accessToken: String? = null
    @Volatile private var tokenExpiresAt = 0L
    @Volatile private var userEncKey: ByteArray? = null
    @Volatile private var userMacKey: ByteArray? = null
    private val deviceId = UUID.randomUUID().toString()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun configure(s: BitwardenSettings) {
        if (s.serverUrl != settings.serverUrl || s.email != settings.email || s.clientId != settings.clientId) {
            lock()
        }
        settings = s
    }

    private val base get() = settings.serverUrl.trim().trimEnd('/')
    private val identityUrl get() = if (base.isEmpty()) "https://identity.bitwarden.com" else "$base/identity"
    private val apiUrl get() = if (base.isEmpty()) "https://api.bitwarden.com" else "$base/api"

    private val configured
        get() = settings.email.isNotEmpty() && settings.clientId.isNotEmpty() && settings.clientSecret.isNotEmpty()
    private val unlocked
        get() = userEncKey != null && accessToken != null && System.currentTimeMillis() < tokenExpiresAt

    fun status(): BitwardenStatus {
        val state = when {
            !configured -> BitwardenLockState.UNAUTHENTICATED
            unlocked -> BitwardenLockState.UNLOCKED
            else -> BitwardenLockState.LOCKED
        }
        return BitwardenStatus(
            available = configured,
            state = state,
            serverUrl = settings.serverUrl.ifEmpty { "https://bitwarden.com" },
            userEmail = settings.email.ifEmpty { null },
        )
    }

    suspend fun unlock(masterPassword: String): BitwardenStatus = withContext(Dispatchers.IO) {
        require(configured) { "Bitwarden API key is not configured" }
        val token = requestToken()
        val kdf = token.kdf ?: prelogin()

        val masterKey = deriveMasterKey(masterPassword, kdf)
        val stretchedEnc = hkdfExpand(masterKey, "enc", 32)
        val stretchedMac = hkdfExpand(masterKey, "mac", 32)
        val userKey = decryptEncString(token.key, stretchedEnc, stretchedMac)
        require(userKey.size >= 64) { "unexpected vault key length" }

        userEncKey = userKey.copyOfRange(0, 32)
        userMacKey = userKey.copyOfRange(32, 64)
        accessToken = token.accessToken
        tokenExpiresAt = System.currentTimeMillis() + (token.expiresInSec * 1000L) - 30_000L
        status()
    }

    fun lock() {
        accessToken = null
        tokenExpiresAt = 0L
        userEncKey = null
        userMacKey = null
    }

    suspend fun sync() { check(unlocked) { "Bitwarden vault is locked" } }

    suspend fun getSecrets(serverId: String): ServerSecrets? = withContext(Dispatchers.IO) {
        findCipher(serverId)?.let { decodeSecrets(it) }
    }

    suspend fun listSecrets(): Map<String, ServerSecrets> = withContext(Dispatchers.IO) {
        val out = HashMap<String, ServerSecrets>()
        for (cipher in fetchCiphers()) {
            val (enc, mac) = cipherKeys(cipher)
            val name = decryptStr(cipher.name, enc, mac)
            if (name != null && name.startsWith(settings.itemPrefix)) {
                out[name.removePrefix(settings.itemPrefix)] = decodeSecrets(cipher)
            }
        }
        out
    }

    suspend fun setSecrets(serverId: String, secrets: ServerSecrets) = withContext(Dispatchers.IO) {
        check(unlocked) { "Bitwarden vault is locked" }
        val notes = json.encodeToString(secrets)
        val body = buildJsonObject {
            put("type", 1)
            put("name", encryptField(settings.itemPrefix + serverId))
            put("notes", encryptField(notes))
            put("favorite", false)
            put("login", buildJsonObject {
                put("username", secrets.username?.let { encryptField(it) })
                put("password", secrets.password?.let { encryptField(it) })
            })
        }
        val existing = findCipher(serverId)
        if (existing != null) api("PUT", "/ciphers/${existing.id}", body.toString())
        else api("POST", "/ciphers", body.toString())
        Unit
    }

    suspend fun deleteSecrets(serverId: String) = withContext(Dispatchers.IO) {
        findCipher(serverId)?.let { api("DELETE", "/ciphers/${it.id}", null) }
        Unit
    }

    // --- crypto -----------------------------------------------------------

    private fun deriveMasterKey(password: String, kdf: KdfInfo): ByteArray {
        val email = settings.email.trim().lowercase()
        return when (kdf.type) {
            0 -> {
                val spec = PBEKeySpec(password.toCharArray(), email.toByteArray(Charsets.UTF_8), kdf.iterations, 256)
                SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
            }
            1 -> {
                // Bitwarden Argon2id: salt = SHA-256(email), memory in MiB → KiB.
                val salt = MessageDigest.getInstance("SHA-256").digest(email.toByteArray(Charsets.UTF_8))
                argon2id(password.toByteArray(Charsets.UTF_8), salt, kdf.iterations, kdf.memory * 1024, kdf.parallelism)
            }
            else -> error("unsupported KDF type ${kdf.type}")
        }
    }

    private fun argon2id(password: ByteArray, salt: ByteArray, iterations: Int, memoryKiB: Int, parallelism: Int): ByteArray {
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withIterations(iterations)
            .withMemoryAsKB(memoryKiB)
            .withParallelism(parallelism)
            .withSalt(salt)
            .build()
        val generator = Argon2BytesGenerator().apply { init(params) }
        val out = ByteArray(32)
        generator.generateBytes(password, out)
        return out
    }

    private fun encryptField(plaintext: String): String =
        encryptEncString(plaintext.toByteArray(Charsets.UTF_8), encKey(), macKey())

    private fun decryptStr(enc: String?, encKey: ByteArray, macKey: ByteArray): String? {
        if (enc == null) return null
        return runCatching { String(decryptEncString(enc, encKey, macKey), Charsets.UTF_8) }.getOrNull()
    }

    /** The keys to use for a cipher's fields: its own key, or the user key. */
    private fun cipherKeys(cipher: Cipher2): Pair<ByteArray, ByteArray> {
        cipher.key?.let { k ->
            runCatching { decryptEncString(k, encKey(), macKey()) }.getOrNull()?.let { raw ->
                if (raw.size >= 64) return raw.copyOfRange(0, 32) to raw.copyOfRange(32, 64)
            }
        }
        return encKey() to macKey()
    }

    private fun decodeSecrets(cipher: Cipher2): ServerSecrets {
        val (enc, mac) = cipherKeys(cipher)
        decryptStr(cipher.notes, enc, mac)?.let { notes ->
            runCatching { json.decodeFromString<ServerSecrets>(notes) }.getOrNull()?.let { return it }
        }
        return ServerSecrets(
            username = decryptStr(cipher.username, enc, mac),
            password = decryptStr(cipher.password, enc, mac),
        )
    }

    private fun encKey() = userEncKey ?: error("Bitwarden vault is locked")
    private fun macKey() = userMacKey ?: error("Bitwarden vault is locked")

    // --- REST -------------------------------------------------------------

    private fun prelogin(): KdfInfo {
        return runCatching {
            val body = buildJsonObject { put("email", settings.email) }.toString()
            val (code, text) = http("POST", "$identityUrl/accounts/prelogin", body.toByteArray(),
                "application/json", false)
            if (code !in 200..299) return@runCatching defaultKdf
            parseKdf(Json.parseToJsonElement(text).jsonObject)
        }.getOrDefault(defaultKdf)
    }

    private val defaultKdf get() = KdfInfo(0, 600000, 64, 4)

    private fun parseKdf(obj: JsonObject): KdfInfo = KdfInfo(
        type = pick(obj, "Kdf", "kdf")?.jsonPrimitive?.intOrNull ?: 0,
        iterations = pick(obj, "KdfIterations", "kdfIterations")?.jsonPrimitive?.intOrNull ?: 600000,
        memory = pick(obj, "KdfMemory", "kdfMemory")?.jsonPrimitive?.intOrNull ?: 64,
        parallelism = pick(obj, "KdfParallelism", "kdfParallelism")?.jsonPrimitive?.intOrNull ?: 4,
    )

    private fun requestToken(): TokenResult {
        val form = listOf(
            "grant_type" to "client_credentials",
            "client_id" to settings.clientId,
            "client_secret" to settings.clientSecret,
            "scope" to "api",
            "deviceType" to "0", // Android
            "deviceIdentifier" to deviceId,
            "deviceName" to "ServerCase",
        ).joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }

        val (code, text) = http("POST", "$identityUrl/connect/token", form.toByteArray(),
            "application/x-www-form-urlencoded", false)
        val obj = Json.parseToJsonElement(text).jsonObject
        if (code !in 200..299) {
            val msg = obj["error_description"]?.jsonPrimitive?.contentOrNull
                ?: (obj["ErrorModel"] as? JsonObject)?.get("Message")?.jsonPrimitive?.contentOrNull
                ?: "Bitwarden login failed"
            error(msg)
        }
        val key = pick(obj, "Key", "key")?.jsonPrimitive?.contentOrNull ?: error("login response missing key")
        return TokenResult(
            accessToken = obj["access_token"]?.jsonPrimitive?.contentOrNull ?: "",
            expiresInSec = obj["expires_in"]?.jsonPrimitive?.intOrNull ?: 3600,
            key = key,
            kdf = if (pick(obj, "Kdf", "kdf") != null) parseKdf(obj) else null,
        )
    }

    private fun fetchCiphers(): List<Cipher2> {
        check(unlocked) { "Bitwarden vault is locked" }
        val text = api("GET", "/sync?excludeDomains=true", null)
        val obj = Json.parseToJsonElement(text).jsonObject
        val arr = (pick(obj, "Ciphers", "ciphers") as? JsonArray) ?: return emptyList()
        return arr.mapNotNull { (it as? JsonObject)?.let(::Cipher2) }
    }

    private fun findCipher(serverId: String): Cipher2? {
        val target = settings.itemPrefix + serverId
        return fetchCiphers().firstOrNull {
            val (enc, mac) = cipherKeys(it)
            decryptStr(it.name, enc, mac) == target
        }
    }

    private fun api(method: String, path: String, body: String?): String {
        check(unlocked) { "Bitwarden vault is locked" }
        val (code, text) = http(method, "$apiUrl$path", body?.toByteArray(), "application/json", true)
        if (code !in 200..299) error("Bitwarden $method $path failed: $code")
        return text
    }

    private fun http(method: String, url: String, body: ByteArray?, contentType: String, bearer: Boolean): Pair<Int, String> {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            if (bearer) accessToken?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", contentType)
                outputStream.use { it.write(body) }
            }
        }
        return try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
            code to stream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun pick(obj: JsonObject, vararg keys: String): JsonElement? {
        for (k in keys) {
            val v = obj[k]
            if (v != null && v != JsonNull) return v
        }
        return null
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    // --- crypto primitives ------------------------------------------------

    private fun hkdfExpand(prk: ByteArray, info: String, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        val infoBytes = info.toByteArray(Charsets.UTF_8)
        var t = ByteArray(0)
        val out = ByteArrayOutputStream()
        var i = 1
        while (out.size() < length) {
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(t)
            mac.update(infoBytes)
            mac.update(i.toByte())
            t = mac.doFinal()
            out.write(t)
            i++
        }
        return out.toByteArray().copyOf(length)
    }

    private fun hmac(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }

    private fun aes(mode: Int, key: ByteArray, iv: ByteArray, data: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(mode, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return cipher.doFinal(data)
    }

    private fun encryptEncString(plain: ByteArray, encKey: ByteArray, macKey: ByteArray): String {
        val iv = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val ct = aes(Cipher.ENCRYPT_MODE, encKey, iv, plain)
        val mac = hmac(macKey, iv + ct)
        return "2.${b64(iv)}|${b64(ct)}|${b64(mac)}"
    }

    private fun decryptEncString(s: String, encKey: ByteArray, macKey: ByteArray): ByteArray {
        require(s.startsWith("2.")) { "unsupported EncString type" }
        val parts = s.substring(2).split("|")
        require(parts.size == 3) { "malformed EncString" }
        val iv = b64d(parts[0]); val ct = b64d(parts[1]); val mac = b64d(parts[2])
        require(MessageDigest.isEqual(hmac(macKey, iv + ct), mac)) { "EncString MAC mismatch" }
        return aes(Cipher.DECRYPT_MODE, encKey, iv, ct)
    }

    private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)
    private fun b64d(s: String): ByteArray = Base64.getDecoder().decode(s)

    private data class KdfInfo(val type: Int, val iterations: Int, val memory: Int, val parallelism: Int)
    private data class TokenResult(val accessToken: String, val expiresInSec: Int, val key: String, val kdf: KdfInfo?)

    private class Cipher2(raw: JsonObject) {
        val id: String
        val name: String?
        val notes: String?
        val key: String?
        val username: String?
        val password: String?

        init {
            fun pick(obj: JsonObject, vararg keys: String): String? {
                for (k in keys) obj[k]?.takeIf { it != JsonNull }?.let { return it.jsonPrimitive.contentOrNull }
                return null
            }
            id = pick(raw, "Id", "id") ?: ""
            name = pick(raw, "Name", "name")
            notes = pick(raw, "Notes", "notes")
            key = pick(raw, "Key", "key")
            val login = (raw["Login"] ?: raw["login"]) as? JsonObject
            username = login?.let { pick(it, "Username", "username") }
            password = login?.let { pick(it, "Password", "password") }
        }
    }
}

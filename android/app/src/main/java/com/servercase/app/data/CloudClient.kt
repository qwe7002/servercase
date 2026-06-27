package com.servercase.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.HttpURLConnection
import java.net.URL

/** An error from the worker API, carrying the HTTP status for the UI. */
class CloudException(val status: Int, message: String) : Exception(message)

@Serializable
data class CloudAuthResponse(val user: CloudUser, val token: String, val expiresAt: Long)

@Serializable
data class CloudSyncResponse(val version: Int, val updatedAt: Long, val payload: SyncPayload)

@Serializable
data class CloudPutResult(val version: Int, val updatedAt: Long)

/**
 * Minimal REST client for the ServerCase Worker: account auth and config sync,
 * over `HttpURLConnection` (same approach as the Bitwarden client). The
 * payload's numeric `exportedAt` satisfies the worker's shape check.
 */
class CloudClient {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Serializable
    private data class Credentials(val email: String, val password: String)

    @Serializable
    private data class PutSyncBody(val payload: SyncPayload, val baseVersion: Int? = null)

    @Serializable
    private data class RegisterDeviceBody(val platform: String, val token: String, val label: String? = null)

    @Serializable
    private data class ErrorResponse(val error: String? = null)

    suspend fun register(url: String, email: String, password: String): CloudAuthResponse =
        authenticate(url, "/v1/auth/register", email, password)

    suspend fun login(url: String, email: String, password: String): CloudAuthResponse =
        authenticate(url, "/v1/auth/login", email, password)

    private suspend fun authenticate(url: String, path: String, email: String, password: String): CloudAuthResponse {
        val body = json.encodeToString(Credentials(email, password))
        return json.decodeFromString(request(url, path, "POST", body, null))
    }

    suspend fun getSync(url: String, token: String): CloudSyncResponse =
        json.decodeFromString(request(url, "/v1/sync", "GET", null, token))

    suspend fun putSync(url: String, token: String, payload: SyncPayload, baseVersion: Int?): CloudPutResult {
        val body = json.encodeToString(PutSyncBody(payload, baseVersion))
        return json.decodeFromString(request(url, "/v1/sync", "PUT", body, token))
    }

    /** Registers an FCM token so the worker can push alerts to this device. */
    suspend fun registerDevice(url: String, sessionToken: String, fcmToken: String, label: String?) {
        val body = json.encodeToString(RegisterDeviceBody("fcm", fcmToken, label))
        request(url, "/v1/devices", "POST", body, sessionToken)
    }

    private suspend fun request(
        base: String,
        path: String,
        method: String,
        body: String?,
        token: String?,
    ): String = withContext(Dispatchers.IO) {
        val trimmed = base.trimEnd('/')
        if (trimmed.isEmpty()) throw CloudException(0, "Set a valid worker URL first")
        val conn = (URL(trimmed + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Content-Type", "application/json")
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                doOutput = true
                outputStream.use { it.write(body.toByteArray()) }
            }
        }
        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                val message = runCatching { json.decodeFromString<ErrorResponse>(text).error }
                    .getOrNull() ?: "HTTP $code"
                throw CloudException(code, message)
            }
            text
        } catch (e: CloudException) {
            throw e
        } catch (e: Exception) {
            throw CloudException(0, "Cannot reach $trimmed: ${e.message}")
        } finally {
            conn.disconnect()
        }
    }
}

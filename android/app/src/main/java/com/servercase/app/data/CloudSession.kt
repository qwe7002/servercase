package com.servercase.app.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** The cloud account identity returned by the worker. */
@Serializable
data class CloudUser(val id: String, val email: String)

/**
 * Local-only cloud session: the worker session token and last-synced revision.
 * Kept out of [GlobalSettings] so the token is never part of the synced payload
 * — it stays on this device, like an SSH secret without Bitwarden.
 */
@Serializable
data class CloudSession(
    val token: String,
    /** Epoch ms when the token expires. */
    val expiresAt: Long,
    val user: CloudUser,
    val syncVersion: Int? = null,
    /** Epoch ms of the last successful push/pull. */
    val syncedAt: Long? = null,
) {
    val isValid: Boolean get() = expiresAt > System.currentTimeMillis()
}

private val Context.cloudDataStore by preferencesDataStore(name = "servercase_cloud")

/** Persists the cloud session as a JSON blob, separate from the settings store. */
class CloudSessionRepository(private val context: Context) {

    private val key = stringPreferencesKey("session")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    val session: Flow<CloudSession?> = context.cloudDataStore.data.map { prefs ->
        prefs[key]?.let { runCatching { json.decodeFromString<CloudSession>(it) }.getOrNull() }
    }

    suspend fun save(session: CloudSession?) {
        context.cloudDataStore.edit { prefs ->
            if (session == null) prefs.remove(key) else prefs[key] = json.encodeToString(session)
        }
    }
}

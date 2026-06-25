package com.servercase.app.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

private val Context.dataStore by preferencesDataStore(name = "servercase")

/**
 * Persists the user's server list as a JSON blob in DataStore. Secrets are kept
 * locally on-device only.
 */
class ServerRepository(private val context: Context) {

    private val key = stringPreferencesKey("servers")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    val servers: Flow<List<ServerConfig>> = context.dataStore.data.map { prefs ->
        prefs[key]?.let { runCatching { json.decodeFromString<List<ServerConfig>>(it) }.getOrNull() } ?: emptyList()
    }

    suspend fun save(servers: List<ServerConfig>) {
        context.dataStore.edit { it[key] = json.encodeToString(servers) }
    }
}

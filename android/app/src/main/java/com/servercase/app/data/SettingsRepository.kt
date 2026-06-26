package com.servercase.app.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

private val Context.settingsDataStore by preferencesDataStore(name = "servercase_settings")

/** Persists [GlobalSettings] as a JSON blob in DataStore. */
class SettingsRepository(private val context: Context) {

    private val key = stringPreferencesKey("settings")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    val settings: Flow<GlobalSettings> = context.settingsDataStore.data.map { prefs ->
        prefs[key]?.let { runCatching { json.decodeFromString<GlobalSettings>(it) }.getOrNull() }
            ?: GlobalSettings()
    }

    suspend fun save(settings: GlobalSettings) {
        context.settingsDataStore.edit { it[key] = json.encodeToString(settings) }
    }
}

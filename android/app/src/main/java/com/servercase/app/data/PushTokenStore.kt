package com.servercase.app.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.pushDataStore by preferencesDataStore(name = "servercase_push")

/**
 * Holds the latest FCM registration token. The messaging service writes it
 * (including on refresh) and the view model observes it, so token acquisition
 * stays decoupled from registration with the worker.
 */
class PushTokenStore(private val context: Context) {

    private val key = stringPreferencesKey("fcm_token")

    val token: Flow<String?> = context.pushDataStore.data.map { it[key] }

    suspend fun save(token: String) {
        context.pushDataStore.edit { it[key] = token }
    }
}

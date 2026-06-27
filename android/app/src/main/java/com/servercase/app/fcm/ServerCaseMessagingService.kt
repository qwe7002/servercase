package com.servercase.app.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.content.getSystemService
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.servercase.app.MainActivity
import com.servercase.app.R
import com.servercase.app.data.PushTokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Receives FCM messages from the ServerCase Worker. New registration tokens are
 * persisted to [PushTokenStore] (the view model registers them with the worker
 * once signed in); foreground messages are shown as a notification (backgrounded
 * ones are shown by the system from the `notification` payload).
 */
class ServerCaseMessagingService : FirebaseMessagingService() {

    private val scope = CoroutineScope(Dispatchers.IO)

    override fun onNewToken(token: String) {
        scope.launch { PushTokenStore(applicationContext).save(token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: "ServerCase"
        val body = message.notification?.body ?: message.data["body"] ?: return
        showNotification(title, body)
    }

    private fun showNotification(title: String, body: String) {
        val manager = getSystemService<NotificationManager>() ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Alerts", NotificationManager.IMPORTANCE_HIGH),
        )

        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()

        manager.notify(body.hashCode(), notification)
    }

    private companion object {
        const val CHANNEL_ID = "alerts"
    }
}

import Foundation
import UIKit
import UserNotifications
import FirebaseCore
import FirebaseMessaging

extension Notification.Name {
    /// Posted when an FCM registration token is received or refreshed.
    static let fcmTokenReceived = Notification.Name("servercase.fcmTokenReceived")
}

/// The latest FCM registration token, set by the app delegate and read by
/// `AppModel` to register the device with the worker once signed in.
enum PushToken {
    static var current: String?
}

/// Configures Firebase Cloud Messaging and forwards registration tokens.
///
/// Push is gated on the presence of `GoogleService-Info.plist` in the bundle —
/// without it, Firebase is not configured and the app runs normally with push
/// disabled (see GoogleService-Info.plist.example).
final class AppDelegate: NSObject, UIApplicationDelegate, MessagingDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil,
    ) -> Bool {
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            return true // push not configured
        }
        FirebaseApp.configure()
        Messaging.messaging().delegate = self
        UNUserNotificationCenter.current().delegate = self

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data,
    ) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        PushToken.current = fcmToken
        NotificationCenter.default.post(name: .fcmTokenReceived, object: nil)
    }

    /// Show the alert banner even when the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void,
    ) {
        completionHandler([.banner, .sound])
    }
}

import Foundation
import UIKit
import BackgroundTasks

/// Keeps SSH connections and status polling alive briefly after the app moves
/// to the background, and schedules periodic background refreshes so the Live
/// Activity and reconnection logic still run while the app is suspended.
///
/// Two complementary mechanisms are used:
///
/// * A **background-task assertion** (`beginAssertion`) buys the running poll
///   loop a final execution window (≈30s of wall-clock time on modern iOS)
///   right after backgrounding, so the connection isn't torn down the instant
///   the user leaves.
/// * A **`BGAppRefreshTask`** lets the system wake the app later to reconnect,
///   collect one more sample and refresh the Live Activity.
///
/// The refresh identifier must also be listed under
/// `BGTaskSchedulerPermittedIdentifiers` in Info.plist.
@MainActor
final class BackgroundManager {
    static let refreshTaskId = "com.servercase.app.refresh"

    private var assertionId: UIBackgroundTaskIdentifier = .invalid

    /// Registers the BGTaskScheduler handler. Must be called during launch
    /// (before the app finishes launching), i.e. from `AppModel.init`.
    func registerTasks(refresh: @escaping () async -> Void) {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.refreshTaskId,
            using: nil
        ) { [weak self] task in
            guard let task = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handleRefresh(task, refresh: refresh)
        }
    }

    /// Begins a background-task assertion to extend execution after the app
    /// moves to the background. Safe to call repeatedly.
    func beginAssertion() {
        endAssertion()
        assertionId = UIApplication.shared.beginBackgroundTask(withName: "ServerCase.KeepAlive") { [weak self] in
            self?.endAssertion()
        }
    }

    func endAssertion() {
        guard assertionId != .invalid else { return }
        UIApplication.shared.endBackgroundTask(assertionId)
        assertionId = .invalid
    }

    /// Asks the system to wake the app for a refresh no sooner than ~15 min.
    func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleRefresh(_ task: BGAppRefreshTask, refresh: @escaping () async -> Void) {
        scheduleRefresh() // chain the next wake-up

        let work = Task {
            await refresh()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }
}

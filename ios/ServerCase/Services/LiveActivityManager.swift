import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Drives a single ServerCase Live Activity: it starts one when a server
/// connection becomes active, pushes fresh CPU / memory / network numbers on
/// each status poll, and ends it when the connection is dropped or the user
/// stops tracking the server.
///
/// Updates are delivered locally (no push token) — the app refreshes the
/// activity while it runs in the foreground or during a background-execution
/// window (see `BackgroundManager`). Only one activity is shown at a time.
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private init() {}

    #if canImport(ActivityKit)
    private var activity: Activity<ServerActivityAttributes>?
    private var serverId: UUID?

    /// Whether the user has Live Activities enabled for the app.
    var isSupported: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Starts the activity for `server`, or — if one is already running for the
    /// same server — just pushes the new `state`. Switching to a different
    /// server ends the previous activity first.
    func start(server: ServerConfig, state: ServerActivityAttributes.State) {
        guard isSupported else { return }

        if let current = activity, serverId != server.id {
            Task { await current.end(nil, dismissalPolicy: .immediate) }
            activity = nil
            serverId = nil
        }

        if activity != nil {
            update(state)
            return
        }

        let attributes = ServerActivityAttributes(serverName: server.name, host: server.host)
        let content = ActivityContent(state: state, staleDate: staleDate(after: state.updatedAt))
        do {
            activity = try Activity.request(attributes: attributes, content: content)
            serverId = server.id
        } catch {
            // Could not start (disabled mid-flight, budget exceeded, …); ignore.
        }
    }

    /// Pushes a new content state to the running activity, if any.
    func update(_ state: ServerActivityAttributes.State) {
        guard let activity else { return }
        let content = ActivityContent(state: state, staleDate: staleDate(after: state.updatedAt))
        Task { await activity.update(content) }
    }

    /// Ends and dismisses the running activity immediately.
    func end() {
        guard let activity else { return }
        let final = activity.content.state
        Task {
            await activity.end(
                ActivityContent(state: final, staleDate: nil),
                dismissalPolicy: .immediate
            )
        }
        self.activity = nil
        serverId = nil
    }

    /// Marks the live numbers stale a little after the next expected 3s poll so
    /// the system dims them if updates stop (e.g. the app gets suspended).
    private func staleDate(after date: Date) -> Date {
        date.addingTimeInterval(15)
    }
    #else
    var isSupported: Bool { false }
    func start(server: ServerConfig, state: ServerActivityAttributes.State) {}
    func update(_ state: ServerActivityAttributes.State) {}
    func end() {}
    #endif
}

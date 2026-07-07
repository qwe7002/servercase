import ActivityKit
import Foundation

/// Drives the connection Live Activity so an active SSH session stays visible on
/// the Lock Screen and in the Dynamic Island while the app is backgrounded.
///
/// One activity is kept per connected server, keyed by server id: `start` when a
/// session comes up, `update` on each status poll, and `end` on disconnect.
/// Everything is best-effort — if the user has Live Activities turned off, or
/// the system limit is reached, requests fail silently and the app is unaffected.
@MainActor
final class ConnectionActivityController {
    static let shared = ConnectionActivityController()

    private var activities: [String: Activity<ConnectionActivityAttributes>] = [:]

    private init() {}

    private var enabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Starts the activity for a freshly connected server, or refreshes it if one
    /// is already running (e.g. after a reconnect reuses the same id).
    func start(server: ServerConfig, status: ServerStatus?) {
        guard enabled else { return }
        guard activities[server.id] == nil else {
            update(serverId: server.id, state: .connected, status: status)
            return
        }
        let attributes = ConnectionActivityAttributes(
            serverName: server.name,
            host: "\(server.host):\(server.port)"
        )
        let content = ActivityContent(
            state: makeState(.connected, status),
            staleDate: nil
        )
        do {
            activities[server.id] = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: nil
            )
        } catch {
            // Best-effort: disabled by the user, limit reached, etc.
        }
    }

    /// Pushes the latest connection state / status into the running activity.
    func update(serverId: String, state: ConnectionState, status: ServerStatus?) {
        guard let activity = activities[serverId] else { return }
        // If polling stops (app suspended), the activity marks itself stale so the
        // widget can dim the values rather than showing figures that never move.
        let content = ActivityContent(
            state: makeState(state, status),
            staleDate: Date().addingTimeInterval(30)
        )
        Task { await activity.update(content) }
    }

    /// Ends and dismisses the activity for a server that disconnected.
    func end(serverId: String) {
        guard let activity = activities.removeValue(forKey: serverId) else { return }
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    private func makeState(
        _ state: ConnectionState,
        _ status: ServerStatus?
    ) -> ConnectionActivityAttributes.ContentState {
        ConnectionActivityAttributes.ContentState(
            stateLabel: state.label,
            isConnected: state == .connected,
            cpuUsage: status?.cpuUsage,
            memPercent: status.map(\.memPercent),
            uptimeText: status.map { Format.uptime($0.uptimeSec) },
            updatedAt: Date()
        )
    }
}

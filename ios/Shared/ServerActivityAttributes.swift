import ActivityKit
import Foundation

/// Live Activity model for a server's live SSH connection. Shared by the app —
/// which starts, updates and ends the activity — and the widget extension,
/// which renders it on the Lock Screen and in the Dynamic Island.
///
/// `ContentState` carries the values that change on every 3s status poll
/// (connection phase + performance numbers); the attributes themselves only
/// hold the fixed server identity.
struct ServerActivityAttributes: ActivityAttributes {
    typealias ContentState = State

    /// Fixed for the life of the activity.
    let serverName: String
    let host: String

    /// Refreshed on every status poll / connection-state change.
    struct State: Codable, Hashable {
        var phase: Phase
        /// Aggregate CPU usage 0..100, or nil before a second sample exists.
        var cpuUsage: Double?
        var memPercent: Double
        var memUsedKb: Int64
        var memTotalKb: Int64
        var netRxBytesPerSec: Double?
        var netTxBytesPerSec: Double?
        var loadOne: Double
        var uptimeSec: Double
        var updatedAt: Date

        enum Phase: String, Codable, Hashable {
            case connecting
            case connected
            case reconnecting
            case disconnected
            case error

            var label: String {
                switch self {
                case .connecting: return "Connecting…"
                case .connected: return "Connected"
                case .reconnecting: return "Reconnecting…"
                case .disconnected: return "Offline"
                case .error: return "Error"
                }
            }

            /// SF Symbol used in the Lock Screen and Dynamic Island.
            var symbol: String {
                switch self {
                case .connecting, .reconnecting: return "bolt.horizontal.circle"
                case .connected: return "bolt.horizontal.circle.fill"
                case .disconnected: return "bolt.slash.circle"
                case .error: return "exclamationmark.triangle.fill"
                }
            }

            var isLive: Bool { self == .connected }
        }
    }
}

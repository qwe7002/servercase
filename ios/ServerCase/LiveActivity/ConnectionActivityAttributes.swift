import ActivityKit
import Foundation

/// Shared Live Activity payload for a live SSH connection.
///
/// This file is compiled into **both** the app (which starts / updates / ends
/// the activity via `ConnectionActivityController`) and the `ConnectionWidget`
/// extension (which renders it on the Lock Screen and in the Dynamic Island).
/// Keep the definition identical in both — ActivityKit matches the attributes
/// type by its compiled shape.
struct ConnectionActivityAttributes: ActivityAttributes {
    /// The parts that change while the connection is live.
    struct ContentState: Codable, Hashable {
        /// Human-readable connection state, e.g. "Connected" / "Connecting…".
        var stateLabel: String
        /// Whether the SSH session is currently up (drives the status colour).
        var isConnected: Bool
        /// Aggregate CPU usage 0…100, or nil before the first delta sample.
        var cpuUsage: Double?
        /// Memory usage 0…100, or nil until status has been collected.
        var memPercent: Double?
        /// Pre-formatted uptime (e.g. "3d 4h"), or nil until known.
        var uptimeText: String?
        /// When these values were last refreshed by the app.
        var updatedAt: Date
    }

    /// The server name shown as the activity title (fixed for the activity's life).
    var serverName: String
    /// host:port, shown as the subtitle.
    var host: String
}

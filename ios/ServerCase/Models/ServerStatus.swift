import Foundation

struct DiskUsage: Identifiable, Equatable {
    var id: String { mount }
    let mount: String
    let fs: String
    let usedKb: Int64
    let totalKb: Int64
    var percent: Double { totalKb <= 0 ? 0 : min(100, max(0, Double(usedKb) / Double(totalKb) * 100)) }
}

struct ServerStatus: Equatable {
    /// Aggregate CPU usage 0..100, or nil until a second sample exists.
    let cpuUsage: Double?
    let memUsedKb: Int64
    let memTotalKb: Int64
    let swapUsedKb: Int64
    let swapTotalKb: Int64
    let disks: [DiskUsage]
    let netRxBytesPerSec: Double?
    let netTxBytesPerSec: Double?
    let ipv4: [String]
    let ipv6: [String]
    let publicIpv4: String?
    let publicIpv6: String?
    let uptimeSec: Double
    let loadAvg: (Double, Double, Double)
    let hostname: String
    let kernel: String
    let collectedAt: Date

    var memPercent: Double { memTotalKb <= 0 ? 0 : min(100, max(0, Double(memUsedKb) / Double(memTotalKb) * 100)) }
    var swapPercent: Double { swapTotalKb <= 0 ? 0 : min(100, max(0, Double(swapUsedKb) / Double(swapTotalKb) * 100)) }

    static func == (lhs: ServerStatus, rhs: ServerStatus) -> Bool {
        lhs.collectedAt == rhs.collectedAt && lhs.hostname == rhs.hostname
    }
}

enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case error(String)

    var label: String {
        switch self {
        case .disconnected: return "Offline"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .error: return "Error"
        }
    }
}

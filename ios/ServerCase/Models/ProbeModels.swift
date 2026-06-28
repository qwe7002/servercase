import Foundation

struct ProbeHost: Identifiable, Codable, Equatable {
    var id: String
    var name: String
    var createdAt: Date
    var lastSeenAt: Date?
    var latest: ProbeSnapshot?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case createdAt
        case lastSeenAt
        case latest
    }

    init(id: String, name: String, createdAt: Date, lastSeenAt: Date?, latest: ProbeSnapshot?) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.latest = latest
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        createdAt = Date(timeIntervalSince1970: try c.decode(Double.self, forKey: .createdAt) / 1000)
        if let ms = try c.decodeIfPresent(Double.self, forKey: .lastSeenAt) {
            lastSeenAt = Date(timeIntervalSince1970: ms / 1000)
        } else {
            lastSeenAt = nil
        }
        latest = try c.decodeIfPresent(ProbeSnapshot.self, forKey: .latest)
    }
}

struct ProbeCreateResult: Codable {
    struct Host: Codable {
        var id: String
        var name: String
    }

    var host: Host
    var token: String
}

struct ProbeListResult: Codable {
    var hosts: [ProbeHost]
}

struct ProbeSnapshot: Codable, Equatable {
    var schema: String?
    var collectedAtMs: Double
    var hostname: String
    var kernel: String
    var uptimeSec: Double
    var loadAvg: [Double]
    var cpuUsage: Double?
    var memory: ProbeMemory
    var disks: [ProbeDisk]
    var network: ProbeNetwork

    enum CodingKeys: String, CodingKey {
        case schema
        case collectedAtMs = "collected_at_ms"
        case hostname
        case kernel
        case uptimeSec = "uptime_sec"
        case loadAvg = "load_avg"
        case cpuUsage = "cpu_usage"
        case memory
        case disks
        case network
    }
}

struct ProbeMemory: Codable, Equatable {
    var memTotalKb: Int64
    var memUsedKb: Int64
    var swapTotalKb: Int64
    var swapUsedKb: Int64

    enum CodingKeys: String, CodingKey {
        case memTotalKb = "mem_total_kb"
        case memUsedKb = "mem_used_kb"
        case swapTotalKb = "swap_total_kb"
        case swapUsedKb = "swap_used_kb"
    }
}

struct ProbeDisk: Codable, Equatable {
    var mount: String
    var fs: String
    var usedKb: Int64
    var totalKb: Int64

    enum CodingKeys: String, CodingKey {
        case mount
        case fs
        case usedKb = "used_kb"
        case totalKb = "total_kb"
    }
}

struct ProbeNetwork: Codable, Equatable {
    var rxBytesPerSec: Double?
    var txBytesPerSec: Double?
    var interfaces: [ProbeInterface]?
    var publicIpv4: String?
    var publicIpv6: String?

    enum CodingKeys: String, CodingKey {
        case rxBytesPerSec = "rx_bytes_per_sec"
        case txBytesPerSec = "tx_bytes_per_sec"
        case interfaces
        case publicIpv4 = "public_ipv4"
        case publicIpv6 = "public_ipv6"
    }
}

struct ProbeInterface: Codable, Equatable {
    var name: String
    var ipv4: [String]
    var ipv6: [String]
}

extension ProbeSnapshot {
    var serverStatus: ServerStatus {
        let loads = (
            loadAvg.indices.contains(0) ? loadAvg[0] : 0,
            loadAvg.indices.contains(1) ? loadAvg[1] : 0,
            loadAvg.indices.contains(2) ? loadAvg[2] : 0
        )
        return ServerStatus(
            cpuUsage: cpuUsage,
            memUsedKb: memory.memUsedKb,
            memTotalKb: memory.memTotalKb,
            swapUsedKb: memory.swapUsedKb,
            swapTotalKb: memory.swapTotalKb,
            disks: disks.map { DiskUsage(mount: $0.mount, fs: $0.fs, usedKb: $0.usedKb, totalKb: $0.totalKb) },
            netRxBytesPerSec: network.rxBytesPerSec,
            netTxBytesPerSec: network.txBytesPerSec,
            ipv4: (network.interfaces ?? []).flatMap { iface in iface.ipv4.map { "\(iface.name) \($0)" } },
            ipv6: (network.interfaces ?? []).flatMap { iface in iface.ipv6.map { "\(iface.name) \($0)" } },
            publicIpv4: network.publicIpv4,
            publicIpv6: network.publicIpv6,
            uptimeSec: uptimeSec,
            loadAvg: loads,
            hostname: hostname,
            kernel: kernel,
            collectedAt: Date(timeIntervalSince1970: collectedAtMs / 1000)
        )
    }
}

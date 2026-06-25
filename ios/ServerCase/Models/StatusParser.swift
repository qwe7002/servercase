import Foundation

/// Parses the raw output of `STATUS_COMMAND` into a `ServerStatus`. CPU% and
/// network throughput need two samples, so callers keep a `CollectorState` per
/// server between polls.
enum StatusParser {

    /// One portable command that dumps the kernel counters we need.
    static let statusCommand: String = [
        "echo \"===stat===\"; cat /proc/stat | grep \"^cpu \"",
        "echo \"===mem===\"; cat /proc/meminfo",
        "echo \"===net===\"; cat /proc/net/dev",
        "echo \"===uptime===\"; cat /proc/uptime",
        "echo \"===load===\"; cat /proc/loadavg",
        "echo \"===disk===\"; df -k -P 2>/dev/null",
        "echo \"===host===\"; uname -r; hostname",
    ].joined(separator: "; ")

    final class CollectorState {
        var cpuTotal: Int64 = -1
        var cpuIdle: Int64 = -1
        var netRx: Int64 = -1
        var netTx: Int64 = -1
        var netAt: Date? = nil
    }

    private static func section(_ raw: String, _ name: String) -> String {
        let marker = "===\(name)==="
        guard let start = raw.range(of: marker) else { return "" }
        let afterMarker = raw[start.upperBound...]
        guard let nl = afterMarker.firstIndex(of: "\n") else { return "" }
        let body = afterMarker[afterMarker.index(after: nl)...]
        if let next = body.range(of: "===") {
            return String(body[..<next.lowerBound])
        }
        return String(body)
    }

    private static func fields(_ s: String) -> [String] {
        s.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
    }

    static func parse(_ raw: String, state: CollectorState) -> ServerStatus {
        let now = Date()

        // CPU
        var cpuUsage: Double? = nil
        let cpuLine = section(raw, "stat").trimmingCharacters(in: .whitespacesAndNewlines)
        if cpuLine.hasPrefix("cpu") {
            let nums = fields(String(cpuLine.dropFirst(3))).compactMap { Int64($0) }
            if nums.count >= 4 {
                let idle = nums[3] + (nums.count > 4 ? nums[4] : 0)
                let total = nums.reduce(0, +)
                if state.cpuTotal >= 0 {
                    let dTotal = total - state.cpuTotal
                    let dIdle = idle - state.cpuIdle
                    if dTotal > 0 {
                        cpuUsage = min(100, max(0, Double(dTotal - dIdle) / Double(dTotal) * 100))
                    }
                }
                state.cpuTotal = total
                state.cpuIdle = idle
            }
        }

        // Memory
        var mem: [String: Int64] = [:]
        for line in section(raw, "mem").split(separator: "\n") {
            let parts = fields(String(line))
            if parts.count >= 2, parts[0].hasSuffix(":") {
                let key = String(parts[0].dropLast())
                if let v = Int64(parts[1]) { mem[key] = v }
            }
        }
        let memTotal = mem["MemTotal"] ?? 0
        let memAvailable = mem["MemAvailable"]
            ?? ((mem["MemFree"] ?? 0) + (mem["Buffers"] ?? 0) + (mem["Cached"] ?? 0))
        let swapTotal = mem["SwapTotal"] ?? 0
        let swapFree = mem["SwapFree"] ?? 0

        // Network
        var rx: Int64 = 0
        var tx: Int64 = 0
        for line in section(raw, "net").split(separator: "\n") {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let iface = line[..<colon].trimmingCharacters(in: .whitespaces)
            if iface == "lo" || iface.hasPrefix("docker") || iface.hasPrefix("veth") { continue }
            let cols = fields(String(line[line.index(after: colon)...])).compactMap { Int64($0) }
            if cols.count < 9 { continue }
            rx += cols[0]
            tx += cols[8]
        }
        var netRx: Double? = nil
        var netTx: Double? = nil
        if let last = state.netAt {
            let dt = now.timeIntervalSince(last)
            if dt > 0 {
                netRx = max(0, Double(rx - state.netRx) / dt)
                netTx = max(0, Double(tx - state.netTx) / dt)
            }
        }
        state.netRx = rx
        state.netTx = tx
        state.netAt = now

        // Uptime / load
        let uptime = Double(fields(section(raw, "uptime")).first ?? "") ?? 0
        let loadParts = fields(section(raw, "load"))
        let load = (
            Double(loadParts.first ?? "") ?? 0,
            loadParts.count > 1 ? Double(loadParts[1]) ?? 0 : 0,
            loadParts.count > 2 ? Double(loadParts[2]) ?? 0 : 0
        )

        // Disks
        var disks: [DiskUsage] = []
        let diskLines = section(raw, "disk").split(separator: "\n")
        for line in diskLines.dropFirst() {
            let c = fields(String(line))
            if c.count < 6 { continue }
            let fs = c[0]
            if fs == "tmpfs" || fs == "devtmpfs" || fs == "overlay" || fs.hasPrefix("/dev/loop") { continue }
            guard let total = Int64(c[1]), let used = Int64(c[2]), total > 0 else { continue }
            disks.append(DiskUsage(mount: c[c.count - 1], fs: fs, usedKb: used, totalKb: total))
        }

        // Host
        let hostLines = section(raw, "host").split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }

        return ServerStatus(
            cpuUsage: cpuUsage,
            memUsedKb: max(0, memTotal - memAvailable),
            memTotalKb: memTotal,
            swapUsedKb: max(0, swapTotal - swapFree),
            swapTotalKb: swapTotal,
            disks: disks,
            netRxBytesPerSec: netRx,
            netTxBytesPerSec: netTx,
            uptimeSec: uptime,
            loadAvg: load,
            hostname: hostLines.count > 1 ? hostLines[1] : "",
            kernel: hostLines.first ?? "",
            collectedAt: now
        )
    }
}

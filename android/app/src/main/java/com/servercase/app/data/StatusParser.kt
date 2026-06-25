package com.servercase.app.data

/**
 * Parses the raw output of [STATUS_COMMAND] into a [ServerStatus]. CPU% and
 * network throughput require two samples, so a [CollectorState] is carried
 * between polls per server.
 */
object StatusParser {

    /** One portable command that dumps the kernel counters we need. */
    val STATUS_COMMAND: String = listOf(
        "echo \"===stat===\"; cat /proc/stat | grep \"^cpu \"",
        "echo \"===mem===\"; cat /proc/meminfo",
        "echo \"===net===\"; cat /proc/net/dev",
        "echo \"===uptime===\"; cat /proc/uptime",
        "echo \"===load===\"; cat /proc/loadavg",
        "echo \"===disk===\"; df -k -P 2>/dev/null",
        "echo \"===host===\"; uname -r; hostname",
    ).joinToString("; ")

    class CollectorState {
        var cpuTotal: Long = -1
        var cpuIdle: Long = -1
        var netRx: Long = -1
        var netTx: Long = -1
        var netAt: Long = -1
    }

    private fun section(raw: String, name: String): String {
        val marker = "===$name==="
        val start = raw.indexOf(marker)
        if (start == -1) return ""
        val from = raw.indexOf('\n', start) + 1
        val next = raw.indexOf("===", from)
        return if (next == -1) raw.substring(from) else raw.substring(from, next)
    }

    fun parse(raw: String, state: CollectorState): ServerStatus {
        val now = System.currentTimeMillis()

        // CPU
        var cpuUsage: Float? = null
        val cpuLine = section(raw, "stat").trim()
        if (cpuLine.startsWith("cpu")) {
            val nums = cpuLine.removePrefix("cpu").trim().split(Regex("\\s+")).mapNotNull { it.toLongOrNull() }
            if (nums.size >= 4) {
                val idle = nums[3] + (nums.getOrElse(4) { 0 })
                val total = nums.sum()
                if (state.cpuTotal >= 0) {
                    val dTotal = total - state.cpuTotal
                    val dIdle = idle - state.cpuIdle
                    if (dTotal > 0) cpuUsage = (((dTotal - dIdle).toFloat() / dTotal) * 100f).coerceIn(0f, 100f)
                }
                state.cpuTotal = total
                state.cpuIdle = idle
            }
        }

        // Memory
        val mem = HashMap<String, Long>()
        for (line in section(raw, "mem").lineSequence()) {
            val m = Regex("^(\\w+):\\s+(\\d+)\\s*kB").find(line) ?: continue
            mem[m.groupValues[1]] = m.groupValues[2].toLong()
        }
        val memTotal = mem["MemTotal"] ?: 0
        val memAvailable = mem["MemAvailable"]
            ?: ((mem["MemFree"] ?: 0) + (mem["Buffers"] ?: 0) + (mem["Cached"] ?: 0))
        val swapTotal = mem["SwapTotal"] ?: 0
        val swapFree = mem["SwapFree"] ?: 0

        // Network
        var rx = 0L
        var tx = 0L
        for (line in section(raw, "net").lineSequence()) {
            val idx = line.indexOf(':')
            if (idx == -1) continue
            val iface = line.substring(0, idx).trim()
            if (iface == "lo" || iface.startsWith("docker") || iface.startsWith("veth")) continue
            val cols = line.substring(idx + 1).trim().split(Regex("\\s+")).mapNotNull { it.toLongOrNull() }
            if (cols.size < 9) continue
            rx += cols[0]
            tx += cols[8]
        }
        var netRx: Double? = null
        var netTx: Double? = null
        if (state.netAt >= 0) {
            val dt = (now - state.netAt) / 1000.0
            if (dt > 0) {
                netRx = ((rx - state.netRx) / dt).coerceAtLeast(0.0)
                netTx = ((tx - state.netTx) / dt).coerceAtLeast(0.0)
            }
        }
        state.netRx = rx
        state.netTx = tx
        state.netAt = now

        // Uptime / load
        val uptime = section(raw, "uptime").trim().split(Regex("\\s+")).firstOrNull()?.toDoubleOrNull() ?: 0.0
        val loadParts = section(raw, "load").trim().split(Regex("\\s+"))
        val load = Triple(
            loadParts.getOrNull(0)?.toDoubleOrNull() ?: 0.0,
            loadParts.getOrNull(1)?.toDoubleOrNull() ?: 0.0,
            loadParts.getOrNull(2)?.toDoubleOrNull() ?: 0.0,
        )

        // Disks
        val disks = ArrayList<DiskUsage>()
        val diskLines = section(raw, "disk").trim().lines()
        for (line in diskLines.drop(1)) {
            val c = line.trim().split(Regex("\\s+"))
            if (c.size < 6) continue
            val fs = c[0]
            if (fs == "tmpfs" || fs == "devtmpfs" || fs == "overlay" || fs.startsWith("/dev/loop")) continue
            val total = c[1].toLongOrNull() ?: continue
            val used = c[2].toLongOrNull() ?: continue
            if (total == 0L) continue
            disks += DiskUsage(mount = c.last(), fs = fs, usedKb = used, totalKb = total)
        }

        // Host
        val hostLines = section(raw, "host").trim().lines()

        return ServerStatus(
            cpuUsage = cpuUsage,
            memUsedKb = (memTotal - memAvailable).coerceAtLeast(0),
            memTotalKb = memTotal,
            swapUsedKb = (swapTotal - swapFree).coerceAtLeast(0),
            swapTotalKb = swapTotal,
            disks = disks,
            netRxBytesPerSec = netRx,
            netTxBytesPerSec = netTx,
            uptimeSec = uptime,
            loadAvg = load,
            hostname = hostLines.getOrElse(1) { "" }.trim(),
            kernel = hostLines.getOrElse(0) { "" }.trim(),
            collectedAt = now,
        )
    }
}

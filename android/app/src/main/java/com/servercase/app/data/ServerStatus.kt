package com.servercase.app.data

data class DiskUsage(
    val mount: String,
    val fs: String,
    val usedKb: Long,
    val totalKb: Long,
) {
    val percent: Float get() = if (totalKb <= 0) 0f else (usedKb.toFloat() / totalKb * 100f).coerceIn(0f, 100f)
}

data class ServerStatus(
    /** Aggregate CPU usage 0..100, or null until a second sample exists. */
    val cpuUsage: Float?,
    val memUsedKb: Long,
    val memTotalKb: Long,
    val swapUsedKb: Long,
    val swapTotalKb: Long,
    val disks: List<DiskUsage>,
    val netRxBytesPerSec: Double?,
    val netTxBytesPerSec: Double?,
    val uptimeSec: Double,
    val loadAvg: Triple<Double, Double, Double>,
    val hostname: String,
    val kernel: String,
    val collectedAt: Long = System.currentTimeMillis(),
) {
    val memPercent: Float get() = if (memTotalKb <= 0) 0f else (memUsedKb.toFloat() / memTotalKb * 100f).coerceIn(0f, 100f)
    val swapPercent: Float get() = if (swapTotalKb <= 0) 0f else (swapUsedKb.toFloat() / swapTotalKb * 100f).coerceIn(0f, 100f)
}

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, ERROR }

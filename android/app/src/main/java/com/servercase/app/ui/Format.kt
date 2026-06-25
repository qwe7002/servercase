package com.servercase.app.ui

import java.util.Locale

object Format {
    fun bytes(value: Double): String {
        if (value.isNaN() || value < 0) return "–"
        val units = arrayOf("B", "KB", "MB", "GB", "TB", "PB")
        var v = value
        var i = 0
        while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
        val digits = if (v >= 100 || i == 0) 0 else 1
        return String.format(Locale.US, "%.${digits}f %s", v, units[i])
    }

    fun kb(kb: Long): String = bytes(kb * 1024.0)

    fun rate(bytesPerSec: Double?): String = if (bytesPerSec == null) "–" else "${bytes(bytesPerSec)}/s"

    fun uptime(sec: Double): String {
        if (sec <= 0) return "–"
        val total = sec.toLong()
        val d = total / 86400
        val h = (total % 86400) / 3600
        val m = (total % 3600) / 60
        return when {
            d > 0 -> "${d}d ${h}h"
            h > 0 -> "${h}h ${m}m"
            else -> "${m}m"
        }
    }
}

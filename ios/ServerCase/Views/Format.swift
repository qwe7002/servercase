import Foundation
import SwiftUI

enum Format {
    static func bytes(_ value: Double) -> String {
        guard value.isFinite, value >= 0 else { return "–" }
        let units = ["B", "KB", "MB", "GB", "TB", "PB"]
        var v = value
        var i = 0
        while v >= 1024 && i < units.count - 1 { v /= 1024; i += 1 }
        let digits = (v >= 100 || i == 0) ? 0 : 1
        return String(format: "%.\(digits)f %@", v, units[i])
    }

    static func kb(_ kb: Int64) -> String { bytes(Double(kb) * 1024) }

    static func rate(_ bytesPerSec: Double?) -> String {
        guard let b = bytesPerSec else { return "–" }
        return "\(bytes(b))/s"
    }

    static func uptime(_ sec: Double) -> String {
        guard sec > 0 else { return "–" }
        let total = Int(sec)
        let d = total / 86400, h = (total % 86400) / 3600, m = (total % 3600) / 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }
}

enum Palette {
    static let accent = Color(red: 0.30, green: 0.55, blue: 1.0)
    static let good = Color(red: 0.25, green: 0.73, blue: 0.31)
    static let warn = Color(red: 1.0, green: 0.69, blue: 0.18)
    static let danger = Color(red: 1.0, green: 0.36, blue: 0.36)
    static let surface = Color(red: 0.086, green: 0.098, blue: 0.13)

    static func usage(_ percent: Double) -> Color {
        switch percent {
        case 90...: return danger
        case 75...: return warn
        default: return good
        }
    }
}

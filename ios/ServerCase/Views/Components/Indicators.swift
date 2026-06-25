import SwiftUI

/// Circular percentage gauge. `value` is 0..100, or nil for "no data".
struct GaugeView: View {
    let label: String
    let value: Double?
    var caption: String? = nil

    private var pct: Double { value ?? 0 }

    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                Circle()
                    .stroke(Color.white.opacity(0.08), lineWidth: 10)
                Circle()
                    .trim(from: 0, to: pct / 100)
                    .stroke(Palette.usage(pct), style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeInOut(duration: 0.4), value: pct)
                Text(value == nil ? "–" : "\(Int(pct))%")
                    .font(.headline).bold()
            }
            .frame(width: 92, height: 92)
            Text(label).font(.caption).foregroundStyle(.secondary)
            if let caption {
                Text(caption).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// Horizontal usage bar for memory / swap / disks.
struct UsageBarView: View {
    let label: String
    let detail: String
    let percent: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).font(.subheadline)
                Spacer()
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 5)
                        .fill(Color.white.opacity(0.08))
                    RoundedRectangle(cornerRadius: 5)
                        .fill(Palette.usage(percent))
                        .frame(width: geo.size.width * min(1, max(0, percent / 100)))
                }
            }
            .frame(height: 8)
        }
        .padding(.vertical, 4)
    }
}

/// Small colored connection-state dot.
struct StatusDot: View {
    let state: ConnectionState
    var body: some View {
        Circle().fill(color).frame(width: 10, height: 10)
    }
    private var color: Color {
        switch state {
        case .connected: return Palette.good
        case .connecting: return Palette.warn
        case .error: return Palette.danger
        case .disconnected: return .gray
        }
    }
}

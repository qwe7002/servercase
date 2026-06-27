import ActivityKit
import SwiftUI
import WidgetKit

/// Live Activity for a server's live SSH connection. Renders the connection
/// status plus a compact set of performance numbers (CPU, memory, network) on
/// the Lock Screen and in the Dynamic Island.
struct ServerActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ServerActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Palette.surface.opacity(0.92))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(context.attributes.serverName).font(.headline).lineLimit(1)
                    } icon: {
                        Image(systemName: state.phase.symbol)
                            .foregroundStyle(phaseColor(state.phase))
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(state.phase.label)
                        .font(.caption).foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if state.phase.isLive {
                        MetricsRow(state: state)
                    } else {
                        Text(context.attributes.host)
                            .font(.caption).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            } compactLeading: {
                Image(systemName: state.phase.symbol)
                    .foregroundStyle(phaseColor(state.phase))
            } compactTrailing: {
                Text(cpuText(state.cpuUsage))
                    .font(.caption2).monospacedDigit()
                    .foregroundStyle(usageColor(state.cpuUsage))
            } minimal: {
                Image(systemName: state.phase.symbol)
                    .foregroundStyle(phaseColor(state.phase))
            }
            .keylineTint(phaseColor(state.phase))
        }
    }
}

// MARK: - Lock Screen / banner

private struct LockScreenView: View {
    let attributes: ServerActivityAttributes
    let state: ServerActivityAttributes.State

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: state.phase.symbol)
                    .foregroundStyle(phaseColor(state.phase))
                VStack(alignment: .leading, spacing: 1) {
                    Text(attributes.serverName).font(.headline).lineLimit(1)
                    Text(attributes.host).font(.caption2)
                        .foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(state.phase.label)
                    .font(.caption).fontWeight(.medium)
                    .foregroundStyle(phaseColor(state.phase))
            }

            if state.phase.isLive {
                MetricsRow(state: state)
                HStack {
                    Text("Uptime \(Format.uptime(state.uptimeSec))")
                    Spacer()
                    Text("Updated \(state.updatedAt, style: .relative) ago")
                }
                .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding()
    }
}

// MARK: - Shared metric row

private struct MetricsRow: View {
    let state: ServerActivityAttributes.State

    var body: some View {
        HStack(spacing: 10) {
            Metric(title: "CPU", value: cpuText(state.cpuUsage),
                   color: usageColor(state.cpuUsage))
            Metric(title: "MEM", value: memText(state),
                   color: Palette.usage(state.memPercent))
            Metric(title: "NET",
                   value: "↓\(Format.rate(state.netRxBytesPerSec))",
                   color: Palette.accent)
            Metric(title: "", value: "↑\(Format.rate(state.netTxBytesPerSec))",
                   color: Palette.accent)
        }
    }
}

private struct Metric: View {
    let title: String
    let value: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if !title.isEmpty {
                Text(title).font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            } else {
                Text(" ").font(.system(size: 9, weight: .semibold))
            }
            Text(value).font(.caption).monospacedDigit()
                .foregroundStyle(color).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Formatting helpers

private func cpuText(_ usage: Double?) -> String {
    guard let usage else { return "—" }
    return String(format: "%.0f%%", usage)
}

private func memText(_ state: ServerActivityAttributes.State) -> String {
    guard state.memTotalKb > 0 else { return "—" }
    return String(format: "%.0f%%", state.memPercent)
}

private func usageColor(_ percent: Double?) -> Color {
    guard let percent else { return .secondary }
    return Palette.usage(percent)
}

private func phaseColor(_ phase: ServerActivityAttributes.State.Phase) -> Color {
    switch phase {
    case .connected: return Palette.good
    case .connecting, .reconnecting: return Palette.warn
    case .disconnected: return .secondary
    case .error: return Palette.danger
    }
}

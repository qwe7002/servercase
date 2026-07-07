import ActivityKit
import SwiftUI
import WidgetKit

/// Lock Screen + Dynamic Island presentation of a live SSH connection.
struct ConnectionLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ConnectionActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .padding(14)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(context.attributes.serverName)
                            .font(.headline)
                            .lineLimit(1)
                    } icon: {
                        StatusIcon(isConnected: context.state.isConnected)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.stateLabel)
                        .font(.caption)
                        .foregroundStyle(context.state.isConnected ? WidgetPalette.good : WidgetPalette.warn)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 18) {
                        MetricLabel(title: "CPU", value: WidgetFormat.percent(context.state.cpuUsage))
                        MetricLabel(title: "Mem", value: WidgetFormat.percent(context.state.memPercent))
                        if let uptime = context.state.uptimeText {
                            MetricLabel(title: "Up", value: uptime)
                        }
                        Spacer(minLength: 0)
                        Text(context.attributes.host)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                StatusIcon(isConnected: context.state.isConnected)
            } compactTrailing: {
                Text(WidgetFormat.percent(context.state.cpuUsage))
                    .font(.caption2)
                    .monospacedDigit()
            } minimal: {
                StatusIcon(isConnected: context.state.isConnected)
            }
            .widgetURL(URL(string: "servercase://connection"))
            .keylineTint(WidgetPalette.accent)
        }
    }
}

/// The Lock Screen / banner layout.
private struct LockScreenView: View {
    let attributes: ConnectionActivityAttributes
    let state: ConnectionActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                StatusIcon(isConnected: state.isConnected)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(attributes.serverName)
                        .font(.headline)
                        .lineLimit(1)
                    Text(attributes.host)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                Text(state.stateLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(state.isConnected ? WidgetPalette.good : WidgetPalette.warn)
            }

            HStack(spacing: 18) {
                MetricLabel(title: "CPU", value: WidgetFormat.percent(state.cpuUsage))
                MetricLabel(title: "Memory", value: WidgetFormat.percent(state.memPercent))
                if let uptime = state.uptimeText {
                    MetricLabel(title: "Uptime", value: uptime)
                }
                Spacer(minLength: 0)
            }
        }
        .foregroundStyle(.white)
    }
}

private struct StatusIcon: View {
    let isConnected: Bool

    var body: some View {
        Image(systemName: isConnected ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle")
            .foregroundStyle(isConnected ? WidgetPalette.good : WidgetPalette.warn)
    }
}

private struct MetricLabel: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.medium))
                .monospacedDigit()
        }
    }
}

// The widget extension is a separate target and cannot see the app's `Palette`
// / `Format`, so mirror the few bits it needs here.
private enum WidgetPalette {
    static let accent = Color(red: 0.30, green: 0.55, blue: 1.0)
    static let good = Color(red: 0.25, green: 0.73, blue: 0.31)
    static let warn = Color(red: 1.0, green: 0.69, blue: 0.18)
}

private enum WidgetFormat {
    static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "–" }
        return String(format: "%.0f%%", max(0, min(100, value)))
    }
}

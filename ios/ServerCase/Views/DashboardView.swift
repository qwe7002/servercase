import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var model: AppModel
    let server: ServerConfig

    @State private var selectedTab: ServerDetailTab = .overview

    private var state: ConnectionState { model.state(server.id) }
    private var status: ServerStatus? { model.status[server.id] }
    private var connected: Bool { state == .connected }

    var body: some View {
        TabView(selection: $selectedTab) {
            overview
                .tabItem { Label("Overview", systemImage: "gauge.with.dots.needle.33percent") }
                .tag(ServerDetailTab.overview)

            TerminalView(server: server)
                .tabItem { Label("Terminal", systemImage: "terminal") }
                .tag(ServerDetailTab.terminal)

            FilesView(server: server)
                .tabItem { Label("Files", systemImage: "folder") }
                .tag(ServerDetailTab.files)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if connected {
                    Button("Disconnect") { model.disconnect(server.id) }
                } else {
                    Button(state == .connecting ? "Connecting…" : "Connect") {
                        model.connect(server)
                    }
                    .disabled(state == .connecting)
                }
            }
        }
        .onAppear { model.startPolling(server.id) }
        .onDisappear { model.stopPolling() }
    }

    private var title: String {
        switch selectedTab {
        case .overview: return server.name
        case .terminal: return "Terminal"
        case .files: return "Files"
        }
    }

    private var overview: some View {
        ScrollView {
            VStack(spacing: 16) {
                if case let .error(message) = state {
                    Text("Connection failed: \(message)")
                        .font(.callout).foregroundStyle(Palette.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding().background(Palette.danger.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                if !connected {
                    placeholder(state == .connecting ? "Establishing SSH connection…"
                                                       : "Not connected. Tap Connect for live status.")
                } else if let status {
                    gauges(status)
                    infoCard(status)
                    memoryCard(status)
                    disksCard(status)
                } else {
                    placeholder("Collecting status…")
                }
            }
            .padding()
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text).foregroundStyle(.secondary).padding(.vertical, 40)
    }

    private func gauges(_ s: ServerStatus) -> some View {
        HStack(spacing: 12) {
            GaugeView(label: "CPU", value: s.cpuUsage,
                      caption: String(format: "load %.2f", s.loadAvg.0))
            GaugeView(label: "Memory", value: s.memPercent,
                      caption: "\(Format.kb(s.memUsedKb)) / \(Format.kb(s.memTotalKb))")
        }
        .card()
    }

    private func infoCard(_ s: ServerStatus) -> some View {
        VStack(spacing: 8) {
            kv("Uptime", Format.uptime(s.uptimeSec))
            kv("Network", "↓ \(Format.rate(s.netRxBytesPerSec))   ↑ \(Format.rate(s.netTxBytesPerSec))")
            kv("Kernel", s.kernel.isEmpty ? "–" : s.kernel)
            kv("Host", s.hostname.isEmpty ? "–" : s.hostname)
        }
        .card()
    }

    private func memoryCard(_ s: ServerStatus) -> some View {
        VStack(alignment: .leading) {
            Text("Memory").font(.headline)
            UsageBarView(label: "RAM",
                         detail: "\(Format.kb(s.memUsedKb)) / \(Format.kb(s.memTotalKb))",
                         percent: s.memPercent)
            if s.swapTotalKb > 0 {
                UsageBarView(label: "Swap",
                             detail: "\(Format.kb(s.swapUsedKb)) / \(Format.kb(s.swapTotalKb))",
                             percent: s.swapPercent)
            }
        }
        .card()
    }

    private func disksCard(_ s: ServerStatus) -> some View {
        VStack(alignment: .leading) {
            Text("Disks").font(.headline)
            if s.disks.isEmpty {
                Text("No mounts reported.").foregroundStyle(.secondary)
            }
            ForEach(s.disks) { d in
                UsageBarView(label: "\(d.mount) (\(d.fs))",
                             detail: "\(Format.kb(d.usedKb)) / \(Format.kb(d.totalKb))",
                             percent: d.percent)
            }
        }
        .card()
    }

    private func kv(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.medium)
        }
    }
}

private enum ServerDetailTab {
    case overview
    case terminal
    case files
}

private extension View {
    func card() -> some View {
        self.padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

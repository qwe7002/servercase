import SwiftUI

/// Hosts multiple terminal sessions as tabs for one server. New tab with the
/// `+` button; each tab is an independent SSH terminal session and stays alive
/// (in a hidden layer) while another tab is active, so its shell persists.
struct TerminalTabsView: View {
    @EnvironmentObject private var model: AppModel
    let server: ServerConfig

    @State private var tabs: [UUID]
    @State private var activeTab: UUID

    init(server: ServerConfig) {
        self.server = server
        let first = UUID()
        _tabs = State(initialValue: [first])
        _activeTab = State(initialValue: first)
    }

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            ZStack {
                ForEach(tabs, id: \.self) { id in
                    TerminalView(server: server, isActive: id == activeTab)
                        .opacity(id == activeTab ? 1 : 0)
                        .allowsHitTesting(id == activeTab)
                }
            }
        }
    }

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(tabs.enumerated()), id: \.element) { index, id in
                    HStack(spacing: 6) {
                        Image(systemName: "terminal")
                        Text("\(index + 1)")
                        if tabs.count > 1 {
                            Button {
                                close(id)
                            } label: {
                                Image(systemName: "xmark").font(.caption2)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .font(.footnote)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(id == activeTab ? Color.secondary.opacity(0.25) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .foregroundStyle(id == activeTab ? .primary : .secondary)
                    .contentShape(Rectangle())
                    .onTapGesture { activeTab = id }
                }

                Button {
                    addTab()
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 8)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .background(.black.opacity(0.2))
    }

    private func addTab() {
        let id = UUID()
        tabs.append(id)
        activeTab = id
    }

    private func close(_ id: UUID) {
        guard tabs.count > 1, let index = tabs.firstIndex(of: id) else { return }
        tabs.remove(at: index)
        if activeTab == id {
            activeTab = tabs[max(0, index - 1)]
        }
    }
}

import SwiftUI

struct RootView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        if horizontalSizeClass == .compact {
            ServerListView()
        } else {
            ServerSplitView()
        }
    }
}

/// Compact (iPhone) layout: a single navigation stack that pushes the dashboard
/// for the tapped server. The iPad layout lives in `ServerSplitView`.
struct ServerListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var editing: ServerConfig?
    @State private var addingNew = false
    @State private var showingSettings = false
    @State private var searchText = ""
    @State private var path: [ServerConfig] = []
    @State private var collapsedGroupIDs: Set<String> = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.servers.isEmpty {
                    ContentUnavailableView(
                        "No servers",
                        systemImage: "server.rack",
                        description: Text("Tap + to add your first server.")
                    )
                } else if filtered.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                } else {
                    List {
                        if showGroups {
                            ForEach(sections) { section in
                                Section(section.name, isExpanded: expansionBinding(for: section.id)) {
                                    ForEach(section.servers) { server in serverLink(server) }
                                }
                            }
                        } else {
                            ForEach(filtered) { server in serverLink(server) }
                        }
                    }
                }
            }
            .navigationTitle("ServerCase")
            .searchable(text: $searchText, prompt: "Search servers")
            .navigationDestination(for: ServerConfig.self) { server in
                DashboardView(server: server)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { addingNew = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $addingNew) {
                ServerFormView(existing: nil)
            }
            .sheet(item: $editing) { server in
                ServerFormView(existing: server)
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
        }
    }

    private var filtered: [ServerConfig] {
        ServerListLayout.filtered(model.servers, groups: model.settings.groups, query: searchText)
    }

    private var showGroups: Bool { !model.settings.groups.isEmpty }

    private var sections: [GroupSection] {
        ServerListLayout.sections(filtered, groups: model.settings.groups)
    }

    @ViewBuilder
    private func serverLink(_ server: ServerConfig) -> some View {
        Button {
            model.connectIfNeeded(server)
            path.append(server)
        } label: {
            ServerRow(server: server)
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            TapGesture(count: 2).onEnded {
                model.reconnect(server)
            }
        )
        .serverRowActions(server, model: model, editing: $editing)
    }

    private func expansionBinding(for sectionID: String) -> Binding<Bool> {
        Binding {
            !collapsedGroupIDs.contains(sectionID)
        } set: { isExpanded in
            if isExpanded {
                collapsedGroupIDs.remove(sectionID)
            } else {
                collapsedGroupIDs.insert(sectionID)
            }
        }
    }
}

struct ServerSplitView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedServerID: ServerConfig.ID?
    @State private var editing: ServerConfig?
    @State private var addingNew = false
    @State private var showingSettings = false
    @State private var searchText = ""
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var splitWidth: CGFloat = 0
    @State private var collapsedGroupIDs: Set<String> = []

    var body: some View {
        GeometryReader { proxy in
            NavigationSplitView(columnVisibility: $columnVisibility) {
                sidebar
                    .navigationTitle("ServerCase")
                    .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 380)
                    .searchable(text: $searchText, prompt: "Search servers")
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button { addingNew = true } label: { Image(systemName: "plus") }
                        }
                    }
            } detail: {
                if let selectedServer {
                    DashboardView(server: selectedServer)
                } else {
                    ContentUnavailableView(
                        "Select a server",
                        systemImage: "server.rack",
                        description: Text("Choose a server from the sidebar.")
                    )
                }
            }
            .navigationSplitViewStyle(.balanced)
            .onAppear {
                splitWidth = proxy.size.width
                updateColumnVisibility(for: proxy.size.width)
            }
            .onChange(of: proxy.size.width) { _, width in
                splitWidth = width
                updateColumnVisibility(for: width)
            }
        }
        .onChange(of: selectedServerID) { _, newValue in
            updateColumnVisibility(for: splitWidth)
            guard let server = model.servers.first(where: { $0.id == newValue }) else { return }
            model.connectIfNeeded(server)
        }
        .onChange(of: model.servers) { _, servers in
            guard let selectedServerID, !servers.contains(where: { $0.id == selectedServerID }) else { return }
            self.selectedServerID = nil
        }
        .sheet(isPresented: $addingNew) {
            ServerFormView(existing: nil)
        }
        .sheet(item: $editing) { server in
            ServerFormView(existing: server)
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
        }
    }

    @ViewBuilder
    private var sidebar: some View {
        if model.servers.isEmpty {
            ContentUnavailableView(
                "No servers",
                systemImage: "server.rack",
                description: Text("Tap + to add your first server.")
            )
        } else if filtered.isEmpty {
            ContentUnavailableView.search(text: searchText)
        } else {
            List(selection: $selectedServerID) {
                if showGroups {
                    ForEach(sections) { section in
                        Section(section.name, isExpanded: expansionBinding(for: section.id)) {
                            ForEach(section.servers) { server in row(server) }
                        }
                    }
                } else {
                    ForEach(filtered) { server in row(server) }
                }
            }
        }
    }

    private func updateColumnVisibility(for width: CGFloat) {
        guard width > 0 else { return }
        columnVisibility = selectedServerID == nil || width >= 1100 ? .all : .detailOnly
    }

    private var selectedServer: ServerConfig? {
        model.servers.first { $0.id == selectedServerID }
    }

    private var filtered: [ServerConfig] {
        ServerListLayout.filtered(model.servers, groups: model.settings.groups, query: searchText)
    }

    private var showGroups: Bool { !model.settings.groups.isEmpty }

    private var sections: [GroupSection] {
        ServerListLayout.sections(filtered, groups: model.settings.groups)
    }

    private func row(_ server: ServerConfig) -> some View {
        ServerRow(server: server)
            .tag(server.id)
            .simultaneousGesture(
                TapGesture(count: 2).onEnded {
                    model.reconnect(server)
                }
            )
            .serverRowActions(server, model: model, editing: $editing)
    }

    private func expansionBinding(for sectionID: String) -> Binding<Bool> {
        Binding {
            !collapsedGroupIDs.contains(sectionID)
        } set: { isExpanded in
            if isExpanded {
                collapsedGroupIDs.remove(sectionID)
            } else {
                collapsedGroupIDs.insert(sectionID)
            }
        }
    }
}

private struct GroupSection: Identifiable {
    let id: String
    let name: String
    let servers: [ServerConfig]
}

private enum ServerListLayout {
    static func filtered(_ servers: [ServerConfig], groups: [ServerGroup], query: String) -> [ServerConfig] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return servers }

        return servers.filter { server in
            let groupName = groups.first { $0.id == server.groupId }?.name ?? ""
            return server.name.localizedStandardContains(trimmed) ||
            server.host.localizedStandardContains(trimmed) ||
            server.username.localizedStandardContains(trimmed) ||
            groupName.localizedStandardContains(trimmed)
        }
    }

    static func sections(_ servers: [ServerConfig], groups: [ServerGroup]) -> [GroupSection] {
        let namedSections = groups.compactMap { group -> GroupSection? in
            let groupedServers = servers.filter { $0.groupId == group.id }
            guard !groupedServers.isEmpty else { return nil }
            return GroupSection(id: group.id, name: group.name, servers: groupedServers)
        }

        let ungroupedServers = servers.filter { server in
            guard let groupId = server.groupId else { return true }
            return !groups.contains { $0.id == groupId }
        }

        if ungroupedServers.isEmpty {
            return namedSections
        }

        return namedSections + [
            GroupSection(id: "__ungrouped__", name: "Ungrouped", servers: ungroupedServers)
        ]
    }
}

private struct ServerRow: View {
    @EnvironmentObject private var model: AppModel
    let server: ServerConfig

    var body: some View {
        HStack(spacing: 12) {
            StatusDot(state: model.state(server.id))

            VStack(alignment: .leading, spacing: 3) {
                Text(server.name)
                    .font(.headline)
                Text("\(server.username)@\(server.host):\(server.port)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(model.state(server.id).label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

private struct ServerRowActionsModifier: ViewModifier {
    let server: ServerConfig
    let model: AppModel
    @Binding var editing: ServerConfig?

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    model.delete(server)
                } label: {
                    Label("Delete", systemImage: "trash")
                }

                Button {
                    editing = server
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                .tint(Palette.accent)
            }
            .contextMenu {
                Button {
                    editing = server
                } label: {
                    Label("Edit", systemImage: "pencil")
                }

                Button {
                    model.reconnect(server)
                } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                }

                Button(role: .destructive) {
                    model.delete(server)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
    }
}

private extension View {
    func serverRowActions(
        _ server: ServerConfig,
        model: AppModel,
        editing: Binding<ServerConfig?>
    ) -> some View {
        modifier(ServerRowActionsModifier(server: server, model: model, editing: editing))
    }
}

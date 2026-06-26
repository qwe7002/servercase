import SwiftUI

/// Regular-width (iPad) layout: a persistent sidebar listing the servers next to
/// a detail pane showing the selected server's dashboard. Selecting a server
/// connects it (mirroring the iPhone tap behaviour) and shows it on the right.
struct ServerSplitView: View {
    @EnvironmentObject private var model: AppModel
    @State private var editing: ServerConfig?
    @State private var addingNew = false
    @State private var showingSettings = false
    @State private var searchText = ""
    @State private var selection: ServerConfig.ID?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    /// Suppresses the auto-connect for the one programmatic selection we make to
    /// populate the detail pane on launch; user taps still connect.
    @State private var pendingAutoSelect = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
                .navigationTitle("ServerCase")
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
            NavigationStack {
                if let server = selectedServer {
                    DashboardView(server: server)
                        .id(server.id)
                } else {
                    ContentUnavailableView(
                        "No server selected",
                        systemImage: "sidebar.left",
                        description: Text("Choose a server from the list to view its dashboard.")
                    )
                }
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
        .onChange(of: selection) { _, _ in
            if pendingAutoSelect {
                pendingAutoSelect = false
                return
            }
            if let server = selectedServer { model.connectIfNeeded(server) }
        }
        .onAppear { selectFirstIfNeeded() }
        .onChange(of: model.servers) { _, _ in
            // Drop a selection whose server was deleted, then re-fill the pane.
            if let id = selection, !model.servers.contains(where: { $0.id == id }) {
                selection = nil
            }
            selectFirstIfNeeded()
        }
    }

    /// Populates the detail pane with the first server when nothing is selected,
    /// so the iPad layout never shows an empty centered placeholder.
    private func selectFirstIfNeeded() {
        guard selection == nil, let first = filtered.first else { return }
        pendingAutoSelect = true
        selection = first.id
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
            List(selection: $selection) {
                if showGroups {
                    ForEach(sections) { section in
                        Section(section.name) {
                            ForEach(section.servers) { server in row(server) }
                        }
                    }
                } else {
                    ForEach(filtered) { server in row(server) }
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ server: ServerConfig) -> some View {
        ServerRow(server: server)
            .tag(server.id)
            .serverRowActions(server, model: model, editing: $editing)
    }

    private var selectedServer: ServerConfig? {
        guard let id = selection else { return nil }
        return model.servers.first { $0.id == id }
    }

    private var filtered: [ServerConfig] {
        ServerListLayout.filtered(model.servers, query: searchText)
    }

    private var showGroups: Bool { !model.settings.groups.isEmpty }

    private var sections: [GroupSection] {
        ServerListLayout.sections(filtered, groups: model.settings.groups)
    }
}

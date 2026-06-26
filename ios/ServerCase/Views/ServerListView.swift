import SwiftUI

/// Compact (iPhone) layout: a single navigation stack that pushes the dashboard
/// for the tapped server. The iPad layout lives in `ServerSplitView`.
struct ServerListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var editing: ServerConfig?
    @State private var addingNew = false
    @State private var showingSettings = false
    @State private var searchText = ""
    @State private var path: [ServerConfig] = []

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
                                Section(section.name) {
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
        ServerListLayout.filtered(model.servers, query: searchText)
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
        .serverRowActions(server, model: model, editing: $editing)
    }
}

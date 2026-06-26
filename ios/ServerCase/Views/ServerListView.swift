import SwiftUI

enum ServerListMode: String, CaseIterable {
    case all
    case groups
    var label: String { self == .all ? "All" : "Groups" }
}

private struct GroupSection: Identifiable {
    let id: String
    let name: String
    let servers: [ServerConfig]
}

struct ServerListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var editing: ServerConfig?
    @State private var addingNew = false
    @State private var showingSettings = false
    @State private var searchText = ""
    @State private var mode: ServerListMode = .all

    var body: some View {
        NavigationStack {
            Group {
                if model.servers.isEmpty {
                    ContentUnavailableView(
                        "No servers",
                        systemImage: "server.rack",
                        description: Text("Tap + to add your first server.")
                    )
                } else if filteredServers.isEmpty {
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
                            ForEach(filteredServers) { server in serverLink(server) }
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
                ToolbarItem(placement: .principal) {
                    Picker("View", selection: $mode) {
                        ForEach(ServerListMode.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 200)
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

    private var filteredServers: [ServerConfig] {
        let q = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return model.servers }
        return model.servers.filter {
            $0.name.lowercased().contains(q) ||
            $0.host.lowercased().contains(q) ||
            $0.username.lowercased().contains(q)
        }
    }

    private var showGroups: Bool {
        mode == .groups && searchText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var sections: [GroupSection] {
        var result: [GroupSection] = []
        for group in model.settings.groups {
            let items = filteredServers.filter { $0.groupId == group.id }
            if !items.isEmpty {
                result.append(GroupSection(id: group.id, name: group.name, servers: items))
            }
        }
        let ungrouped = filteredServers.filter { server in
            server.groupId == nil || !model.settings.groups.contains { $0.id == server.groupId }
        }
        if !ungrouped.isEmpty {
            result.append(GroupSection(id: "__ungrouped__", name: "Ungrouped", servers: ungrouped))
        }
        return result
    }

    @ViewBuilder
    private func serverLink(_ server: ServerConfig) -> some View {
        NavigationLink(value: server) {
            row(server)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { model.delete(server) } label: {
                Label("Delete", systemImage: "trash")
            }
            Button { editing = server } label: {
                Label("Edit", systemImage: "pencil")
            }.tint(.gray)
        }
    }

    private func row(_ server: ServerConfig) -> some View {
        HStack(spacing: 12) {
            StatusDot(state: model.state(server.id))
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name).font(.headline)
                Text("\(server.username)@\(server.host):\(server.port) · \(model.state(server.id).label)")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

import SwiftUI

struct ServerListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var editing: ServerConfig?
    @State private var addingNew = false
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if model.servers.isEmpty {
                    ContentUnavailableView(
                        "No servers",
                        systemImage: "server.rack",
                        description: Text("Tap + to add your first server.")
                    )
                } else {
                    List {
                        if hasGroups {
                            ForEach(grouped, id: \.name) { group in
                                Section(group.name.isEmpty ? "Ungrouped" : group.name) {
                                    ForEach(group.servers) { server in serverLink(server) }
                                }
                            }
                        } else {
                            ForEach(model.servers) { server in serverLink(server) }
                        }
                    }
                }
            }
            .navigationTitle("ServerCase")
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

    private var grouped: [(name: String, servers: [ServerConfig])] {
        var order: [String] = []
        var map: [String: [ServerConfig]] = [:]
        for s in model.servers {
            let g = (s.group?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 } ?? ""
            if map[g] == nil { order.append(g) }
            map[g, default: []].append(s)
        }
        return order.map { (name: $0, servers: map[$0]!) }
    }

    private var hasGroups: Bool { grouped.contains { !$0.name.isEmpty } }

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

import SwiftUI

struct ServerListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var editing: ServerConfig?
    @State private var addingNew = false

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
                        ForEach(model.servers) { server in
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
                    }
                }
            }
            .navigationTitle("ServerCase")
            .navigationDestination(for: ServerConfig.self) { server in
                DashboardView(server: server)
            }
            .toolbar {
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

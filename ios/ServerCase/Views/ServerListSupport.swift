import SwiftUI

/// A group/folder section of the server list. Shared by the iPhone list and the
/// iPad sidebar.
struct GroupSection: Identifiable {
    let id: String
    let name: String
    let servers: [ServerConfig]
}

/// Pure helpers for turning the raw server list into the filtered, grouped shape
/// both the compact (iPhone) and regular (iPad) layouts render.
enum ServerListLayout {
    /// Servers matching the search query (name / host / username).
    static func filtered(_ servers: [ServerConfig], query: String) -> [ServerConfig] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return servers }
        return servers.filter {
            $0.name.lowercased().contains(q) ||
            $0.host.lowercased().contains(q) ||
            $0.username.lowercased().contains(q)
        }
    }

    /// Groups the (already filtered) servers into sections, appending an
    /// "Ungrouped" trailer for servers with no — or a dangling — group id.
    static func sections(_ servers: [ServerConfig], groups: [ServerGroup]) -> [GroupSection] {
        var result: [GroupSection] = []
        for group in groups {
            let items = servers.filter { $0.groupId == group.id }
            if !items.isEmpty {
                result.append(GroupSection(id: group.id, name: group.name, servers: items))
            }
        }
        let ungrouped = servers.filter { server in
            server.groupId == nil || !groups.contains { $0.id == server.groupId }
        }
        if !ungrouped.isEmpty {
            result.append(GroupSection(id: "__ungrouped__", name: "Ungrouped", servers: ungrouped))
        }
        return result
    }
}

/// One server row: status dot, name, and the `user@host:port · state` subtitle.
struct ServerRow: View {
    @EnvironmentObject private var model: AppModel
    let server: ServerConfig

    var body: some View {
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

extension View {
    /// The context menu (disconnect / reconnect) and swipe actions (edit /
    /// delete) shared by every server row, on iPhone and iPad alike.
    func serverRowActions(_ server: ServerConfig,
                          model: AppModel,
                          editing: Binding<ServerConfig?>) -> some View {
        self
            .contextMenu {
                if model.state(server.id) == .connected || model.state(server.id) == .connecting {
                    Button(role: .destructive) {
                        model.disconnect(server.id)
                    } label: {
                        Label("Disconnect", systemImage: "xmark.circle")
                    }
                }
                Button {
                    model.reconnect(server)
                } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                }
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) { model.delete(server) } label: {
                    Label("Delete", systemImage: "trash")
                }
                Button { editing.wrappedValue = server } label: {
                    Label("Edit", systemImage: "pencil")
                }.tint(.gray)
            }
    }
}

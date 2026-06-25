import Foundation
import SwiftUI

/// App-wide observable state: the server list plus live connection state,
/// status and errors keyed by server id.
@MainActor
final class AppModel: ObservableObject {
    @Published var servers: [ServerConfig] = ServerStore.load()
    @Published var connState: [UUID: ConnectionState] = [:]
    @Published var status: [UUID: ServerStatus] = [:]

    private var services: [UUID: SSHService] = [:]
    private var collectors: [UUID: StatusParser.CollectorState] = [:]
    private var pollTask: Task<Void, Never>?

    // MARK: CRUD

    func upsert(_ server: ServerConfig) {
        if let idx = servers.firstIndex(where: { $0.id == server.id }) {
            servers[idx] = server
        } else {
            servers.append(server)
        }
        ServerStore.save(servers)
    }

    func delete(_ server: ServerConfig) {
        disconnect(server.id)
        servers.removeAll { $0.id == server.id }
        ServerStore.save(servers)
    }

    func state(_ id: UUID) -> ConnectionState { connState[id] ?? .disconnected }

    // MARK: Connection

    func connect(_ server: ServerConfig) {
        connState[server.id] = .connecting
        let service = SSHService(config: server)
        services[server.id] = service
        collectors[server.id] = StatusParser.CollectorState()
        Task {
            do {
                try await service.connect()
                connState[server.id] = .connected
            } catch {
                connState[server.id] = .error(error.localizedDescription)
                services[server.id] = nil
            }
        }
    }

    func disconnect(_ id: UUID) {
        if let service = services[id] {
            Task { await service.disconnect() }
        }
        services[id] = nil
        collectors[id] = nil
        connState[id] = .disconnected
    }

    func service(_ id: UUID) -> SSHService? { services[id] }

    // MARK: Status polling

    func startPolling(_ id: UUID) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollOnce(id)
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollOnce(_ id: UUID) async {
        guard let service = services[id] else { return }
        let collector = collectors[id] ?? StatusParser.CollectorState()
        collectors[id] = collector
        do {
            let raw = try await service.run(StatusParser.statusCommand)
            status[id] = StatusParser.parse(raw, state: collector)
        } catch {
            // Transient; surfaced via connection state if the socket drops.
        }
    }
}

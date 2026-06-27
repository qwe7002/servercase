import Foundation
import SwiftUI

/// App-wide observable state: the server list plus live connection state,
/// status and errors keyed by server id, and the global settings (Bitwarden
/// keychain, snippets, auto-sync).
@MainActor
final class AppModel: ObservableObject {
    @Published var servers: [ServerConfig] = ServerStore.load()
    @Published var connState: [UUID: ConnectionState] = [:]
    @Published var status: [UUID: ServerStatus] = [:]
    @Published var settings: GlobalSettings = SettingsStore.load()
    @Published var bitwardenStatus: BitwardenStatus?

    let vault = BitwardenVault()

    private var services: [UUID: SSHService] = [:]
    private var collectors: [UUID: StatusParser.CollectorState] = [:]
    private var connectionTokens: [UUID: UUID] = [:]
    private var pollTask: Task<Void, Never>?
    private var autoSyncTask: Task<Void, Never>?

    private let liveActivity = LiveActivityManager.shared
    private let background = BackgroundManager()
    /// Server whose connection currently drives the Live Activity, if any.
    private var trackedServerId: UUID?

    init() {
        let bw = settings.bitwarden
        Task { await vault.configure(bw) }
        restartAutoSync()
        background.registerTasks { [weak self] in await self?.backgroundRefresh() }
    }

    private var vaultEnabled: Bool { settings.bitwarden.enabled }

    // MARK: CRUD

    func upsert(_ server: ServerConfig) {
        if let idx = servers.firstIndex(where: { $0.id == server.id }) {
            servers[idx] = server
        } else {
            servers.append(server)
        }
        saveServers()
        if vaultEnabled {
            Task { try? await vault.setSecrets(server.id.uuidString, server.secrets) }
        }
    }

    func delete(_ server: ServerConfig) {
        disconnect(server.id)
        servers.removeAll { $0.id == server.id }
        saveServers()
        if vaultEnabled {
            Task { try? await vault.deleteSecrets(server.id.uuidString) }
        }
    }

    func state(_ id: UUID) -> ConnectionState { connState[id] ?? .disconnected }

    /// Persists the server list, stripping secrets when the vault owns them.
    private func saveServers() {
        ServerStore.save(vaultEnabled ? servers.map { $0.strippingSecrets() } : servers)
    }

    // MARK: Connection

    func connectIfNeeded(_ server: ServerConfig) {
        switch state(server.id) {
        case .connected, .connecting:
            return
        case .disconnected, .error:
            connect(server)
        }
    }

    func reconnect(_ server: ServerConfig) {
        disconnect(server.id)
        connect(server)
    }

    func connect(_ server: ServerConfig) {
        let token = UUID()
        connectionTokens[server.id] = token
        connState[server.id] = .connecting
        Task {
            syncLiveActivity(server.id)
            var cfg = server
            if vaultEnabled, server.password == nil, server.privateKey == nil,
               let secrets = try? await vault.getSecrets(server.id.uuidString) {
                cfg = server.merging(secrets)
            }
            let service = SSHService(config: cfg)
            services[server.id] = service
            collectors[server.id] = StatusParser.CollectorState()
            do {
                try await service.connect()
                guard connectionTokens[server.id] == token else {
                    await service.disconnect()
                    return
                }
                connState[server.id] = .connected
            } catch {
                guard connectionTokens[server.id] == token else { return }
                connState[server.id] = .error(error.localizedDescription)
                services[server.id] = nil
            }
            syncLiveActivity(server.id)
        }
    }

    func disconnect(_ id: UUID) {
        connectionTokens[id] = nil
        if let service = services[id] {
            Task { await service.disconnect() }
        }
        services[id] = nil
        collectors[id] = nil
        connState[id] = .disconnected
        syncLiveActivity(id)
    }

    func service(_ id: UUID) -> SSHService? { services[id] }

    // MARK: Status polling

    func startPolling(_ id: UUID) {
        pollTask?.cancel()
        // The polled server becomes the one shown in the Live Activity.
        trackedServerId = id
        syncLiveActivity(id)
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
        if trackedServerId != nil {
            liveActivity.end()
            trackedServerId = nil
        }
    }

    private func pollOnce(_ id: UUID) async {
        guard let service = services[id] else { return }
        let collector = collectors[id] ?? StatusParser.CollectorState()
        collectors[id] = collector
        do {
            let raw = try await service.run(StatusParser.statusCommand)
            status[id] = StatusParser.parse(raw, state: collector)
            syncLiveActivity(id)
        } catch {
            // Transient; surfaced via connection state if the socket drops.
        }
    }

    // MARK: Live Activity + background

    /// Pushes the current connection state and performance numbers to the Live
    /// Activity, when `id` is the tracked server. Idempotent: starts the
    /// activity if needed, otherwise updates the running one.
    private func syncLiveActivity(_ id: UUID) {
        guard id == trackedServerId,
              let server = servers.first(where: { $0.id == id }) else { return }
        liveActivity.start(server: server, state: activityState(id))
    }

    private func activityState(_ id: UUID) -> ServerActivityAttributes.State {
        let s = status[id]
        return ServerActivityAttributes.State(
            phase: activityPhase(for: state(id)),
            cpuUsage: s?.cpuUsage,
            memPercent: s?.memPercent ?? 0,
            memUsedKb: s?.memUsedKb ?? 0,
            memTotalKb: s?.memTotalKb ?? 0,
            netRxBytesPerSec: s?.netRxBytesPerSec,
            netTxBytesPerSec: s?.netTxBytesPerSec,
            loadOne: s?.loadAvg.0 ?? 0,
            uptimeSec: s?.uptimeSec ?? 0,
            updatedAt: Date()
        )
    }

    private func activityPhase(for state: ConnectionState) -> ServerActivityAttributes.State.Phase {
        switch state {
        case .connected: return .connected
        case .connecting: return .connecting
        case .disconnected: return .disconnected
        case .error: return .error
        }
    }

    /// Reacts to app lifecycle changes: extend execution on background and
    /// schedule a refresh; release the assertion on return to foreground.
    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            guard trackedServerId != nil else { return }
            background.beginAssertion()
            background.scheduleRefresh()
        case .active:
            background.endAssertion()
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    /// Invoked from a `BGAppRefreshTask`: reconnect if needed, take one sample
    /// and refresh the Live Activity, all within the system-granted window.
    func backgroundRefresh() async {
        guard let id = trackedServerId,
              let server = servers.first(where: { $0.id == id }) else { return }
        if services[id] == nil {
            connect(server) // connect() assigns a fresh connection token itself
            // Give the handshake a brief moment before sampling.
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
        await pollOnce(id)
        syncLiveActivity(id)
    }

    // MARK: Settings

    func updateSettings(_ new: GlobalSettings) {
        settings = new
        SettingsStore.save(new)
        let bw = new.bitwarden
        Task { await vault.configure(bw) }
        // Re-persist so secrets are stripped (vault on) or restored (vault off).
        saveServers()
        restartAutoSync()
    }

    func setBitwardenEnabled(_ enabled: Bool) {
        var next = settings
        next.bitwarden.enabled = enabled
        updateSettings(next)
    }

    // MARK: Bitwarden vault

    func refreshBitwardenStatus() async {
        await vault.configure(settings.bitwarden)
        bitwardenStatus = await vault.status()
    }

    func unlockVault(_ masterPassword: String) async throws {
        let status = try await vault.unlock(masterPassword)
        bitwardenStatus = status
        if status.state == .unlocked { await loadSecretsFromVault() }
    }

    func lockVault() async {
        try? await vault.lock()
        await refreshBitwardenStatus()
    }

    func loadSecretsFromVault() async {
        guard let all = try? await vault.listSecrets() else { return }
        for i in servers.indices {
            if let s = all[servers[i].id.uuidString] {
                servers[i] = servers[i].merging(s)
            }
        }
    }

    func pushAllSecretsToVault() async throws {
        for s in servers { try await vault.setSecrets(s.id.uuidString, s.secrets) }
        try? await vault.sync()
        saveServers()
    }

    func testVault() async throws -> String {
        try await vault.test()
    }

    // MARK: Auto-sync

    private func restartAutoSync() {
        autoSyncTask?.cancel()
        guard settings.autoSync.enabled else { return }
        let minutes = max(1, settings.autoSync.intervalMinutes)
        autoSyncTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(minutes) * 60_000_000_000)
                if Task.isCancelled { break }
                self?.syncToAutoFile()
            }
        }
    }

    @discardableResult
    func syncToAutoFile() -> Bool {
        let payload = SyncService.makePayload(servers: servers, settings: settings)
        guard let data = try? SyncService.encode(payload),
              (try? data.write(to: SyncService.autoSyncURL)) != nil else { return false }
        settings.autoSync.lastSyncedAt = Date()
        SettingsStore.save(settings)
        return true
    }

    /// Secret-free snapshot for manual export via the document picker.
    func exportData() throws -> Data {
        try SyncService.encode(SyncService.makePayload(servers: servers, settings: settings))
    }

    func importData(_ data: Data) throws {
        let payload = try SyncService.decode(data)
        servers = payload.servers
        updateSettings(payload.settings)
    }
}

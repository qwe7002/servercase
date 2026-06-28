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
    @Published var cloudSession: CloudSession? = CloudSessionStore.load()
    @Published var probeHosts: [ProbeHost] = []

    let vault = BitwardenVault()
    private let cloud = CloudService()

    private var services: [UUID: SSHService] = [:]
    private var collectors: [UUID: StatusParser.CollectorState] = [:]
    private var connectionTokens: [UUID: UUID] = [:]
    private var pollTask: Task<Void, Never>?
    private var cloudPushTask: Task<Void, Never>?
    private var probeStreamTask: URLSessionWebSocketTask?
    private var probeStreamLoop: Task<Void, Never>?
    /// Set while applying a pulled snapshot, to suppress the auto-push echo.
    private var applyingRemote = false
    /// The FCM token we've already registered, to avoid repeats.
    private var registeredPushToken: String?

    init() {
        let bw = settings.bitwarden
        Task { await vault.configure(bw) }
        // Register the FCM token with the worker whenever it's (re)issued.
        NotificationCenter.default.addObserver(forName: .fcmTokenReceived, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.registerPushToken() }
        }
        startProbeStream()
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
        scheduleCloudAutoPush()
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
    }

    func service(_ id: UUID) -> SSHService? { services[id] }

    private func connectedService(for server: ServerConfig) async throws -> SSHService {
        if let service = services[server.id], await service.isConnected {
            return service
        }

        var cfg = server
        if vaultEnabled, server.password == nil, server.privateKey == nil,
           let secrets = try? await vault.getSecrets(server.id.uuidString) {
            cfg = server.merging(secrets)
        }

        let service = SSHService(config: cfg)
        services[server.id] = service
        collectors[server.id] = StatusParser.CollectorState()
        connState[server.id] = .connecting
        do {
            try await service.connect()
            connState[server.id] = .connected
            return service
        } catch {
            services[server.id] = nil
            connState[server.id] = .error(error.localizedDescription)
            throw error
        }
    }

    // MARK: Status polling

    func startPolling(_ id: UUID) {
        pollTask?.cancel()
        if servers.first(where: { $0.id == id })?.probeHostId != nil {
            startProbeStream()
            return
        }
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

    // MARK: Settings

    func updateSettings(_ new: GlobalSettings) {
        let oldCloud = settings.cloud
        settings = new
        SettingsStore.save(new)
        let bw = new.bitwarden
        Task { await vault.configure(bw) }
        // Re-persist so secrets are stripped (vault on) or restored (vault off).
        saveServers()
        if oldCloud != new.cloud {
            restartProbeStream()
        }
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
        await vault.lock()
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

    // MARK: Cloud sync

    var cloudSignedIn: Bool { cloudSession?.isValid == true }

    /// Logs in (or registers) and stores the session locally.
    func cloudAuthenticate(register: Bool, email: String, password: String) async throws {
        let url = settings.cloud.url
        let result = register
            ? try await cloud.register(url: url, email: email, password: password)
            : try await cloud.login(url: url, email: email, password: password)
        let session = CloudSession(token: result.token, expiresAt: result.expiresAt, user: result.user)
        cloudSession = session
        CloudSessionStore.save(session)
        var next = settings
        next.cloud.email = result.user.email
        updateSettings(next)
        registerPushToken()
        await refreshProbes()
        startProbeStream()
    }

    /// Registers the current FCM token with the worker once signed in (idempotent).
    func registerPushToken() {
        guard settings.cloud.enabled, !settings.cloud.url.isEmpty,
              let token = PushToken.current, token != registeredPushToken,
              let session = cloudSession, session.isValid else { return }
        Task {
            do {
                try await cloud.registerDevice(url: settings.cloud.url, sessionToken: session.token, fcmToken: token)
                registeredPushToken = token
            } catch {
                // best-effort; retried on the next token refresh or sign-in
            }
        }
    }

    /// Pushes the local config to the cloud. Returns the new revision.
    @discardableResult
    func cloudPushNow() async throws -> Int {
        guard let session = cloudSession, session.isValid else {
            throw CloudError(status: 401, message: "Sign in to ServerCase Cloud first")
        }
        let payload = SyncService.makePayload(servers: servers, settings: settings)
        let result = try await cloud.putSync(url: settings.cloud.url, token: session.token,
                                             payload: payload, baseVersion: session.syncVersion)
        updateCloudSyncState(session, version: result.version, at: result.updatedAt)
        return result.version
    }

    /// Pulls the cloud config and replaces local servers + settings.
    func cloudPull() async throws {
        guard let session = cloudSession, session.isValid else {
            throw CloudError(status: 401, message: "Sign in to ServerCase Cloud first")
        }
        let result = try await cloud.getSync(url: settings.cloud.url, token: session.token)
        applyingRemote = true
        servers = result.payload.servers
        updateSettings(result.payload.settings)
        applyingRemote = false
        updateCloudSyncState(session, version: result.version, at: result.updatedAt)
        startProbeStream()
    }

    func cloudSignOut() {
        cloudSession = nil
        probeHosts = []
        stopProbeStream()
        CloudSessionStore.save(nil)
    }

    // MARK: Probe hosts

    func probeHost(for server: ServerConfig) -> ProbeHost? {
        guard let id = server.probeHostId else { return nil }
        return probeHosts.first { $0.id == id }
    }

    func probeStatus(for server: ServerConfig) -> ServerStatus? {
        probeHost(for: server)?.latest?.serverStatus
    }

    func refreshProbes() async {
        guard settings.cloud.enabled, !settings.cloud.url.isEmpty,
              let session = cloudSession, session.isValid else { return }
        do {
            probeHosts = try await cloud.listProbes(url: settings.cloud.url, token: session.token).hosts
        } catch {
            // Best-effort; the settings page surfaces explicit create/delete errors.
        }
    }

    func startProbeStream() {
        guard settings.cloud.enabled, !settings.cloud.url.isEmpty,
              let session = cloudSession, session.isValid else {
            stopProbeStream()
            return
        }
        if probeStreamTask != nil { return }

        Task { await refreshProbes() }

        do {
            let url = try cloud.probeStreamURL(baseURL: settings.cloud.url, token: session.token)
            let task = URLSession.shared.webSocketTask(with: url)
            probeStreamTask = task
            task.resume()
            probeStreamLoop = Task { [weak self, weak task] in
                guard let task else { return }
                await self?.receiveProbeStream(task)
            }
        } catch {
            // The settings page surfaces explicit cloud errors; stream startup is best-effort.
        }
    }

    func stopProbeStream() {
        probeStreamLoop?.cancel()
        probeStreamLoop = nil
        probeStreamTask?.cancel(with: .goingAway, reason: nil)
        probeStreamTask = nil
    }

    private func restartProbeStream() {
        stopProbeStream()
        startProbeStream()
    }

    private func receiveProbeStream(_ task: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    handleProbeStreamMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        handleProbeStreamMessage(text)
                    }
                @unknown default:
                    break
                }
            } catch {
                if !Task.isCancelled {
                    probeStreamTask = nil
                    probeStreamLoop = nil
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    startProbeStream()
                }
                return
            }
        }
    }

    private func handleProbeStreamMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? CloudService.decoder.decode(ProbeStreamMessage.self, from: data),
              message.type == "snapshot",
              let hostId = message.hostId,
              let snapshot = message.snapshot else { return }
        upsertProbeSnapshot(hostId: hostId, at: message.at, snapshot: snapshot)
    }

    private func upsertProbeSnapshot(hostId: String, at: Date?, snapshot: ProbeSnapshot) {
        if let index = probeHosts.firstIndex(where: { $0.id == hostId }) {
            probeHosts[index].latest = snapshot
            probeHosts[index].lastSeenAt = at ?? Date()
        } else {
            probeHosts.append(
                ProbeHost(
                    id: hostId,
                    name: snapshot.hostname.isEmpty ? hostId : snapshot.hostname,
                    createdAt: Date(),
                    lastSeenAt: at ?? Date(),
                    latest: snapshot
                )
            )
        }
    }

    func createProbe(name: String) async throws -> ProbeCreateResult {
        guard let session = cloudSession, session.isValid else {
            throw CloudError(status: 401, message: "Sign in to ServerCase Cloud first")
        }
        let result = try await cloud.createProbe(url: settings.cloud.url, token: session.token, name: name)
        await refreshProbes()
        return result
    }

    func deleteProbe(_ host: ProbeHost) async throws {
        guard let session = cloudSession, session.isValid else {
            throw CloudError(status: 401, message: "Sign in to ServerCase Cloud first")
        }
        try await cloud.deleteProbe(url: settings.cloud.url, token: session.token, id: host.id)
        probeHosts.removeAll { $0.id == host.id }
        for i in servers.indices where servers[i].probeHostId == host.id {
            servers[i].probeHostId = nil
        }
        saveServers()
    }

    func installProbe(hostId: String, token: String, on server: ServerConfig) async throws -> String {
        let service = try await connectedService(for: server)
        let output = try await service.run(probeInstallCommand(apiURL: settings.cloud.url, token: token))
        if let index = servers.firstIndex(where: { $0.id == server.id }) {
            servers[index].probeHostId = hostId
            saveServers()
        }
        await refreshProbes()
        startProbeStream()
        return output
    }

    private func updateCloudSyncState(_ session: CloudSession, version: Int, at: Date) {
        var updated = session
        updated.syncVersion = version
        updated.syncedAt = at
        cloudSession = updated
        CloudSessionStore.save(updated)
    }

    /// Debounced auto-push after local changes, when enabled and signed in.
    private func scheduleCloudAutoPush() {
        guard !applyingRemote, settings.cloud.enabled, settings.cloud.autoPush,
              cloudSession?.isValid == true else { return }
        cloudPushTask?.cancel()
        cloudPushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return }
            guard let self else { return }
            _ = try? await self.cloudPushNow()
        }
    }
}

private let probeInstallScriptURL = "https://raw.githubusercontent.com/qwe7002/servercase/main/probe/deploy/install.sh"

private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

private func probeInstallCommand(apiURL: String, token: String) -> String {
    [
        "set -e",
        "tmp=\"$(mktemp)\"",
        "if command -v curl >/dev/null 2>&1; then curl -fsSL \(shellQuote(probeInstallScriptURL)) -o \"$tmp\"; elif command -v wget >/dev/null 2>&1; then wget -O \"$tmp\" \(shellQuote(probeInstallScriptURL)); else echo \"need curl or wget\"; exit 1; fi",
        "chmod 700 \"$tmp\"",
        "bash \"$tmp\" --user-service --api \(shellQuote(apiURL)) --token \(shellQuote(token)) --interval 10 --public-ip",
        "rm -f \"$tmp\"",
    ].joined(separator: "; ")
}

import Foundation

/// A reusable shell command, runnable in any server's terminal.
struct Snippet: Identifiable, Codable, Equatable, Hashable {
    var id: UUID = UUID()
    var name: String
    var command: String
}

/// Periodic export/import of the configuration to a JSON file.
struct AutoSyncSettings: Codable, Equatable {
    var enabled: Bool = false
    var intervalMinutes: Int = 30
    var lastSyncedAt: Date? = nil
}

/// Bitwarden keychain configuration. On iOS we talk to the Bitwarden CLI's
/// REST bridge (`bw serve`) over HTTP rather than shelling out to the CLI, so
/// the only thing we need is the base URL of that bridge.
struct BitwardenSettings: Codable, Equatable {
    var enabled: Bool = false
    /// Base URL of a running `bw serve`, e.g. http://127.0.0.1:8087
    var serverUrl: String = ""
    /// Name prefix for vault items owned by ServerCase.
    var itemPrefix: String = "ServerCase/"
}

/// All global, cross-server settings.
struct GlobalSettings: Codable, Equatable {
    var bitwarden = BitwardenSettings()
    var snippets: [Snippet] = []
    var autoSync = AutoSyncSettings()
}

/// The login credentials for a server. Stored in Bitwarden when the vault is
/// enabled, otherwise persisted locally with the server definition.
struct ServerSecrets: Codable, Equatable {
    var username: String?
    var password: String?
    var privateKey: String?
    var passphrase: String?
}

extension ServerConfig {
    var secrets: ServerSecrets {
        ServerSecrets(username: username, password: password,
                      privateKey: privateKey, passphrase: passphrase)
    }

    /// A copy with all sensitive fields cleared, for local persistence and the
    /// sync file when the Bitwarden vault owns the secrets.
    func strippingSecrets() -> ServerConfig {
        var copy = self
        copy.password = nil
        copy.privateKey = nil
        copy.passphrase = nil
        return copy
    }

    /// A copy with the given secrets merged in.
    func merging(_ s: ServerSecrets) -> ServerConfig {
        var copy = self
        if let v = s.password { copy.password = v }
        if let v = s.privateKey { copy.privateKey = v }
        if let v = s.passphrase { copy.passphrase = v }
        return copy
    }
}

/// Snapshot exchanged with the sync file. Secrets are deliberately excluded:
/// with Bitwarden they sync through the vault, and without it they are
/// intentionally not portable.
struct SyncPayload: Codable {
    var version = 1
    var exportedAt = Date()
    var servers: [ServerConfig]
    var settings: GlobalSettings
}

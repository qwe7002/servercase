import Foundation

/// A reusable shell command, runnable in any server's terminal.
struct Snippet: Identifiable, Codable, Equatable, Hashable {
    var id: UUID = UUID()
    var name: String
    var command: String
}

/// A named group/folder used to organize the server list.
/// (Named `ServerGroup` to avoid clashing with SwiftUI's `Group` view.)
struct ServerGroup: Identifiable, Codable, Equatable, Hashable {
    var id: String = UUID().uuidString
    var name: String
}

/// Optional connection to a ServerCase Worker for cloud config sync. The
/// session token is not stored here — it lives in `CloudSessionStore` and is
/// never written to the synced payload. Only the non-secret URL/email/
/// preferences live in settings, so they sync across devices.
struct CloudSettings: Codable, Equatable {
    var enabled: Bool = false
    /// Base URL of the worker, e.g. https://worker.example.com
    var url: String = ""
    /// Account email — display and login convenience (not a secret).
    var email: String = ""
    /// Push the config to the cloud automatically after local changes.
    var autoPush: Bool = false
}

/// Bitwarden keychain configuration. We speak the Bitwarden REST API directly
/// (clean-room crypto, no `bw` CLI), authenticating with a personal API key.
struct BitwardenSettings: Codable, Equatable {
    var enabled: Bool = false
    /// Base URL of the server; empty means the official cloud. For
    /// self-hosted/Vaultwarden set the base URL (`/identity` and `/api` are
    /// appended).
    var serverUrl: String = ""
    /// Account email — used as the KDF salt and for prelogin.
    var email: String = ""
    /// Personal API key client_id ("user.<guid>").
    var clientId: String = ""
    /// Personal API key client_secret. Redacted from the sync file.
    var clientSecret: String = ""
    /// Name prefix for vault items owned by ServerCase.
    var itemPrefix: String = "ServerCase/"
}

/// All global, cross-server settings.
struct GlobalSettings: Codable, Equatable {
    var bitwarden = BitwardenSettings()
    var snippets: [Snippet] = []
    var cloud = CloudSettings()
    var groups: [ServerGroup] = []
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

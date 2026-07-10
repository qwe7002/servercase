import Foundation

/// A reusable shell command, runnable in any server's terminal.
struct Snippet: Identifiable, Codable, Equatable, Hashable {
    var id: String = UUID().uuidString
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

enum BitwardenAuthMode: String, Codable, CaseIterable, Identifiable {
    case password
    case apiKey

    var id: String { rawValue }

    var label: String {
        switch self {
        case .apiKey: return "API key"
        case .password: return "Password"
        }
    }
}

/// Bitwarden keychain configuration. We speak the Bitwarden REST API directly
/// (clean-room crypto, no `bw` CLI), authenticating with either a personal API
/// key or a client-side master password hash.
struct BitwardenFolderOption: Identifiable, Equatable {
    var id: String
    var name: String
}

struct BitwardenSettings: Codable, Equatable {
    var enabled: Bool = false
    var authMode: BitwardenAuthMode = .password
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
    /// Folder name for vault items owned by ServerCase.
    var itemPrefix: String = "ServerCase"

    init() {}

    enum CodingKeys: String, CodingKey {
        case enabled
        case authMode
        case serverUrl
        case email
        case clientId
        case clientSecret
        case itemPrefix
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        authMode = try container.decodeIfPresent(BitwardenAuthMode.self, forKey: .authMode) ?? .password
        serverUrl = try container.decodeIfPresent(String.self, forKey: .serverUrl) ?? ""
        email = try container.decodeIfPresent(String.self, forKey: .email) ?? ""
        clientId = try container.decodeIfPresent(String.self, forKey: .clientId) ?? ""
        clientSecret = try container.decodeIfPresent(String.self, forKey: .clientSecret) ?? ""
        itemPrefix = try container.decodeIfPresent(String.self, forKey: .itemPrefix) ?? "ServerCase"
    }
}

enum TerminalCursorStyle: String, Codable, CaseIterable, Identifiable {
    case block, underline, bar
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

enum TerminalColorScheme: String, Codable, CaseIterable, Identifiable {
    case charcoal, black, light, solarized
    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    /// Background/foreground hex, shared with the desktop and Android clients.
    var backgroundHex: String {
        switch self {
        case .charcoal: return "0b0d12"
        case .black: return "000000"
        case .light: return "f5f5f5"
        case .solarized: return "002b36"
        }
    }
    var foregroundHex: String {
        switch self {
        case .charcoal: return "d6dbe5"
        case .black: return "e5e5e5"
        case .light: return "1c1c1c"
        case .solarized: return "93a1a1"
        }
    }
}

/// Appearance/behaviour of the SSH terminal, shared across servers and synced.
struct TerminalSettings: Codable, Equatable {
    var fontSize: Int = 13
    var cursorBlink: Bool = true
    var cursorStyle: TerminalCursorStyle = .block
    var scrollback: Int = 1000
    var colorScheme: TerminalColorScheme = .charcoal
}

/// All global, cross-server settings.
struct GlobalSettings: Codable, Equatable {
    var bitwarden = BitwardenSettings()
    var snippets: [Snippet] = []
    var cloud = CloudSettings()
    var terminal = TerminalSettings()
    var groups: [ServerGroup] = []
}

/// The login credentials for a server. Stored in Bitwarden when the vault is
/// enabled, otherwise persisted locally with the server definition.
struct ServerSecrets: Codable, Equatable {
    var username: String?
    var password: String?
    var privateKey: String?
    var passphrase: String?
    var sshKeyItemName: String?

    var hasCredentialMaterial: Bool {
        password?.isEmpty == false || privateKey?.isEmpty == false || sshKeyItemName?.isEmpty == false
    }
}

struct BitwardenSelectableItem: Identifiable, Equatable {
    var name: String
    var secrets: ServerSecrets

    var id: String { name }
    var hasPassword: Bool { secrets.password?.isEmpty == false }
    var hasPrivateKey: Bool { secrets.privateKey?.isEmpty == false }
    var username: String { secrets.username ?? "" }
}

extension ServerConfig {
    var secrets: ServerSecrets {
        ServerSecrets(username: username, password: password,
                      privateKey: privateKey, passphrase: passphrase)
    }

    var vaultItemName: String {
        if let explicit = bitwardenItemName?.trimmingCharacters(in: .whitespacesAndNewlines), !explicit.isEmpty {
            return explicit
        }
        let displayName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !displayName.isEmpty { return displayName }
        let hostName = host.trimmingCharacters(in: .whitespacesAndNewlines)
        return hostName.isEmpty ? id : hostName
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
        if let v = s.username { copy.username = v }
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

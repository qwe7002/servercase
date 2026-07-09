import Foundation

enum AuthType: String, Codable, CaseIterable, Identifiable {
    case password
    case key
    var id: String { rawValue }
    var label: String { self == .password ? "Password" : "Private key" }
}

struct ServerConfig: Identifiable, Codable, Equatable, Hashable {
    var id: String = UUID().uuidString
    var name: String
    var host: String
    var port: Int = 22
    var username: String = "root"
    /// User-facing Bitwarden/Vaultwarden login item name. The item lives inside
    /// the configured ServerCase folder and can be shared by multiple servers.
    var bitwardenItemName: String? = nil
    /// Id of the `Group` this server belongs to, if any.
    var groupId: String? = nil
    /// Cloud probe host id to use for overview status instead of SSH polling.
    var probeHostId: String? = nil
    var authType: AuthType = .password
    var password: String? = nil
    /// PEM private key text when `authType == .key`.
    var privateKey: String? = nil
    var passphrase: String? = nil
}

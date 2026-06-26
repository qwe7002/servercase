import Foundation

enum AuthType: String, Codable, CaseIterable, Identifiable {
    case password
    case key
    var id: String { rawValue }
    var label: String { self == .password ? "Password" : "Private key" }
}

struct ServerConfig: Identifiable, Codable, Equatable, Hashable {
    var id: UUID = UUID()
    var name: String
    var host: String
    var port: Int = 22
    var username: String = "root"
    /// Id of the `Group` this server belongs to, if any.
    var groupId: String? = nil
    var authType: AuthType = .password
    var password: String? = nil
    /// PEM private key text when `authType == .key`.
    var privateKey: String? = nil
    var passphrase: String? = nil
}

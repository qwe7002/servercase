import Foundation

/// Builds the secret-free configuration snapshot uploaded to the cloud.
enum SyncService {
    static func makePayload(servers: [ServerConfig], settings: GlobalSettings) -> SyncPayload {
        // The Bitwarden API key is a secret; never upload it.
        var redacted = settings
        redacted.bitwarden.clientId = ""
        redacted.bitwarden.clientSecret = ""
        return SyncPayload(servers: servers.map { $0.strippingSecrets() }, settings: redacted)
    }
}

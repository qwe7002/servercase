import Foundation

/// Encodes/decodes the secret-free configuration snapshot used by auto-sync and
/// manual export/import.
enum SyncService {
    /// File used by automatic background sync, inside the app's Documents dir.
    static var autoSyncURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("servercase-sync.json")
    }

    static func makePayload(servers: [ServerConfig], settings: GlobalSettings) -> SyncPayload {
        // The Bitwarden API key is a secret; never write it to the sync file.
        var redacted = settings
        redacted.bitwarden.clientId = ""
        redacted.bitwarden.clientSecret = ""
        return SyncPayload(servers: servers.map { $0.strippingSecrets() }, settings: redacted)
    }

    static func encode(_ payload: SyncPayload) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(payload)
    }

    static func decode(_ data: Data) throws -> SyncPayload {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(SyncPayload.self, from: data)
    }
}

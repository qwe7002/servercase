import Foundation

/// The cloud account identity returned by the worker.
struct CloudUser: Codable, Equatable {
    var id: String
    var email: String
}

/// Local-only cloud session: the worker session token and last-synced revision.
/// Kept out of `GlobalSettings` so the token is never part of the synced
/// payload — it stays on this device, like an SSH secret without Bitwarden.
struct CloudSession: Codable, Equatable {
    var token: String
    var expiresAt: Date
    var user: CloudUser
    var syncVersion: Int?
    var syncedAt: Date?

    var isValid: Bool { expiresAt > Date() }
}

/// Persists the cloud session in UserDefaults under a key separate from the
/// settings blob.
enum CloudSessionStore {
    private static let key = "servercase.cloud"

    static func load() -> CloudSession? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(CloudSession.self, from: data)
    }

    static func save(_ session: CloudSession?) {
        if let session, let data = try? JSONEncoder().encode(session) {
            UserDefaults.standard.set(data, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}

import Foundation

/// Persists the user's server list as JSON in UserDefaults. Secrets stay
/// on-device. (A production build should move secrets into the Keychain.)
enum ServerStore {
    private static let key = "servercase.servers"

    static func load() -> [ServerConfig] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([ServerConfig].self, from: data)) ?? []
    }

    static func save(_ servers: [ServerConfig]) {
        if let data = try? JSONEncoder().encode(servers) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}

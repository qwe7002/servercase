import Foundation

/// Persists `GlobalSettings` as JSON in UserDefaults.
enum SettingsStore {
    private static let key = "servercase.settings"

    static func load() -> GlobalSettings {
        guard let data = UserDefaults.standard.data(forKey: key) else {
            return GlobalSettings()
        }
        return (try? JSONDecoder().decode(GlobalSettings.self, from: data)) ?? GlobalSettings()
    }

    static func save(_ settings: GlobalSettings) {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}

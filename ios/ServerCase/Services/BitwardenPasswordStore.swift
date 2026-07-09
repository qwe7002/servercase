import Foundation
import Security

enum BitwardenPasswordStore {
    private static let service = "dev.qwe7002.servercase.bitwarden.master-password"

    static func load(for settings: BitwardenSettings) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: settings),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ password: String, for settings: BitwardenSettings) {
        let account = account(for: settings)
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        var item = baseQuery
        item[kSecValueData as String] = Data(password.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    private static func account(for settings: BitwardenSettings) -> String {
        let email = settings.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return "\(normalizedServerURL(settings.serverUrl))|\(email)"
    }

    private static func normalizedServerURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard !trimmed.isEmpty else { return "https://bitwarden.com" }
        if trimmed.range(of: "http://", options: [.anchored, .caseInsensitive]) != nil ||
            trimmed.range(of: "https://", options: [.anchored, .caseInsensitive]) != nil {
            return trimmed.lowercased()
        }
        return "https://\(trimmed.lowercased())"
    }
}

import Foundation

enum BitwardenLockState: String, Codable {
    case unauthenticated
    case locked
    case unlocked
}

struct BitwardenStatus: Equatable {
    var available: Bool
    var state: BitwardenLockState
    var serverUrl: String?
    var userEmail: String?
    var error: String?
}

enum BitwardenError: LocalizedError {
    case notConfigured
    case request(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Set the bw serve URL in Settings first."
        case .request(let m): return m
        }
    }
}

/// Talks to a running Bitwarden CLI REST bridge (`bw serve`). The bridge holds
/// the unlocked session server-side, so once unlocked we just issue plain HTTP
/// calls. Each server maps to one vault item named `${prefix}${serverId}`; the
/// full `ServerSecrets` bundle lives in the item's notes, with username and
/// password mirrored into the login fields for use from the Bitwarden apps.
actor BitwardenVault {
    private var base: String?
    private var prefix = "ServerCase/"
    private let session = URLSession(configuration: .ephemeral)

    func configure(_ settings: BitwardenSettings) {
        let trimmed = settings.serverUrl.trimmingCharacters(in: .whitespaces)
        base = trimmed.isEmpty ? nil : (trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed)
        prefix = settings.itemPrefix
    }

    private func itemName(_ serverId: String) -> String { prefix + serverId }

    // MARK: Lock state

    func status() async -> BitwardenStatus {
        guard base != nil else {
            return BitwardenStatus(available: false, state: .unauthenticated,
                                   error: "No bw serve URL configured")
        }
        do {
            let data: BwStatusData = try await get("/status")
            let state = BitwardenLockState(rawValue: data.template.status) ?? .locked
            return BitwardenStatus(available: true, state: state,
                                   serverUrl: data.template.serverUrl,
                                   userEmail: data.template.userEmail)
        } catch {
            return BitwardenStatus(available: false, state: .unauthenticated,
                                   error: error.localizedDescription)
        }
    }

    func unlock(_ masterPassword: String) async throws -> BitwardenStatus {
        let body = try JSONSerialization.data(withJSONObject: ["password": masterPassword])
        try await call("POST", "/unlock", body: body)
        try? await sync()
        return await status()
    }

    func lock() async throws { try await call("POST", "/lock") }

    func sync() async throws { try await call("POST", "/sync") }

    // MARK: Secrets

    func getSecrets(_ serverId: String) async throws -> ServerSecrets? {
        guard let item = try await findItem(serverId) else { return nil }
        return decodeSecrets(item)
    }

    func listSecrets() async throws -> [String: ServerSecrets] {
        let list: BwListData = try await get("/list/object/items?search=" + encoded(prefix))
        var out: [String: ServerSecrets] = [:]
        for item in list.data where item.name.hasPrefix(prefix) {
            out[String(item.name.dropFirst(prefix.count))] = decodeSecrets(item)
        }
        return out
    }

    func setSecrets(_ serverId: String, _ secrets: ServerSecrets) async throws {
        let notes = String(data: try JSONEncoder().encode(secrets), encoding: .utf8) ?? ""
        let body = try JSONSerialization.data(withJSONObject: [
            "type": 1,
            "name": itemName(serverId),
            "notes": notes,
            "login": [
                "username": secrets.username ?? NSNull(),
                "password": secrets.password ?? NSNull(),
            ],
        ])
        if let existing = try await findItem(serverId) {
            try await call("PUT", "/object/item/\(existing.id)", body: body)
        } else {
            try await call("POST", "/object/item", body: body)
        }
    }

    func deleteSecrets(_ serverId: String) async throws {
        if let item = try await findItem(serverId) {
            try await call("DELETE", "/object/item/\(item.id)")
        }
    }

    // MARK: Plumbing

    private func decodeSecrets(_ item: BwItem) -> ServerSecrets {
        if let notes = item.notes, let data = notes.data(using: .utf8),
           let secrets = try? JSONDecoder().decode(ServerSecrets.self, from: data) {
            return secrets
        }
        return ServerSecrets(username: item.login?.username, password: item.login?.password)
    }

    private func findItem(_ serverId: String) async throws -> BwItem? {
        let name = itemName(serverId)
        let list: BwListData = try await get("/list/object/items?search=" + encoded(name))
        return list.data.first { $0.name == name }
    }

    private func encoded(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s
    }

    private func request(_ method: String, _ path: String, body: Data?) async throws -> Data {
        guard let base, let url = URL(string: base + path) else { throw BitwardenError.notConfigured }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, _) = try await session.data(for: req)
        return data
    }

    /// A call whose response body we don't need; only checks `success`.
    private func call(_ method: String, _ path: String, body: Data? = nil) async throws {
        let data = try await request(method, path, body: body)
        let env = try JSONDecoder().decode(BwResult.self, from: data)
        if !env.success { throw BitwardenError.request(env.message ?? "bw request failed") }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await request("GET", path, body: nil)
        let env = try JSONDecoder().decode(BwEnvelope<T>.self, from: data)
        if !env.success { throw BitwardenError.request(env.message ?? "bw request failed") }
        guard let payload = env.data else { throw BitwardenError.request("empty response") }
        return payload
    }
}

// MARK: - Wire models

private struct BwResult: Decodable {
    let success: Bool
    let message: String?
}

private struct BwEnvelope<T: Decodable>: Decodable {
    let success: Bool
    let message: String?
    let data: T?
}

private struct BwListData: Decodable {
    let data: [BwItem]
}

private struct BwItem: Decodable {
    let id: String
    let name: String
    let notes: String?
    let login: BwLogin?
}

private struct BwLogin: Decodable {
    let username: String?
    let password: String?
}

private struct BwStatusData: Decodable {
    let template: BwStatusTemplate
}

private struct BwStatusTemplate: Decodable {
    let serverUrl: String?
    let userEmail: String?
    let status: String
}

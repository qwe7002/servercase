import Foundation

/// An error from the worker API, carrying the HTTP status for the UI.
struct CloudError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

/// Minimal REST client for the ServerCase Worker: account auth and config sync.
/// The payload's `exportedAt` is encoded as a number (seconds since 1970) to
/// satisfy the worker's shape check, matching the other clients.
struct CloudService {
    private let session = URLSession(configuration: .ephemeral)

    struct AuthResult {
        let user: CloudUser
        let token: String
        let expiresAt: Date
    }

    func register(url: String, email: String, password: String) async throws -> AuthResult {
        try await authenticate(url: url, path: "/v1/auth/register", email: email, password: password)
    }

    func login(url: String, email: String, password: String) async throws -> AuthResult {
        try await authenticate(url: url, path: "/v1/auth/login", email: email, password: password)
    }

    func getSync(url: String, token: String) async throws -> (version: Int, updatedAt: Date, payload: SyncPayload) {
        let data = try await request(base: url, path: "/v1/sync", method: "GET", body: nil, token: token)
        let res = try Self.decoder.decode(SyncResponse.self, from: data)
        return (res.version, Date(timeIntervalSince1970: res.updatedAt / 1000), res.payload)
    }

    func putSync(url: String, token: String, payload: SyncPayload, baseVersion: Int?) async throws -> (version: Int, updatedAt: Date) {
        let body = try Self.encoder.encode(PutSyncBody(payload: payload, baseVersion: baseVersion))
        let data = try await request(base: url, path: "/v1/sync", method: "PUT", body: body, token: token)
        let res = try Self.decoder.decode(PutResult.self, from: data)
        return (res.version, Date(timeIntervalSince1970: res.updatedAt / 1000))
    }

    // MARK: - Internals

    private func authenticate(url: String, path: String, email: String, password: String) async throws -> AuthResult {
        let body = try Self.encoder.encode(Credentials(email: email, password: password))
        let data = try await request(base: url, path: path, method: "POST", body: body, token: nil)
        let res = try Self.decoder.decode(AuthResponse.self, from: data)
        return AuthResult(user: res.user, token: res.token,
                          expiresAt: Date(timeIntervalSince1970: res.expiresAt / 1000))
    }

    private func request(base: String, path: String, method: String, body: Data?, token: String?) async throws -> Data {
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        guard !trimmed.isEmpty, let u = URL(string: trimmed + path) else {
            throw CloudError(status: 0, message: "Set a valid worker URL first")
        }
        var req = URLRequest(url: u)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = body

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw CloudError(status: 0, message: "Cannot reach \(trimmed): \(error.localizedDescription)")
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let message = (try? Self.decoder.decode(ErrorResponse.self, from: data))?.error ?? "HTTP \(code)"
            throw CloudError(status: code, message: message)
        }
        return data
    }

    private struct Credentials: Codable { let email: String; let password: String }
    private struct PutSyncBody: Codable { let payload: SyncPayload; let baseVersion: Int? }
    private struct AuthResponse: Codable { let user: CloudUser; let token: String; let expiresAt: Double }
    private struct SyncResponse: Codable { let version: Int; let updatedAt: Double; let payload: SyncPayload }
    private struct PutResult: Codable { let version: Int; let updatedAt: Double }
    private struct ErrorResponse: Codable { let error: String? }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        return e
    }()
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return d
    }()
}

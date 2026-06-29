import Foundation

struct CloudAuthResult: Codable {
    var token: String
    var expiresAt: Date
    var user: CloudUser

    private enum CodingKeys: String, CodingKey {
        case token
        case accessToken
        case access_token
        case sessionToken
        case session_token
        case jwt
        case expiresAt
        case expires_at
        case expiresIn
        case expires_in
        case user
        case email
        case data
        case result
        case session
        case auth
    }

    init(token: String, expiresAt: Date, user: CloudUser) {
        self.token = token
        self.expiresAt = expiresAt
        self.user = user
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let auth = try Self.authContainer(from: container)
        token = try Self.decodeToken(from: auth)

        if let explicitExpiry = try auth.decodeIfPresent(Date.self, forKey: .expiresAt)
            ?? auth.decodeIfPresent(Date.self, forKey: .expires_at) {
            expiresAt = explicitExpiry
        } else if let expiresIn = try auth.decodeIfPresent(Double.self, forKey: .expiresIn)
            ?? auth.decodeIfPresent(Double.self, forKey: .expires_in) {
            expiresAt = Date().addingTimeInterval(expiresIn)
        } else if let expiresIn = try auth.decodeIfPresent(Int.self, forKey: .expiresIn)
            ?? auth.decodeIfPresent(Int.self, forKey: .expires_in) {
            expiresAt = Date().addingTimeInterval(Double(expiresIn))
        } else {
            expiresAt = Date().addingTimeInterval(30 * 24 * 60 * 60)
        }

        if let user = try auth.decodeIfPresent(CloudUser.self, forKey: .user) {
            self.user = user
        } else {
            self.user = CloudUser(id: nil, email: try auth.decodeIfPresent(String.self, forKey: .email) ?? "")
        }
    }

    private static func authContainer(
        from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> KeyedDecodingContainer<CodingKeys> {
        if let nested = try? container.nestedContainer(keyedBy: CodingKeys.self, forKey: .data) {
            return nested
        }
        if let nested = try? container.nestedContainer(keyedBy: CodingKeys.self, forKey: .result) {
            return nested
        }
        if let nested = try? container.nestedContainer(keyedBy: CodingKeys.self, forKey: .auth) {
            return nested
        }
        return container
    }

    private static func decodeToken(from container: KeyedDecodingContainer<CodingKeys>) throws -> String {
        if let token = try firstToken(in: container) {
            return token
        }
        if let session = try? container.nestedContainer(keyedBy: CodingKeys.self, forKey: .session),
           let token = try firstToken(in: session) {
            return token
        }
        throw DecodingError.keyNotFound(
            CodingKeys.token,
            DecodingError.Context(codingPath: container.codingPath, debugDescription: "Missing cloud auth token")
        )
    }

    private static func firstToken(in container: KeyedDecodingContainer<CodingKeys>) throws -> String? {
        let keys: [CodingKeys] = [.token, .accessToken, .access_token, .sessionToken, .session_token, .jwt]
        for key in keys {
            if let token = try container.decodeIfPresent(String.self, forKey: key) {
                return token
            }
        }
        return nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(token, forKey: .token)
        try container.encode(expiresAt, forKey: .expiresAt)
        try container.encode(user, forKey: .user)
    }
}

struct CloudSyncResult: Codable {
    var version: Int
    var updatedAt: Date
    var payload: SyncPayload
}

struct CloudError: LocalizedError, Codable {
    var status: Int
    var message: String

    var errorDescription: String? { message }

    private enum CodingKeys: String, CodingKey {
        case status
        case message
        case error
    }

    init(status: Int, message: String) {
        self.status = status
        self.message = message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decodeIfPresent(Int.self, forKey: .status) ?? 0
        message = try container.decodeIfPresent(String.self, forKey: .message)
            ?? container.decodeIfPresent(String.self, forKey: .error)
            ?? "Cloud request failed"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encode(message, forKey: .message)
    }
}

struct CloudService {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }()

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func register(url: String, email: String, password: String) async throws -> CloudAuthResult {
        try await send(path: "/auth/register", baseURL: url, method: "POST", body: AuthRequest(email: email, password: password))
    }

    func login(url: String, email: String, password: String) async throws -> CloudAuthResult {
        try await send(path: "/auth/login", baseURL: url, method: "POST", body: AuthRequest(email: email, password: password))
    }

    func registerDevice(url: String, sessionToken: String, fcmToken: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/devices",
            baseURL: url,
            method: "POST",
            token: sessionToken,
            body: DeviceRequest(fcmToken: fcmToken)
        )
    }

    func putSync(url: String, token: String, payload: SyncPayload, baseVersion: Int?) async throws -> CloudSyncResult {
        try await send(
            path: "/sync",
            baseURL: url,
            method: "PUT",
            token: token,
            body: PutSyncRequest(baseVersion: baseVersion, payload: payload)
        )
    }

    func getSync(url: String, token: String) async throws -> CloudSyncResult {
        try await send(path: "/sync", baseURL: url, method: "GET", token: token, body: Optional<EmptyRequest>.none)
    }

    func listProbes(url: String, token: String) async throws -> ProbeListResult {
        try await send(path: "/probes", baseURL: url, method: "GET", token: token, body: Optional<EmptyRequest>.none)
    }

    func createProbe(url: String, token: String, name: String) async throws -> ProbeCreateResult {
        try await send(path: "/probes", baseURL: url, method: "POST", token: token, body: ProbeCreateRequest(name: name))
    }

    func deleteProbe(url: String, token: String, id: String) async throws {
        let _: EmptyResponse = try await send(
            path: "/probes/\(id)",
            baseURL: url,
            method: "DELETE",
            token: token,
            body: Optional<EmptyRequest>.none
        )
    }

    func probeStreamURL(baseURL: String, token: String) throws -> URL {
        guard var components = URLComponents(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw CloudError(status: 0, message: "Invalid cloud URL")
        }
        switch components.scheme {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        default: throw CloudError(status: 0, message: "Invalid cloud URL")
        }
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let pathParts = basePath.isEmpty ? ["v1", "stream"] : [basePath, "stream"]
        components.path = "/" + pathParts.filter { !$0.isEmpty }.joined(separator: "/")
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components.url else {
            throw CloudError(status: 0, message: "Invalid cloud URL")
        }
        return url
    }

    private func send<RequestBody: Encodable, ResponseBody: Decodable>(
        path: String,
        baseURL: String,
        method: String,
        token: String? = nil,
        body: RequestBody?
    ) async throws -> ResponseBody {
        guard var components = URLComponents(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw CloudError(status: 0, message: "Invalid cloud URL")
        }
        components.queryItems = nil
        components.fragment = nil

        let urls = try candidateURLs(baseComponents: components, endpointPath: path)
        var firstNotFound: CloudError?

        for url in urls {
            do {
                return try await sendRequest(
                    url: url,
                    method: method,
                    token: token,
                    body: body,
                    responseType: ResponseBody.self
                )
            } catch let error as CloudError where error.status == 404 {
                if firstNotFound == nil { firstNotFound = error }
                continue
            }
        }

        throw firstNotFound ?? CloudError(status: 404, message: "not found")
    }

    private func candidateURLs(baseComponents: URLComponents, endpointPath: String) throws -> [URL] {
        let basePath = baseComponents.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let endpointPath = endpointPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let paths = [
            [basePath, endpointPath].filter { !$0.isEmpty }.joined(separator: "/"),
            ["v1", endpointPath].filter { !$0.isEmpty }.joined(separator: "/"),
            ["api", endpointPath].filter { !$0.isEmpty }.joined(separator: "/"),
            endpointPath
        ]

        var urls: [URL] = []
        for path in paths {
            var components = baseComponents
            components.path = "/" + path
            guard let url = components.url else {
                throw CloudError(status: 0, message: "Invalid cloud URL")
            }
            if !urls.contains(url) {
                urls.append(url)
            }
        }
        return urls
    }

    private func sendRequest<RequestBody: Encodable, ResponseBody: Decodable>(
        url: URL,
        method: String,
        token: String?,
        body: RequestBody?,
        responseType: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.encoder.encode(body)
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CloudError(status: 0, message: "Invalid cloud response")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let cloudError = try? Self.decoder.decode(CloudError.self, from: data) {
                if http.statusCode == 404 {
                    throw CloudError(status: http.statusCode, message: "\(cloudError.message) (\(url.absoluteString))")
                }
                throw cloudError
            }
            let message = HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            if http.statusCode == 404 {
                throw CloudError(status: http.statusCode, message: "\(message) (\(url.absoluteString))")
            }
            throw CloudError(status: http.statusCode, message: message)
        }
        if ResponseBody.self == EmptyResponse.self {
            return EmptyResponse() as! ResponseBody
        }
        do {
            return try Self.decoder.decode(ResponseBody.self, from: data)
        } catch {
            let body = String(data: data, encoding: .utf8) ?? "<non-UTF8 response>"
            throw CloudError(
                status: http.statusCode,
                message: "Unexpected cloud response format: \(body.prefix(300))"
            )
        }
    }
}

private struct AuthRequest: Encodable {
    var email: String
    var password: String
}

private struct DeviceRequest: Encodable {
    var platform = "fcm"
    var token: String
    var label = "ServerCase iOS"

    init(fcmToken: String) {
        self.token = fcmToken
    }
}

private struct PutSyncRequest: Encodable {
    var baseVersion: Int?
    var payload: SyncPayload
}

private struct ProbeCreateRequest: Encodable {
    var name: String
}

private struct EmptyRequest: Encodable {}
private struct EmptyResponse: Decodable {}

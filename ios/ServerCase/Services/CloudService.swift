import Foundation
import UIKit
import UserNotifications

struct CloudUser: Codable, Equatable {
    var id: String?
    var email: String
}

struct CloudSession: Codable, Equatable {
    var token: String
    var expiresAt: Date
    var user: CloudUser
    var syncVersion: Int?
    var syncedAt: Date?

    var isValid: Bool {
        expiresAt > Date()
    }
}

struct CloudAuthResult: Codable {
    var token: String
    var expiresAt: Date
    var user: CloudUser
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
}

enum CloudSessionStore {
    private static let key = "servercase.cloud.session"

    static func load() -> CloudSession? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? CloudService.decoder.decode(CloudSession.self, from: data)
    }

    static func save(_ session: CloudSession?) {
        guard let session else {
            UserDefaults.standard.removeObject(forKey: key)
            return
        }
        if let data = try? CloudService.encoder.encode(session) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}

enum PushToken {
    private static let key = "servercase.push.fcmToken"

    static var current: String? {
        get { UserDefaults.standard.string(forKey: key) }
        set {
            UserDefaults.standard.set(newValue, forKey: key)
            NotificationCenter.default.post(name: .fcmTokenReceived, object: nil)
        }
    }
}

extension Notification.Name {
    static let fcmTokenReceived = Notification.Name("servercase.fcmTokenReceived")
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            let granted = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
            if granted == true {
                application.registerForRemoteNotifications()
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushToken.current = deviceToken.map { String(format: "%02x", $0) }.joined()
    }
}

struct CloudService {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
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
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let endpointPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + [basePath, endpointPath].filter { !$0.isEmpty }.joined(separator: "/")
        guard let url = components.url else {
            throw CloudError(status: 0, message: "Invalid cloud URL")
        }

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
                throw cloudError
            }
            throw CloudError(status: http.statusCode, message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
        if ResponseBody.self == EmptyResponse.self {
            return EmptyResponse() as! ResponseBody
        }
        return try Self.decoder.decode(ResponseBody.self, from: data)
    }
}

private struct AuthRequest: Encodable {
    var email: String
    var password: String
}

private struct DeviceRequest: Encodable {
    var fcmToken: String
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

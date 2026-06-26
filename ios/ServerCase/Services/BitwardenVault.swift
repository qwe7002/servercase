import Foundation
import CommonCrypto
import CryptoKit
import Security

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
    case crypto(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Bitwarden API key is not configured."
        case .request(let m): return m
        case .crypto(let m): return m
        }
    }
}

/// A clean-room Bitwarden client: it speaks the Bitwarden REST API directly and
/// reimplements the account crypto, so it needs neither the `bw` CLI nor the
/// official SDK.
///
/// Auth uses a personal API key (OAuth `client_credentials`); the master
/// password is required only to derive the vault key locally and is never sent
/// to the server or persisted. Only the PBKDF2 KDF is supported.
actor BitwardenVault {
    private var settings = BitwardenSettings()
    private var accessToken: String?
    private var tokenExpiresAt = Date.distantPast
    private var userEncKey: Data?
    private var userMacKey: Data?
    private let deviceId = UUID().uuidString
    private let session = URLSession(configuration: .ephemeral)

    func configure(_ settings: BitwardenSettings) {
        if settings.serverUrl != self.settings.serverUrl ||
            settings.email != self.settings.email ||
            settings.clientId != self.settings.clientId {
            lock()
        }
        self.settings = settings
    }

    private var base: String {
        settings.serverUrl.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    }
    private var identityUrl: String { base.isEmpty ? "https://identity.bitwarden.com" : base + "/identity" }
    private var apiUrl: String { base.isEmpty ? "https://api.bitwarden.com" : base + "/api" }

    private var configured: Bool {
        !settings.email.isEmpty && !settings.clientId.isEmpty && !settings.clientSecret.isEmpty
    }
    private var unlocked: Bool {
        userEncKey != nil && accessToken != nil && Date() < tokenExpiresAt
    }

    func status() -> BitwardenStatus {
        let state: BitwardenLockState = !configured ? .unauthenticated : (unlocked ? .unlocked : .locked)
        return BitwardenStatus(available: configured, state: state,
                               serverUrl: settings.serverUrl.isEmpty ? "https://bitwarden.com" : settings.serverUrl,
                               userEmail: settings.email.isEmpty ? nil : settings.email)
    }

    func unlock(_ masterPassword: String) async throws -> BitwardenStatus {
        guard configured else { throw BitwardenError.notConfigured }
        let kdf = await prelogin()
        let token = try await requestToken()

        let masterKey = try deriveMasterKey(masterPassword, kdf: kdf)
        let stretchedEnc = hkdfExpand(masterKey, info: "enc", length: 32)
        let stretchedMac = hkdfExpand(masterKey, info: "mac", length: 32)
        let userKey = try decryptEncString(token.key, encKey: stretchedEnc, macKey: stretchedMac)
        guard userKey.count >= 64 else { throw BitwardenError.crypto("unexpected vault key length") }

        userEncKey = userKey.prefix(32)
        userMacKey = userKey.subdata(in: 32..<64)
        accessToken = token.accessToken
        tokenExpiresAt = Date().addingTimeInterval(token.expiresInSec - 30)
        return status()
    }

    func lock() {
        accessToken = nil
        tokenExpiresAt = .distantPast
        userEncKey = nil
        userMacKey = nil
    }

    func sync() async throws { try assertUnlocked() }

    func getSecrets(_ serverId: String) async throws -> ServerSecrets? {
        guard let cipher = try await findCipher(serverId) else { return nil }
        return decodeSecrets(cipher)
    }

    func listSecrets() async throws -> [String: ServerSecrets] {
        let ciphers = try await fetchCiphers()
        var out: [String: ServerSecrets] = [:]
        for cipher in ciphers {
            if let name = decryptField(cipher.name), name.hasPrefix(settings.itemPrefix) {
                out[String(name.dropFirst(settings.itemPrefix.count))] = decodeSecrets(cipher)
            }
        }
        return out
    }

    func setSecrets(_ serverId: String, _ secrets: ServerSecrets) async throws {
        try assertUnlocked()
        let notes = String(data: try JSONEncoder().encode(secrets), encoding: .utf8) ?? "{}"
        var login: [String: Any] = ["uris": NSNull(), "totp": NSNull(),
                                    "username": NSNull(), "password": NSNull()]
        if let u = secrets.username { login["username"] = try encryptField(u) }
        if let p = secrets.password { login["password"] = try encryptField(p) }
        let body: [String: Any] = [
            "type": 1,
            "name": try encryptField(settings.itemPrefix + serverId),
            "notes": try encryptField(notes),
            "favorite": false,
            "folderId": NSNull(),
            "organizationId": NSNull(),
            "login": login,
        ]
        let payload = try JSONSerialization.data(withJSONObject: body)
        if let existing = try await findCipher(serverId) {
            _ = try await api("PUT", "/ciphers/\(existing.id)", body: payload)
        } else {
            _ = try await api("POST", "/ciphers", body: payload)
        }
    }

    func deleteSecrets(_ serverId: String) async throws {
        if let cipher = try await findCipher(serverId) {
            _ = try await api("DELETE", "/ciphers/\(cipher.id)", body: nil)
        }
    }

    // MARK: Crypto

    private func deriveMasterKey(_ password: String, kdf: KdfInfo) throws -> Data {
        guard kdf.type == 0 else {
            throw BitwardenError.crypto("Only the PBKDF2 KDF is supported; switch your account KDF to PBKDF2.")
        }
        let salt = settings.email.trimmingCharacters(in: .whitespaces).lowercased()
        return pbkdf2(password, salt: salt, iterations: kdf.iterations, keyLength: 32)
    }

    private func encryptField(_ plaintext: String) throws -> String {
        try encryptEncString(Data(plaintext.utf8), encKey: encKey(), macKey: macKey())
    }

    private func decryptField(_ enc: String?) -> String? {
        guard let enc, let enc2 = try? decryptEncString(enc, encKey: encKey(), macKey: macKey()) else { return nil }
        return String(data: enc2, encoding: .utf8)
    }

    private func decodeSecrets(_ cipher: Cipher) -> ServerSecrets {
        if let notes = decryptField(cipher.notes), let data = notes.data(using: .utf8),
           let secrets = try? JSONDecoder().decode(ServerSecrets.self, from: data) {
            return secrets
        }
        return ServerSecrets(username: decryptField(cipher.username), password: decryptField(cipher.password))
    }

    private func encKey() throws -> Data {
        guard let userEncKey else { throw BitwardenError.crypto("Bitwarden vault is locked") }
        return userEncKey
    }
    private func macKey() throws -> Data {
        guard let userMacKey else { throw BitwardenError.crypto("Bitwarden vault is locked") }
        return userMacKey
    }
    private func assertUnlocked() throws {
        guard unlocked else { throw BitwardenError.request("Bitwarden vault is locked") }
    }

    // MARK: REST

    private func prelogin() async -> KdfInfo {
        let body = try? JSONSerialization.data(withJSONObject: ["email": settings.email])
        if let data = try? await rawRequest("POST", url: identityUrl + "/accounts/prelogin",
                                            json: body, bearer: false),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let type = (pick(obj, "Kdf", "kdf") as? Int) ?? 0
            let iters = (pick(obj, "KdfIterations", "kdfIterations") as? Int) ?? 600000
            return KdfInfo(type: type, iterations: iters)
        }
        return KdfInfo(type: 0, iterations: 600000)
    }

    private func requestToken() async throws -> TokenResult {
        let form = [
            "grant_type": "client_credentials",
            "client_id": settings.clientId,
            "client_secret": settings.clientSecret,
            "scope": "api",
            "deviceType": "1", // iOS
            "deviceIdentifier": deviceId,
            "deviceName": "ServerCase",
        ].map { "\($0.key)=\(urlEncode($0.value))" }.joined(separator: "&")

        var req = URLRequest(url: URL(string: identityUrl + "/connect/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(form.utf8)
        let (data, response) = try await session.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let msg = (obj["error_description"] as? String)
                ?? ((obj["ErrorModel"] as? [String: Any])?["Message"] as? String)
                ?? "Bitwarden login failed"
            throw BitwardenError.request(msg)
        }
        guard let key = pick(obj, "Key", "key") as? String else {
            throw BitwardenError.request("login response missing key")
        }
        let token = obj["access_token"] as? String ?? ""
        let expires = (obj["expires_in"] as? Double) ?? 3600
        return TokenResult(accessToken: token, expiresInSec: expires, key: key)
    }

    private func fetchCiphers() async throws -> [Cipher] {
        try assertUnlocked()
        let data = try await api("GET", "/sync?excludeDomains=true", body: nil)
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let raw = (pick(obj, "Ciphers", "ciphers") as? [[String: Any]]) ?? []
        return raw.map(Cipher.init)
    }

    private func findCipher(_ serverId: String) async throws -> Cipher? {
        let target = settings.itemPrefix + serverId
        return try await fetchCiphers().first { decryptField($0.name) == target }
    }

    @discardableResult
    private func api(_ method: String, _ path: String, body: Data?) async throws -> Data {
        try assertUnlocked()
        return try await rawRequest(method, url: apiUrl + path, json: body, bearer: true)
    }

    private func rawRequest(_ method: String, url: String, json: Data?, bearer: Bool) async throws -> Data {
        guard let u = URL(string: url) else { throw BitwardenError.request("bad URL") }
        var req = URLRequest(url: u)
        req.httpMethod = method
        if let json {
            req.httpBody = json
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if bearer, let accessToken {
            req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw BitwardenError.request("Bitwarden \(method) \(path(of: url)) failed: \(code)")
        }
        return data
    }

    private func path(of url: String) -> String { URL(string: url)?.path ?? url }

    private func pick(_ obj: [String: Any], _ keys: String...) -> Any? {
        for k in keys { if let v = obj[k], !(v is NSNull) { return v } }
        return nil
    }

    private func urlEncode(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    // MARK: Crypto primitives

    private func pbkdf2(_ password: String, salt: String, iterations: Int, keyLength: Int) -> Data {
        var derived = Data(repeating: 0, count: keyLength)
        let pwd = Array(password.utf8)
        let saltBytes = Array(salt.utf8)
        _ = derived.withUnsafeMutableBytes { out in
            CCKeyDerivationPBKDF(
                CCPBKDFAlgorithm(kCCPBKDF2),
                password, pwd.count,
                saltBytes, saltBytes.count,
                CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                UInt32(iterations),
                out.bindMemory(to: UInt8.self).baseAddress, keyLength
            )
        }
        return derived
    }

    private func hkdfExpand(_ prk: Data, info: String, length: Int) -> Data {
        let key = SymmetricKey(data: prk)
        let out = HKDF<SHA256>.expand(pseudoRandomKey: key, info: Data(info.utf8), outputByteCount: length)
        return out.withUnsafeBytes { Data($0) }
    }

    private func hmac(_ key: Data, _ message: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
    }

    private func aes(_ operation: CCOperation, key: Data, iv: Data, data: Data) -> Data? {
        var out = Data(count: data.count + kCCBlockSizeAES128)
        var moved = 0
        let status = out.withUnsafeMutableBytes { outB in
            data.withUnsafeBytes { dataB in
                iv.withUnsafeBytes { ivB in
                    key.withUnsafeBytes { keyB in
                        CCCrypt(operation, CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                                keyB.baseAddress, key.count,
                                ivB.baseAddress,
                                dataB.baseAddress, data.count,
                                outB.baseAddress, out.count, &moved)
                    }
                }
            }
        }
        guard status == kCCSuccess else { return nil }
        return out.prefix(moved)
    }

    private func encryptEncString(_ data: Data, encKey: Data, macKey: Data) throws -> String {
        var iv = Data(count: 16)
        let ok = iv.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard ok == errSecSuccess, let ct = aes(CCOperation(kCCEncrypt), key: encKey, iv: iv, data: data) else {
            throw BitwardenError.crypto("encryption failed")
        }
        let mac = hmac(macKey, iv + ct)
        return "2.\(iv.base64EncodedString())|\(ct.base64EncodedString())|\(mac.base64EncodedString())"
    }

    private func decryptEncString(_ s: String, encKey: Data, macKey: Data) throws -> Data {
        guard let dot = s.firstIndex(of: "."), s.hasPrefix("2.") else {
            throw BitwardenError.crypto("unsupported EncString type")
        }
        let parts = s[s.index(after: dot)...].split(separator: "|", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let iv = Data(base64Encoded: String(parts[0])),
              let ct = Data(base64Encoded: String(parts[1])),
              let mac = Data(base64Encoded: String(parts[2])) else {
            throw BitwardenError.crypto("malformed EncString")
        }
        let expected = hmac(macKey, iv + ct)
        guard constantTimeEquals(expected, mac) else { throw BitwardenError.crypto("EncString MAC mismatch") }
        guard let pt = aes(CCOperation(kCCDecrypt), key: encKey, iv: iv, data: ct) else {
            throw BitwardenError.crypto("decryption failed")
        }
        return pt
    }

    private func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[a.startIndex + i] ^ b[b.startIndex + i] }
        return diff == 0
    }
}

private struct KdfInfo {
    let type: Int
    let iterations: Int
}

private struct TokenResult {
    let accessToken: String
    let expiresInSec: Double
    let key: String
}

private struct Cipher {
    let id: String
    let name: String?
    let notes: String?
    let username: String?
    let password: String?

    init(_ raw: [String: Any]) {
        func pick(_ keys: String...) -> Any? {
            for k in keys { if let v = raw[k], !(v is NSNull) { return v } }
            return nil
        }
        id = (pick("Id", "id") as? String) ?? ""
        name = pick("Name", "name") as? String
        notes = pick("Notes", "notes") as? String
        let login = (pick("Login", "login") as? [String: Any]) ?? [:]
        func loginPick(_ keys: String...) -> String? {
            for k in keys { if let v = login[k], !(v is NSNull) { return v as? String } }
            return nil
        }
        username = loginPick("Username", "username")
        password = loginPick("Password", "password")
    }
}

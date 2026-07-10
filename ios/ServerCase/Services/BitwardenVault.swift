import Foundation
import CommonCrypto
import CryptoKit
import Security
import SwiftArgon2

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
/// to the server or persisted. PBKDF2 and Argon2id account KDFs are supported.
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
            settings.authMode != self.settings.authMode ||
            settings.clientId != self.settings.clientId {
            lock()
        }
        self.settings = settings
    }

    private var base: String {
        let trimmed = settings.serverUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.range(of: "http://", options: [.anchored, .caseInsensitive]) != nil ||
            trimmed.range(of: "https://", options: [.anchored, .caseInsensitive]) != nil {
            return trimmed
        }
        return "https://" + trimmed
    }
    private var identityUrl: String { base.isEmpty ? "https://identity.bitwarden.com" : base + "/identity" }
    private var apiUrl: String { base.isEmpty ? "https://api.bitwarden.com" : base + "/api" }

    private var configured: Bool {
        switch settings.authMode {
        case .apiKey:
            return !settings.email.isEmpty && !settings.clientId.isEmpty && !settings.clientSecret.isEmpty
        case .password:
            return !settings.email.isEmpty
        }
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

        let token: TokenResult
        let kdf: KdfInfo
        switch settings.authMode {
        case .apiKey:
            token = try await requestApiKeyToken()
            if let tokenKdf = token.kdf {
                kdf = tokenKdf
            } else {
                kdf = await prelogin()
            }
        case .password:
            kdf = await prelogin()
            let masterKey = try await deriveMasterKey(masterPassword, kdf: kdf)
            let passwordHash = masterPasswordHash(masterKey: masterKey, masterPassword: masterPassword)
            token = try await requestPasswordToken(passwordHash: passwordHash)
        }

        let masterKey = try await deriveMasterKey(masterPassword, kdf: token.kdf ?? kdf)
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

    /// Exercises the full vault path with a throwaway item: encrypt + upload a
    /// probe, fetch + decrypt it back, verify, then delete it.
    func test() async throws -> String {
        try assertUnlocked()
        let itemName = "__selftest__"
        let probe = ServerSecrets(username: "servercase", password: "probe-" + UUID().uuidString)
        try await setSecrets(itemName, probe)
        do {
            let read = try await getSecrets(itemName)
            guard let read, read.username == probe.username, read.password == probe.password else {
                try? await deleteSecrets(itemName)
                throw BitwardenError.crypto("round-trip mismatch — decrypted value did not match")
            }
            try? await deleteSecrets(itemName)
            return "Vault OK — wrote, read back and verified \(folderName)/\(itemName)."
        } catch {
            try? await deleteSecrets(itemName)
            throw error
        }
    }

    func getSecrets(_ itemName: String, aliases: [String] = []) async throws -> ServerSecrets? {
        let snapshot = try await fetchSync()
        guard let cipher = try findCipher(itemName, aliases: aliases, in: snapshot.ciphers) else { return nil }
        return resolveSecrets(cipher, in: snapshot.ciphers)
    }

    func listSecrets() async throws -> [String: ServerSecrets] {
        let snapshot = try await fetchSync()
        let folderId = serverCaseFolderId(in: snapshot.folders)
        var out: [String: ServerSecrets] = [:]
        for cipher in snapshot.ciphers {
            guard cipher.type == 1,
                  let (enc, mac) = try? cipherKeys(cipher),
                  let name = decryptWith(cipher.name, enc, mac) else { continue }
            if let folderId, cipher.folderId == folderId {
                out[name] = resolveSecrets(cipher, in: snapshot.ciphers)
            } else if name.hasPrefix(legacyItemPrefix) {
                out[String(name.dropFirst(legacyItemPrefix.count))] = resolveSecrets(cipher, in: snapshot.ciphers)
            }
        }
        return out
    }

    func setSecrets(_ itemName: String, _ secrets: ServerSecrets, aliases: [String] = []) async throws {
        try assertUnlocked()
        let folderId = try await ensureServerCaseFolderId()
        var normalizedSecrets = secrets
        if let privateKey = secrets.privateKey, !privateKey.isEmpty {
            let keyItemName = secrets.sshKeyItemName?.isEmpty == false
                ? secrets.sshKeyItemName!
                : normalizedItemName(itemName) + " SSH Key"
            try await setSSHKeyItem(keyItemName, privateKey: privateKey)
            normalizedSecrets.sshKeyItemName = keyItemName
            normalizedSecrets.password = secrets.passphrase
            normalizedSecrets.privateKey = nil
            normalizedSecrets.passphrase = nil
        }

        var login: [String: Any] = ["uris": NSNull(), "totp": NSNull(),
                                    "username": NSNull(), "password": NSNull()]
        if let u = normalizedSecrets.username { login["username"] = try encryptField(u) }
        if let p = normalizedSecrets.password { login["password"] = try encryptField(p) }
        let fields = try encryptedFields(for: normalizedSecrets)
        let body: [String: Any] = [
            "type": 1,
            "name": try encryptField(normalizedItemName(itemName)),
            "notes": NSNull(),
            "favorite": false,
            "folderId": folderId,
            "organizationId": NSNull(),
            "login": login,
            "fields": fields.isEmpty ? NSNull() : fields,
        ]
        let payload = try JSONSerialization.data(withJSONObject: body)
        if let existing = try await findCipher(itemName, aliases: aliases) {
            _ = try await api("PUT", "/ciphers/\(existing.id)", body: payload)
        } else {
            _ = try await api("POST", "/ciphers", body: payload)
        }
    }

    func deleteSecrets(_ itemName: String, aliases: [String] = []) async throws {
        if let cipher = try await findCipher(itemName, aliases: aliases) {
            _ = try await api("DELETE", "/ciphers/\(cipher.id)", body: nil)
        }
    }

    func listFolders() async throws -> [BitwardenFolderOption] {
        let snapshot = try await fetchSync()
        guard let enc = try? encKey(), let mac = try? macKey() else { return [] }
        return snapshot.folders.compactMap { folder in
            guard let name = decryptWith(folder.name, enc, mac), !name.isEmpty else { return nil }
            return BitwardenFolderOption(id: folder.id, name: name)
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func createFolder(named name: String) async throws -> BitwardenFolderOption {
        let cleanName = normalizedFolderName(name)
        let body = try JSONSerialization.data(withJSONObject: [
            "name": try encryptField(cleanName)
        ])
        let data = try await api("POST", "/folders", body: body)
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let id = pick(obj, "Id", "id") as? String else {
            throw BitwardenError.request("Bitwarden folder create response missing id")
        }
        return BitwardenFolderOption(id: id, name: cleanName)
    }

    func deleteFolder(id: String) async throws {
        _ = try await api("DELETE", "/folders/\(id)", body: nil)
    }

    // MARK: Crypto

    private func deriveMasterKey(_ password: String, kdf: KdfInfo) async throws -> Data {
        let email = settings.email.trimmingCharacters(in: .whitespaces).lowercased()
        switch kdf.type {
        case 0:
            return pbkdf2(Data(password.utf8), salt: Data(email.utf8), iterations: kdf.iterations, keyLength: 32)
        case 1:
            // Bitwarden Argon2id: salt = SHA-256(email), memory in MiB -> KiB.
            let salt = Data(SHA256.hash(data: Data(email.utf8)))
            let argon2 = try Argon2(
                params: Argon2Params(
                    parallelism: UInt32(kdf.parallelism),
                    tagLength: 32,
                    memorySize: UInt32(kdf.memory * 1024),
                    iterations: UInt32(kdf.iterations),
                    variant: .argon2id
                )
            )
            return try await argon2.compute(password: Data(password.utf8), salt: salt)
        default:
            throw BitwardenError.crypto("unsupported KDF type \(kdf.type)")
        }
    }

    private func encryptField(_ plaintext: String) throws -> String {
        try encryptEncString(Data(plaintext.utf8), encKey: encKey(), macKey: macKey())
    }

    private func decryptWith(_ enc: String?, _ encKey: Data, _ macKey: Data) -> String? {
        guard let enc, let d = try? decryptEncString(enc, encKey: encKey, macKey: macKey) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    /// The keys to use for a cipher's fields: its own key, or the user key.
    private func cipherKeys(_ cipher: Cipher) throws -> (Data, Data) {
        if let k = cipher.key,
           let raw = try? decryptEncString(k, encKey: try encKey(), macKey: try macKey()),
           raw.count >= 64 {
            return (raw.prefix(32), raw.subdata(in: 32..<64))
        }
        return (try encKey(), try macKey())
    }

    private func resolveSecrets(_ cipher: Cipher, in ciphers: [Cipher]) -> ServerSecrets {
        var secrets = decodeSecrets(cipher)
        if let keyItemName = secrets.sshKeyItemName,
           let keyCipher = findCipherByExactName(keyItemName, in: ciphers),
           let privateKey = decodeSSHPrivateKey(keyCipher) {
            secrets.privateKey = privateKey
            secrets.passphrase = secrets.password
            secrets.password = nil
        }
        return secrets
    }

    private func decodeSecrets(_ cipher: Cipher) -> ServerSecrets {
        guard let (enc, mac) = try? cipherKeys(cipher) else { return ServerSecrets() }
        if let notes = decryptWith(cipher.notes, enc, mac), let data = notes.data(using: .utf8),
           let secrets = try? JSONDecoder().decode(ServerSecrets.self, from: data) {
            return secrets
        }

        var sshKeyItemName: String?
        for field in cipher.fields {
            guard let name = decryptWith(field.name, enc, mac) else { continue }
            if name == "servercase.sshKeyItemName" {
                sshKeyItemName = decryptWith(field.value, enc, mac)
            }
        }

        return ServerSecrets(username: decryptWith(cipher.username, enc, mac),
                             password: decryptWith(cipher.password, enc, mac),
                             sshKeyItemName: sshKeyItemName)
    }

    private func decodeSSHPrivateKey(_ cipher: Cipher) -> String? {
        guard let (enc, mac) = try? cipherKeys(cipher) else { return nil }
        return decryptWith(cipher.sshPrivateKey, enc, mac)
    }

    private func encryptedFields(for secrets: ServerSecrets) throws -> [[String: Any]] {
        var fields: [[String: Any]] = []
        if let keyItemName = secrets.sshKeyItemName, !keyItemName.isEmpty {
            fields.append(try encryptedHiddenField(name: "servercase.sshKeyItemName", value: keyItemName))
        }
        return fields
    }

    private func encryptedHiddenField(name: String, value: String) throws -> [String: Any] {
        [
            "name": try encryptField(name),
            "value": try encryptField(value),
            "type": 1,
            "linkedId": NSNull(),
        ]
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
            return parseKdf(obj)
        }
        return KdfInfo(type: 0, iterations: 600000, memory: 64, parallelism: 4)
    }

    private func parseKdf(_ obj: [String: Any]) -> KdfInfo {
        KdfInfo(
            type: (pick(obj, "Kdf", "kdf") as? Int) ?? 0,
            iterations: (pick(obj, "KdfIterations", "kdfIterations") as? Int) ?? 600000,
            memory: (pick(obj, "KdfMemory", "kdfMemory") as? Int) ?? 64,
            parallelism: (pick(obj, "KdfParallelism", "kdfParallelism") as? Int) ?? 4
        )
    }

    private func requestApiKeyToken() async throws -> TokenResult {
        try await requestToken(form: [
            "grant_type": "client_credentials",
            "client_id": settings.clientId,
            "client_secret": settings.clientSecret,
            "scope": "api",
            "deviceType": "1", // iOS
            "deviceIdentifier": deviceId,
            "deviceName": "ServerCase",
        ])
    }

    private func requestPasswordToken(passwordHash: String) async throws -> TokenResult {
        try await requestToken(form: [
            "grant_type": "password",
            "client_id": "mobile",
            "username": settings.email.trimmingCharacters(in: .whitespaces),
            "password": passwordHash,
            "scope": "api offline_access",
            "deviceType": "1", // iOS
            "deviceIdentifier": deviceId,
            "deviceName": "ServerCase",
        ])
    }

    private func requestToken(form fields: [String: String]) async throws -> TokenResult {
        let form = fields.map { "\($0.key)=\(urlEncode($0.value))" }.joined(separator: "&")

        var req = URLRequest(url: URL(string: identityUrl + "/connect/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(form.utf8)
        let (data, response) = try await session.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let errorModel = (obj["ErrorModel"] as? [String: Any]) ?? (obj["errorModel"] as? [String: Any])
            let msg = (obj["error_description"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? ((errorModel?["Message"] as? String) ?? (errorModel?["message"] as? String))
                ?? (obj["message"] as? String)
                ?? (obj["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                ?? "Bitwarden login failed"
            throw BitwardenError.request(msg)
        }
        guard let key = pick(obj, "Key", "key") as? String else {
            throw BitwardenError.request("login response missing key")
        }
        let token = obj["access_token"] as? String ?? ""
        let expires = (obj["expires_in"] as? Double) ?? 3600
        let kdf = pick(obj, "Kdf", "kdf") != nil ? parseKdf(obj) : nil
        return TokenResult(accessToken: token, expiresInSec: expires, key: key, kdf: kdf)
    }

    private var folderName: String { normalizedFolderName(settings.itemPrefix) }

    private func normalizedFolderName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return trimmed.isEmpty ? "ServerCase" : trimmed
    }

    private var legacyItemPrefix: String { folderName + "/" }

    private func normalizedItemName(_ itemName: String) -> String {
        let trimmed = itemName.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let withoutFolder = trimmed.hasPrefix(legacyItemPrefix)
            ? String(trimmed.dropFirst(legacyItemPrefix.count))
            : trimmed
        return withoutFolder.isEmpty ? "Server" : withoutFolder
    }

    private func fetchSync() async throws -> SyncSnapshot {
        try assertUnlocked()
        let data = try await api("GET", "/sync?excludeDomains=true", body: nil)
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let rawCiphers = (pick(obj, "Ciphers", "ciphers") as? [[String: Any]]) ?? []
        let rawFolders = (pick(obj, "Folders", "folders") as? [[String: Any]]) ?? []
        return SyncSnapshot(
            ciphers: rawCiphers.map(Cipher.init),
            folders: rawFolders.map(Folder.init)
        )
    }

    private func fetchCiphers() async throws -> [Cipher] {
        try await fetchSync().ciphers
    }

    private func serverCaseFolderId(in folders: [Folder]) -> String? {
        guard let enc = try? encKey(), let mac = try? macKey() else { return nil }
        return folders.first { folder in
            decryptWith(folder.name, enc, mac) == folderName
        }?.id
    }

    private func ensureServerCaseFolderId() async throws -> String {
        let snapshot = try await fetchSync()
        if let id = serverCaseFolderId(in: snapshot.folders) {
            return id
        }

        let body = try JSONSerialization.data(withJSONObject: [
            "name": try encryptField(folderName)
        ])
        let data = try await api("POST", "/folders", body: body)
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let id = pick(obj, "Id", "id") as? String else {
            throw BitwardenError.request("Bitwarden folder create response missing id")
        }
        return id
    }

    private func setSSHKeyItem(_ itemName: String, privateKey: String) async throws {
        let folderId = try await ensureServerCaseFolderId()
        let body: [String: Any] = [
            "type": 5,
            "name": try encryptField(normalizedItemName(itemName)),
            "notes": NSNull(),
            "favorite": false,
            "folderId": folderId,
            "organizationId": NSNull(),
            "sshKey": [
                "privateKey": try encryptField(privateKey),
                "publicKey": NSNull(),
                "keyFingerprint": NSNull(),
            ],
        ]
        let payload = try JSONSerialization.data(withJSONObject: body)
        if let existing = try await findCipher(itemName) {
            _ = try await api("PUT", "/ciphers/\(existing.id)", body: payload)
        } else {
            _ = try await api("POST", "/ciphers", body: payload)
        }
    }

    private func findCipher(_ itemName: String, aliases: [String] = []) async throws -> Cipher? {
        try findCipher(itemName, aliases: aliases, in: try await fetchCiphers())
    }

    private func findCipher(_ itemName: String, aliases: [String] = [], in ciphers: [Cipher]) throws -> Cipher? {
        let primary = normalizedItemName(itemName)
        let normalizedAliases = aliases.map(normalizedItemName)
            .filter { !$0.isEmpty && $0 != primary }
        let exactNames = [primary] + normalizedAliases
        let legacyNames = exactNames.map { legacyItemPrefix + $0 }

        for expectedName in exactNames + legacyNames {
            if let match = findCipherByExactName(expectedName, in: ciphers) {
                return match
            }
        }
        return nil
    }

    private func findCipherByExactName(_ itemName: String, in ciphers: [Cipher]) -> Cipher? {
        ciphers.first { cipher in
            guard let (enc, mac) = try? cipherKeys(cipher),
                  let name = decryptWith(cipher.name, enc, mac) else { return false }
            return name == itemName
        }
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

    private func masterPasswordHash(masterKey: Data, masterPassword: String) -> String {
        pbkdf2(masterKey, salt: Data(masterPassword.utf8), iterations: 1, keyLength: 32)
            .base64EncodedString()
    }

    private func pbkdf2(_ password: Data, salt: Data, iterations: Int, keyLength: Int) -> Data {
        var derived = Data(repeating: 0, count: keyLength)
        _ = derived.withUnsafeMutableBytes { out in
            password.withUnsafeBytes { passwordBytes in
                salt.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        passwordBytes.bindMemory(to: Int8.self).baseAddress,
                        password.count,
                        saltBytes.bindMemory(to: UInt8.self).baseAddress,
                        salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        UInt32(iterations),
                        out.bindMemory(to: UInt8.self).baseAddress,
                        keyLength
                    )
                }
            }
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
        let outCount = out.count
        var moved = 0
        let status = out.withUnsafeMutableBytes { outB in
            data.withUnsafeBytes { dataB in
                iv.withUnsafeBytes { ivB in
                    key.withUnsafeBytes { keyB in
                        CCCrypt(operation, CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                                keyB.baseAddress, key.count,
                                ivB.baseAddress,
                                dataB.baseAddress, data.count,
                                outB.baseAddress, outCount, &moved)
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
    let memory: Int
    let parallelism: Int
}

private struct TokenResult {
    let accessToken: String
    let expiresInSec: Double
    let key: String
    let kdf: KdfInfo?
}

private struct SyncSnapshot {
    let ciphers: [Cipher]
    let folders: [Folder]
}

private struct Folder {
    let id: String
    let name: String?

    init(_ raw: [String: Any]) {
        func pick(_ keys: String...) -> Any? {
            for k in keys { if let v = raw[k], !(v is NSNull) { return v } }
            return nil
        }
        id = (pick("Id", "id") as? String) ?? ""
        name = pick("Name", "name") as? String
    }
}

private struct CipherField {
    let name: String?
    let value: String?

    init(_ raw: [String: Any]) {
        func pick(_ keys: String...) -> Any? {
            for k in keys { if let v = raw[k], !(v is NSNull) { return v } }
            return nil
        }
        name = pick("Name", "name") as? String
        value = pick("Value", "value") as? String
    }
}

private struct Cipher {
    let id: String
    let type: Int
    let name: String?
    let folderId: String?
    let notes: String?
    let key: String?
    let username: String?
    let password: String?
    let sshPrivateKey: String?
    let fields: [CipherField]

    init(_ raw: [String: Any]) {
        func pick(_ keys: String...) -> Any? {
            for k in keys { if let v = raw[k], !(v is NSNull) { return v } }
            return nil
        }
        id = (pick("Id", "id") as? String) ?? ""
        type = (pick("Type", "type") as? Int) ?? 0
        name = pick("Name", "name") as? String
        folderId = pick("FolderId", "folderId") as? String
        notes = pick("Notes", "notes") as? String
        key = pick("Key", "key") as? String
        let login = (pick("Login", "login") as? [String: Any]) ?? [:]
        func loginPick(_ keys: String...) -> String? {
            for k in keys { if let v = login[k], !(v is NSNull) { return v as? String } }
            return nil
        }
        username = loginPick("Username", "username")
        password = loginPick("Password", "password")
        let sshKey = (pick("SshKey", "sshKey", "SSHKey") as? [String: Any]) ?? [:]
        func sshPick(_ keys: String...) -> String? {
            for k in keys { if let v = sshKey[k], !(v is NSNull) { return v as? String } }
            return nil
        }
        sshPrivateKey = sshPick("PrivateKey", "privateKey")
        let rawFields = (pick("Fields", "fields") as? [[String: Any]]) ?? []
        fields = rawFields.map(CipherField.init)
    }
}

import Foundation
import Citadel
import NIOCore

enum SSHServiceError: LocalizedError {
    case notConnected
    case keyAuthUnsupported

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Not connected"
        case .keyAuthUnsupported:
            return "Private-key auth is not yet supported on iOS. Use password auth for now."
        }
    }
}

/// One Citadel SSH connection to a server. `run` is used for the status command;
/// the terminal runs individual commands through the same connection.
actor SSHService {
    private let config: ServerConfig
    private var client: SSHClient?

    init(config: ServerConfig) {
        self.config = config
    }

    var isConnected: Bool { client != nil }

    func connect() async throws {
        guard client == nil else { return }
        let auth: SSHAuthenticationMethod
        switch config.authType {
        case .password:
            auth = .passwordBased(username: config.username, password: config.password ?? "")
        case .key:
            // NIOSSH/Citadel PEM import is intentionally left as a follow-up so
            // we don't ship an unverified key-parsing path.
            throw SSHServiceError.keyAuthUnsupported
        }

        client = try await SSHClient.connect(
            host: config.host,
            port: config.port,
            authenticationMethod: auth,
            hostKeyValidator: .acceptAnything(),
            reconnect: .never
        )
    }

    /// Run a command to completion and return merged stdout/stderr as text.
    func run(_ command: String) async throws -> String {
        guard let client else { throw SSHServiceError.notConnected }
        var buffer = try await client.executeCommand(command, mergeStreams: true)
        return buffer.readString(length: buffer.readableBytes) ?? ""
    }

    func disconnect() async {
        try? await client?.close()
        client = nil
    }
}

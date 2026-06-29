import Foundation
import Citadel
import NIOCore
@preconcurrency import NIOSSH

enum SSHServiceError: LocalizedError {
    case notConnected
    case keyAuthUnsupported
    case terminalNotOpen

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Not connected"
        case .keyAuthUnsupported:
            return "Private-key auth is not yet supported on iOS. Use password auth for now."
        case .terminalNotOpen:
            return "Terminal is still opening"
        }
    }
}

struct TerminalSession: Identifiable {
    let id: UUID
    let output: AsyncThrowingStream<Data, Error>
}

/// One Citadel SSH connection to a server. `run` is used for status/file
/// commands; terminals use long-lived PTY shell channels over the same SSH
/// connection.
actor SSHService {
    private let config: ServerConfig
    private var client: SSHClient?
    private var terminalWriters: [UUID: TTYStdinWriter] = [:]
    private var terminalTasks: [UUID: Task<Void, Never>] = [:]

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

    /// Opens a direct-tcpip tunnel from the server to `host:port`. The in-app
    /// SOCKS proxy that backs the proxy browser opens one of these per request,
    /// multiplexed over this single SSH connection.
    func openTunnel(host: String, port: Int) async throws -> SSHTunnel {
        guard let client else { throw SSHServiceError.notConnected }
        let inbound = SSHTunnelInboundHandler()
        let originator = try SocketAddress(ipAddress: "127.0.0.1", port: 0)
        let channel = try await client.createDirectTCPIPChannel(
            using: SSHChannelType.DirectTCPIP(
                targetHost: host,
                targetPort: port,
                originatorAddress: originator
            )
        ) { channel in
            channel.pipeline.addHandler(inbound)
        }
        return SSHTunnel(channel: channel, inbound: inbound)
    }

    func openTerminal(cols: Int = 120, rows: Int = 32) throws -> TerminalSession {
        guard let client else { throw SSHServiceError.notConnected }

        let id = UUID()
        let output = AsyncThrowingStream<Data, Error>(bufferingPolicy: .unbounded) { continuation in
            let task = Task {
                do {
                    let request = SSHChannelRequestEvent.PseudoTerminalRequest(
                        wantReply: true,
                        term: "xterm-256color",
                        terminalCharacterWidth: cols,
                        terminalRowHeight: rows,
                        terminalPixelWidth: 0,
                        terminalPixelHeight: 0,
                        terminalModes: .init([.ECHO: 1])
                    )

                    try await client.withPTYExec(request, command: loginShellBootstrapCommand) { inbound, outbound in
                        self.registerTerminal(id: id, writer: outbound)
                        for try await event in inbound {
                            switch event {
                            case .stdout(let buffer), .stderr(let buffer):
                                if let data = terminalData(from: buffer), !data.isEmpty {
                                    continuation.yield(data)
                                }
                            }
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
                self.unregisterTerminal(id: id)
            }

            Task { self.registerTerminalTask(id: id, task: task) }
            continuation.onTermination = { _ in
                task.cancel()
                Task { await self.closeTerminal(id) }
            }
        }

        return TerminalSession(id: id, output: output)
    }

    func writeTerminal(_ id: UUID, data: String) async throws {
        try await writeTerminal(id, bytes: ArraySlice(data.utf8))
    }

    func writeTerminal(_ id: UUID, bytes: ArraySlice<UInt8>) async throws {
        guard let writer = terminalWriters[id] else { throw SSHServiceError.terminalNotOpen }
        try await writer.write(ByteBuffer(bytes: bytes))
    }

    func resizeTerminal(_ id: UUID, cols: Int, rows: Int) async throws {
        guard let writer = terminalWriters[id] else { return }
        try await writer.changeSize(cols: cols, rows: rows, pixelWidth: 0, pixelHeight: 0)
    }

    func closeTerminal(_ id: UUID) async {
        if let writer = terminalWriters[id] {
            try? await writer.write(ByteBuffer(string: "exit\n"))
        }
        terminalTasks[id]?.cancel()
        terminalTasks[id] = nil
        terminalWriters[id] = nil
    }

    func disconnect() async {
        for id in terminalTasks.keys {
            await closeTerminal(id)
        }
        try? await client?.close()
        client = nil
    }

    private func registerTerminal(id: UUID, writer: TTYStdinWriter) {
        terminalWriters[id] = writer
    }

    private func registerTerminalTask(id: UUID, task: Task<Void, Never>) {
        terminalTasks[id] = task
    }

    private func unregisterTerminal(id: UUID) {
        terminalWriters[id] = nil
        terminalTasks[id] = nil
    }
}

private let loginShellBootstrapCommand = "motd_shown=0; if [ -r /run/motd.dynamic ]; then cat /run/motd.dynamic; motd_shown=1; elif command -v run-parts >/dev/null 2>&1 && [ -d /etc/update-motd.d ]; then run-parts /etc/update-motd.d 2>/dev/null; motd_shown=1; elif [ -r /etc/motd ]; then cat /etc/motd; motd_shown=1; fi; if [ \"$motd_shown\" = 1 ]; then printf '\\r\\n'; fi; shell=${SHELL:-/bin/sh}; case \"$shell\" in */bash|*/zsh|*/ksh|*/fish) stty echo 2>/dev/null; exec \"$shell\" -l ;; *) stty echo 2>/dev/null; exec \"$shell\" ;; esac"

private func terminalData(from buffer: ByteBuffer) -> Data? {
    guard let bytes = buffer.getBytes(at: buffer.readerIndex, length: buffer.readableBytes) else {
        return nil
    }
    return Data(bytes)
}

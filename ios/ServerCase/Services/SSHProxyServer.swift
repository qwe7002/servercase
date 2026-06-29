import Foundation
import Network

/// A loopback SOCKS5 proxy whose outbound TCP connections are tunnelled over an
/// SSH connection (direct-tcpip). The proxy browser points WKWebView at this so
/// every page load exits from the server, not the device. DNS is resolved
/// server-side: WKWebView's SOCKSv5 client sends the hostname, and we forward it
/// verbatim to the SSH server.
actor SSHProxyServer {
    typealias TunnelFactory = @Sendable (_ host: String, _ port: Int) async throws -> SSHTunnel

    enum SSHProxyError: Error {
        case cancelled
        case badRequest
        case unsupported
        case noPort
    }

    private let openTunnel: TunnelFactory
    private var listener: NWListener?
    private var boundPort: UInt16?
    private let queue = DispatchQueue(label: "com.servercase.proxy.listener")

    init(openTunnel: @escaping TunnelFactory) {
        self.openTunnel = openTunnel
    }

    var port: UInt16? { boundPort }

    /// Starts the listener on 127.0.0.1 and resolves with the bound port.
    func start() async throws -> UInt16 {
        if let boundPort { return boundPort }

        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        params.allowLocalEndpointReuse = true

        let listener = try NWListener(using: params)
        self.listener = listener

        let opener = self.openTunnel
        listener.newConnectionHandler = { connection in
            // Each client connection is independent.
            Task.detached { await SSHProxyServer.serve(connection, openTunnel: opener) }
        }

        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard !resumed else { return }
                    resumed = true
                    if let port = listener.port?.rawValue {
                        continuation.resume(returning: port)
                    } else {
                        continuation.resume(throwing: SSHProxyError.noPort)
                    }
                case .failed(let error):
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(throwing: error)
                case .cancelled:
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(throwing: SSHProxyError.cancelled)
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }

        self.boundPort = port
        return port
    }

    func stop() {
        listener?.cancel()
        listener = nil
        boundPort = nil
    }
}

// MARK: - SOCKS5 per-connection handling

extension SSHProxyServer {
    private static func serve(_ connection: NWConnection, openTunnel: TunnelFactory) async {
        connection.start(queue: DispatchQueue(label: "com.servercase.proxy.conn"))
        do {
            let (host, port) = try await handshake(connection)
            do {
                let tunnel = try await openTunnel(host, port)
                try await sendReply(connection, success: true)
                await relay(connection, tunnel: tunnel)
            } catch {
                try? await sendReply(connection, success: false)
                connection.cancel()
            }
        } catch {
            connection.cancel()
        }
    }

    /// SOCKS5 method negotiation + CONNECT request parse. Returns the requested
    /// target host and port without yet sending the final reply.
    private static func handshake(_ connection: NWConnection) async throws -> (String, Int) {
        // Greeting: VER, NMETHODS, METHODS...
        let greeting = try await receiveExactly(connection, 2)
        guard greeting[greeting.startIndex] == 0x05 else { throw SSHProxyError.badRequest }
        let methodCount = Int(greeting[greeting.startIndex + 1])
        if methodCount > 0 { _ = try await receiveExactly(connection, methodCount) }
        // Select "no authentication".
        try await send(connection, Data([0x05, 0x00]))

        // Request: VER, CMD, RSV, ATYP, ADDR, PORT
        let head = try await receiveExactly(connection, 4)
        guard head[head.startIndex] == 0x05 else { throw SSHProxyError.badRequest }
        guard head[head.startIndex + 1] == 0x01 else { throw SSHProxyError.unsupported } // CONNECT only

        let host: String
        switch head[head.startIndex + 3] {
        case 0x01: // IPv4
            let addr = try await receiveExactly(connection, 4)
            host = addr.map { "\($0)" }.joined(separator: ".")
        case 0x03: // domain name
            let lengthByte = try await receiveExactly(connection, 1)
            let length = Int(lengthByte[lengthByte.startIndex])
            let addr = try await receiveExactly(connection, length)
            host = String(decoding: addr, as: UTF8.self)
        case 0x04: // IPv6
            let addr = try await receiveExactly(connection, 16)
            host = ipv6String(addr)
        default:
            throw SSHProxyError.unsupported
        }

        let portBytes = try await receiveExactly(connection, 2)
        let port = Int(portBytes[portBytes.startIndex]) << 8 | Int(portBytes[portBytes.startIndex + 1])
        return (host, port)
    }

    private static func sendReply(_ connection: NWConnection, success: Bool) async throws {
        // VER, REP, RSV, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0
        let reply = Data([0x05, success ? 0x00 : 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        try await send(connection, reply)
    }

    /// Pumps bytes both ways until either side closes.
    private static func relay(_ connection: NWConnection, tunnel: SSHTunnel) async {
        let uplink = Task {
            do {
                while true {
                    let data = try await receiveOnce(connection, min: 1, max: 64 * 1024)
                    if data.isEmpty { break }
                    tunnel.write(data)
                }
            } catch {
                // Treat any read error as end-of-stream.
            }
            tunnel.close()
        }

        for await chunk in tunnel.incoming {
            do {
                try await send(connection, chunk)
            } catch {
                break
            }
        }

        uplink.cancel()
        tunnel.close()
        connection.cancel()
    }

    // MARK: NWConnection async helpers

    private static func receiveExactly(_ connection: NWConnection, _ count: Int) async throws -> Data {
        var buffer = Data()
        while buffer.count < count {
            let chunk = try await receiveOnce(connection, min: count - buffer.count, max: count - buffer.count)
            if chunk.isEmpty { throw SSHProxyError.badRequest }
            buffer.append(chunk)
        }
        return buffer
    }

    private static func receiveOnce(_ connection: NWConnection, min: Int, max: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: min, maximumLength: max) { data, _, isComplete, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data, !data.isEmpty {
                    continuation.resume(returning: data)
                } else if isComplete {
                    continuation.resume(returning: Data())
                } else {
                    continuation.resume(returning: Data())
                }
            }
        }
    }

    private static func send(_ connection: NWConnection, _ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private static func ipv6String(_ data: Data) -> String {
        stride(from: 0, to: 16, by: 2).map { offset in
            let high = Int(data[data.startIndex + offset]) << 8
            let low = Int(data[data.startIndex + offset + 1])
            return String(format: "%x", high | low)
        }.joined(separator: ":")
    }
}

import Foundation
import NIOCore
@preconcurrency import NIOSSH

enum SSHTunnelError: Error {
    case invalidChannelData
}

/// Bridges inbound bytes from a direct-tcpip channel to an `AsyncStream` the
/// proxy can consume, and finishes the stream when the channel closes.
final class SSHTunnelInboundHandler: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer

    let stream: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    var onClose: (@Sendable () -> Void)?

    init() {
        var continuation: AsyncStream<Data>.Continuation!
        self.stream = AsyncStream(bufferingPolicy: .unbounded) { continuation = $0 }
        self.continuation = continuation
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var buffer = self.unwrapInboundIn(data)
        if let bytes = buffer.readBytes(length: buffer.readableBytes), !bytes.isEmpty {
            continuation.yield(Data(bytes))
        }
    }

    func channelInactive(context: ChannelHandlerContext) {
        finish()
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        finish()
        context.close(promise: nil)
    }

    private func finish() {
        onClose?()
        continuation.finish()
    }
}

/// A live direct-tcpip tunnel over an SSH connection. Bytes written are sent to
/// the remote target; `incoming` yields bytes received back from it.
final class SSHTunnel: @unchecked Sendable {
    private let channel: Channel
    private let stateQueue = DispatchQueue(label: "com.servercase.ssh-tunnel.state")
    private var closed = false
    let incoming: AsyncStream<Data>

    init(channel: Channel, inbound: SSHTunnelInboundHandler) {
        self.channel = channel
        self.incoming = inbound.stream
        inbound.onClose = { [weak self] in
            self?.markClosed()
        }
    }

    /// `writeAndFlush` is performed on the channel's event loop. That keeps the
    /// active-state check ordered with close/inactive events and avoids writes
    /// racing a closed SSH child channel.
    func write(_ data: Data) {
        guard !data.isEmpty, !isClosed else { return }
        channel.eventLoop.execute { [weak self] in
            guard let self, !self.isClosed, self.channel.isActive else { return }
            var buffer = self.channel.allocator.buffer(capacity: data.count)
            buffer.writeBytes(data)
            self.channel.writeAndFlush(buffer, promise: nil)
        }
    }

    func close() {
        guard markClosed() else { return }
        channel.eventLoop.execute { [channel] in
            if channel.isActive {
                channel.close(promise: nil)
            }
        }
    }

    @discardableResult
    private func markClosed() -> Bool {
        stateQueue.sync {
            guard !closed else { return false }
            closed = true
            return true
        }
    }

    private var isClosed: Bool {
        stateQueue.sync { closed }
    }
}

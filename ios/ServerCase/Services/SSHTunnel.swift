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
        continuation.finish()
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        continuation.finish()
        context.close(promise: nil)
    }
}

/// A live direct-tcpip tunnel over an SSH connection. Bytes written are sent to
/// the remote target; `incoming` yields bytes received back from it.
final class SSHTunnel: @unchecked Sendable {
    private let channel: Channel
    let incoming: AsyncStream<Data>

    init(channel: Channel, inbound: SSHTunnelInboundHandler) {
        self.channel = channel
        self.incoming = inbound.stream
    }

    /// `writeAndFlush` hops to the channel's event loop, so this is safe to call
    /// from the proxy's connection queue.
    func write(_ data: Data) {
        guard !data.isEmpty else { return }
        var buffer = channel.allocator.buffer(capacity: data.count)
        buffer.writeBytes(data)
        channel.writeAndFlush(buffer, promise: nil)
    }

    func close() {
        channel.close(promise: nil)
    }
}

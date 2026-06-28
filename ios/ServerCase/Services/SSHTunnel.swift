import Foundation
import NIOCore
@preconcurrency import NIOSSH

enum SSHTunnelError: Error {
    case invalidChannelData
}

/// Wraps/unwraps between raw `ByteBuffer` and NIOSSH's `SSHChannelData`, so the
/// rest of a direct-tcpip channel's pipeline can speak plain bytes. Mirrors the
/// handler used in apple/swift-nio-ssh's port-forwarding example.
final class SSHChannelDataWrapper: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = SSHChannelData
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = SSHChannelData

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let data = self.unwrapInboundIn(data)
        guard case .channel = data.type, case .byteBuffer(let buffer) = data.data else {
            context.fireErrorCaught(SSHTunnelError.invalidChannelData)
            return
        }
        context.fireChannelRead(self.wrapInboundOut(buffer))
    }

    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        let buffer = self.unwrapOutboundIn(data)
        let wrapped = SSHChannelData(type: .channel, data: .byteBuffer(buffer))
        context.write(self.wrapOutboundOut(wrapped), promise: promise)
    }
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

import GameController
import SwiftTerm
import SwiftUI

/// A native terminal emulator backed by SwiftTerm. SSH bytes are bridged
/// directly into the emulator, so ANSI/VT control sequences, cursor movement,
/// alternate screens, selection, and keyboard input are handled by SwiftTerm
/// instead of a SwiftUI text view.
struct TerminalView: View {
    @EnvironmentObject private var model: AppModel
    let server: ServerConfig

    @StateObject private var bridge = TerminalBridge()

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if let service = model.service(server.id) {
                SwiftTermTerminalView(service: service, bridge: bridge)
                    .ignoresSafeArea(.keyboard, edges: .bottom)
            } else {
                ContentUnavailableView(
                    "Not connected",
                    systemImage: "terminal",
                    description: Text("Connect to open a terminal.")
                )
            }

            if !model.settings.snippets.isEmpty {
                Menu {
                    ForEach(model.settings.snippets) { snippet in
                        Button(snippet.name) {
                            bridge.send(snippet.command + "\n")
                        }
                    }
                } label: {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 32)
                        .background(.black.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .padding(10)
            }
        }
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private final class TerminalBridge: ObservableObject {
    private weak var coordinator: SwiftTermTerminalView.Coordinator?

    func attach(_ coordinator: SwiftTermTerminalView.Coordinator) {
        self.coordinator = coordinator
    }

    func send(_ text: String) {
        coordinator?.send(text)
    }
}

/// A SwiftTerm terminal view that hides the on-screen extended keyboard
/// (SwiftTerm's `inputAccessoryView`) whenever a hardware keyboard is attached,
/// matching the OS behaviour of suppressing the software keyboard. Detection
/// uses GameController's `GCKeyboard`.
private final class HardwareAwareTerminalView: SwiftTerm.TerminalView {
    private var hardwareKeyboardConnected = false {
        didSet {
            guard hardwareKeyboardConnected != oldValue else { return }
            reloadInputViews()
        }
    }

    // SwiftTerm overrides `inputAccessoryView` as read/write (backed by its
    // `_inputAccessory`), so this override must stay read/write too — Swift
    // forbids narrowing a settable property to get-only. The getter simply
    // hides the accessory while a hardware keyboard is attached.
    override var inputAccessoryView: UIView? {
        get { hardwareKeyboardConnected ? nil : super.inputAccessoryView }
        set { super.inputAccessoryView = newValue }
    }

    func startMonitoringHardwareKeyboard() {
        hardwareKeyboardConnected = GCKeyboard.coalesced != nil
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(hardwareKeyboardChanged),
                       name: .GCKeyboardDidConnect, object: nil)
        nc.addObserver(self, selector: #selector(hardwareKeyboardChanged),
                       name: .GCKeyboardDidDisconnect, object: nil)
    }

    @objc private func hardwareKeyboardChanged() {
        DispatchQueue.main.async { [weak self] in
            self?.hardwareKeyboardConnected = GCKeyboard.coalesced != nil
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}

private struct SwiftTermTerminalView: UIViewRepresentable {
    let service: SSHService
    let bridge: TerminalBridge

    func makeCoordinator() -> Coordinator {
        Coordinator(service: service, bridge: bridge)
    }

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let terminal = HardwareAwareTerminalView(
            frame: .zero,
            font: .monospacedSystemFont(ofSize: 13, weight: .regular)
        )
        terminal.startMonitoringHardwareKeyboard()
        terminal.terminalDelegate = context.coordinator
        terminal.nativeBackgroundColor = UIColor(red: 0.04, green: 0.05, blue: 0.07, alpha: 1)
        terminal.nativeForegroundColor = UIColor(red: 0.84, green: 0.86, blue: 0.9, alpha: 1)
        terminal.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        context.coordinator.attach(terminal)
        bridge.attach(context.coordinator)

        DispatchQueue.main.async {
            _ = terminal.becomeFirstResponder()
        }

        return terminal
    }

    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {
        context.coordinator.update(service: service, terminal: uiView)
        bridge.attach(context.coordinator)
    }

    static func dismantleUIView(_ uiView: SwiftTerm.TerminalView, coordinator: Coordinator) {
        coordinator.close()
        uiView.terminalDelegate = nil
    }

    final class Coordinator: NSObject, SwiftTerm.TerminalViewDelegate {
        private var service: SSHService
        private weak var terminal: SwiftTerm.TerminalView?
        private weak var bridge: TerminalBridge?
        private var session: TerminalSession?
        private var readerTask: Task<Void, Never>?
        private var openingTask: Task<Void, Never>?
        private var pendingWrites: [ArraySlice<UInt8>] = []

        init(service: SSHService, bridge: TerminalBridge) {
            self.service = service
            self.bridge = bridge
        }

        func attach(_ terminal: SwiftTerm.TerminalView) {
            self.terminal = terminal
            openIfNeeded(for: terminal)
        }

        func update(service: SSHService, terminal: SwiftTerm.TerminalView) {
            if self.service !== service {
                close()
                self.service = service
            }
            attach(terminal)
        }

        func send(_ text: String) {
            send(bytes: ArraySlice(text.utf8))
        }

        func close() {
            openingTask?.cancel()
            openingTask = nil
            readerTask?.cancel()
            readerTask = nil

            guard let id = session?.id else {
                session = nil
                return
            }
            session = nil
            let service = service
            Task { await service.closeTerminal(id) }
        }

        private func openIfNeeded(for terminal: SwiftTerm.TerminalView) {
            guard session == nil, openingTask == nil else { return }
            let size = terminal.getTerminal()
            let cols = max(size.cols, 80)
            let rows = max(size.rows, 24)
            let service = service

            openingTask = Task { [weak self] in
                guard let self else { return }
                do {
                    let opened = try await service.openTerminal(cols: cols, rows: rows)
                    await MainActor.run {
                        self.session = opened
                        self.openingTask = nil
                        self.flushPendingWrites()
                    }

                    for try await chunk in opened.output {
                        await MainActor.run {
                            guard let terminal = self.terminal else { return }
                            let bytes = Array(chunk)
                            terminal.feed(byteArray: bytes[...])
                        }
                    }
                } catch is CancellationError {
                    await MainActor.run { self.openingTask = nil }
                } catch {
                    await MainActor.run {
                        self.openingTask = nil
                        self.terminal?.feed(text: "\r\n[terminal] \(error.localizedDescription)\r\n")
                    }
                }
            }
        }

        private func send(bytes: ArraySlice<UInt8>) {
            guard let id = session?.id else {
                pendingWrites.append(bytes)
                return
            }
            let service = service
            Task {
                do {
                    try await service.writeTerminal(id, bytes: bytes)
                } catch {
                    await MainActor.run { [weak terminal] in
                        terminal?.feed(text: "\r\n[terminal] \(error.localizedDescription)\r\n")
                    }
                }
            }
        }

        private func flushPendingWrites() {
            let writes = pendingWrites
            pendingWrites.removeAll()
            for bytes in writes {
                send(bytes: bytes)
            }
        }

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            send(bytes: data)
        }

        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            guard let id = session?.id else { return }
            let service = service
            Task { try? await service.resizeTerminal(id, cols: newCols, rows: newRows) }
        }

        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}

        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link) else { return }
            UIApplication.shared.open(url)
        }

        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            UIPasteboard.general.string = String(data: content, encoding: .utf8)
        }
    }
}

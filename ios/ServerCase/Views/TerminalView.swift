import GameController
import SwiftTerm
import SwiftUI

struct TerminalTabsView: View {
    let server: ServerConfig

    @State private var tabs: [TerminalTab] = [TerminalTab(index: 1)]
    @State private var selectedTabID: UUID?
    @State private var nextTabIndex = 2

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Divider()
            ZStack {
                ForEach(tabs) { tab in
                    TerminalView(server: server, isActive: tab.id == activeTabID)
                        .opacity(tab.id == activeTabID ? 1 : 0)
                        .allowsHitTesting(tab.id == activeTabID)
                        .accessibilityHidden(tab.id != activeTabID)
                }
            }
        }
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if selectedTabID == nil {
                selectedTabID = tabs.first?.id
            }
        }
    }

    private var activeTabID: UUID? {
        if let selectedTabID, tabs.contains(where: { $0.id == selectedTabID }) {
            return selectedTabID
        }
        return tabs.first?.id
    }

    private var tabBar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(tabs) { tab in
                        tabButton(tab)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }

            Button(action: addTab) {
                Image(systemName: "plus")
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("New terminal tab")
            .padding(.trailing, 8)
        }
        .background(Color(.systemBackground))
    }

    private func tabButton(_ tab: TerminalTab) -> some View {
        let isSelected = tab.id == activeTabID

        return HStack(spacing: 6) {
            Button {
                selectedTabID = tab.id
            } label: {
                Label(tab.title, systemImage: "terminal")
                    .lineLimit(1)
            }
            .buttonStyle(.plain)

            if tabs.count > 1 {
                Button {
                    closeTab(tab)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .imageScale(.small)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close \(tab.title)")
            }
        }
        .font(.caption.weight(isSelected ? .semibold : .regular))
        .foregroundStyle(isSelected ? .primary : .secondary)
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(isSelected ? Color(.secondarySystemBackground) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func addTab() {
        let tab = TerminalTab(index: nextTabIndex)
        nextTabIndex += 1
        tabs.append(tab)
        selectedTabID = tab.id
    }

    private func closeTab(_ tab: TerminalTab) {
        guard tabs.count > 1,
              let index = tabs.firstIndex(where: { $0.id == tab.id }) else {
            return
        }

        tabs.remove(at: index)
        if selectedTabID == tab.id {
            let replacementIndex = min(index, tabs.count - 1)
            selectedTabID = tabs[replacementIndex].id
        }
    }
}

private struct TerminalTab: Identifiable, Equatable {
    let id = UUID()
    let index: Int

    var title: String {
        "Terminal \(index)"
    }
}

/// A native terminal emulator backed by SwiftTerm. SSH bytes are bridged
/// directly into the emulator, so ANSI/VT control sequences, cursor movement,
/// alternate screens, selection, and keyboard input are handled by SwiftTerm
/// instead of a SwiftUI text view.
struct TerminalView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let server: ServerConfig
    /// When false (an inactive tab) the terminal gives up the keyboard.
    var isActive: Bool = true

    @StateObject private var bridge = TerminalBridge()

    var body: some View {
        let terminal = model.settings.terminal
        ZStack(alignment: .topTrailing) {
            if let service = model.service(server.id) {
                SwiftTermTerminalView(service: service, bridge: bridge, settings: terminal, isActive: isActive)
                    .padding(.horizontal, terminalHorizontalInset)
                    .padding(.vertical, terminalVerticalInset)
                    .background(Color(uiColor: UIColor(hex: terminal.colorScheme.backgroundHex)))
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

    private var terminalHorizontalInset: CGFloat {
        horizontalSizeClass == .regular ? 14 : 6
    }

    private var terminalVerticalInset: CGFloat {
        horizontalSizeClass == .regular ? 10 : 4
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

/// Hides the terminal's on-screen extended keyboard (SwiftTerm's
/// `inputAccessoryView`) whenever a hardware keyboard is attached, matching the
/// OS behaviour of suppressing the software keyboard. SwiftTerm exposes a
/// setter method for its accessory storage because the UIKit override is
/// read-only on newer SDKs. Detection uses GameController's `GCKeyboard`.
private final class HardwareKeyboardMonitor {
    private weak var terminal: SwiftTerm.TerminalView?
    /// SwiftTerm's accessory, retained while it is detached so we can restore it.
    private var savedAccessory: UIView?

    func start(for terminal: SwiftTerm.TerminalView) {
        self.terminal = terminal
        savedAccessory = terminal.inputAccessoryView
        apply()
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(keyboardChanged),
                       name: .GCKeyboardDidConnect, object: nil)
        nc.addObserver(self, selector: #selector(keyboardChanged),
                       name: .GCKeyboardDidDisconnect, object: nil)
    }

    @objc private func keyboardChanged() {
        DispatchQueue.main.async { [weak self] in self?.apply() }
    }

    private func apply() {
        guard let terminal else { return }
        // Keep our saved reference current whenever SwiftTerm has an accessory.
        if let current = terminal.inputAccessoryView { savedAccessory = current }
        let desired: UIView? = GCKeyboard.coalesced != nil ? nil : savedAccessory
        if terminal.inputAccessoryView !== desired {
            terminal.setInputAccessoryView(desired)
            terminal.reloadInputViews()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}

private struct SwiftTermTerminalView: UIViewRepresentable {
    let service: SSHService
    let bridge: TerminalBridge
    let settings: TerminalSettings
    let isActive: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(service: service, bridge: bridge)
    }

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let terminal = SwiftTerm.TerminalView(
            frame: .zero,
            font: .monospacedSystemFont(ofSize: CGFloat(settings.fontSize), weight: .regular)
        )
        terminal.terminalDelegate = context.coordinator
        applyAppearance(to: terminal)
        terminal.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        context.coordinator.attach(terminal)
        context.coordinator.startKeyboardMonitor(for: terminal)
        bridge.attach(context.coordinator)

        if isActive {
            DispatchQueue.main.async { _ = terminal.becomeFirstResponder() }
        }

        return terminal
    }

    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {
        context.coordinator.update(service: service, terminal: uiView)
        applyAppearance(to: uiView)
        // Only the active tab keeps the keyboard.
        if isActive {
            if !uiView.isFirstResponder {
                DispatchQueue.main.async { _ = uiView.becomeFirstResponder() }
            }
        } else if uiView.isFirstResponder {
            _ = uiView.resignFirstResponder()
        }
        bridge.attach(context.coordinator)
    }

    /// Applies the font size and color scheme (live on settings changes).
    private func applyAppearance(to terminal: SwiftTerm.TerminalView) {
        terminal.font = .monospacedSystemFont(ofSize: CGFloat(settings.fontSize), weight: .regular)
        terminal.nativeBackgroundColor = UIColor(hex: settings.colorScheme.backgroundHex)
        terminal.nativeForegroundColor = UIColor(hex: settings.colorScheme.foregroundHex)
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
        /// Latest size reported by the view; re-applied once the session opens,
        /// since the initial layout's `sizeChanged` usually fires first.
        private var pendingSize: (cols: Int, rows: Int)?
        private let keyboardMonitor = HardwareKeyboardMonitor()

        init(service: SSHService, bridge: TerminalBridge) {
            self.service = service
            self.bridge = bridge
        }

        func attach(_ terminal: SwiftTerm.TerminalView) {
            self.terminal = terminal
            openIfNeeded(for: terminal)
        }

        func startKeyboardMonitor(for terminal: SwiftTerm.TerminalView) {
            keyboardMonitor.start(for: terminal)
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
                        self.syncTerminalSize()
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
            pendingSize = (newCols, newRows)
            guard let id = session?.id else { return }
            let service = service
            Task { try? await service.resizeTerminal(id, cols: newCols, rows: newRows) }
        }

        /// Resizes the remote PTY to the view's current grid once the session is
        /// live, so full-screen apps (vim, htop…) fill the whole terminal even
        /// when the first layout pass happened before the SSH channel opened.
        private func syncTerminalSize() {
            guard let id = session?.id else { return }
            let cols: Int
            let rows: Int
            if let pending = pendingSize {
                cols = pending.cols
                rows = pending.rows
            } else if let t = terminal?.getTerminal() {
                cols = t.cols
                rows = t.rows
            } else {
                return
            }
            guard cols > 0, rows > 0 else { return }
            let service = service
            Task { try? await service.resizeTerminal(id, cols: cols, rows: rows) }
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

private extension UIColor {
    /// Builds a color from a 6-digit RGB hex string (e.g. "0b0d12").
    convenience init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&value)
        self.init(
            red: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: 1
        )
    }
}

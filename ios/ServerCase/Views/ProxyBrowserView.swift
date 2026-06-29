import SwiftUI
import WebKit
import Network

/// An in-app web browser whose traffic is tunnelled through the selected
/// server's SSH connection. A loopback SOCKS5 proxy (`SSHProxyServer`) backs a
/// `WKWebView` configured with a SOCKSv5 `ProxyConfiguration` (iOS 17+), so
/// every request exits from the server rather than the device.
struct ProxyBrowserView: View {
    @EnvironmentObject private var model: AppModel
    let server: ServerConfig

    @StateObject private var browser = ProxyBrowserModel()

    var body: some View {
        Group {
            switch browser.phase {
            case .idle, .starting:
                starting
            case .failed(let message):
                failure(message)
            case .ready:
                browserUI
            }
        }
        .navigationTitle("Browser")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { startIfPossible() }
        .onChange(of: model.state(server.id)) { _, _ in startIfPossible() }
        .onDisappear { browser.stop() }
    }

    private func startIfPossible() {
        if let service = model.service(server.id), model.state(server.id) == .connected {
            browser.start(service: service, serverName: server.name)
        } else {
            model.connectIfNeeded(server)
        }
    }

    // MARK: Phases

    private var starting: some View {
        VStack(spacing: 14) {
            ProgressView()
            Text(model.state(server.id) == .connected
                 ? "Starting proxy over \(server.name)…"
                 : "Establishing SSH connection…")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle).foregroundStyle(Palette.danger)
            Text("Proxy failed to start").font(.headline)
            Text(message)
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") { browser.reset(); startIfPossible() }
                .buttonStyle(.borderedProminent)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Browser chrome

    private var browserUI: some View {
        VStack(spacing: 0) {
            addressBar
            if browser.isLoading {
                ProgressView(value: browser.progress)
                    .progressViewStyle(.linear)
                    .frame(height: 2)
            }
            Divider()
            if let webView = browser.webView {
                WebViewContainer(webView: webView)
            }
            Divider()
            bottomBar
        }
    }

    private var addressBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "network.badge.shield.half.filled")
                .font(.caption).foregroundStyle(Palette.good)
            TextField("Search or enter address", text: $browser.urlText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.go)
                .onSubmit { browser.go() }
            if browser.isLoading {
                Button { browser.stopLoading() } label: { Image(systemName: "xmark") }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal).padding(.top, 8).padding(.bottom, 6)
    }

    private var bottomBar: some View {
        HStack {
            Button { browser.goBack() } label: { Image(systemName: "chevron.left") }
                .disabled(!browser.canGoBack)
            Spacer()
            Button { browser.goForward() } label: { Image(systemName: "chevron.right") }
                .disabled(!browser.canGoForward)
            Spacer()
            Text("via \(server.name)")
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.middle)
            Spacer()
            Button { browser.load(ProxyBrowserModel.homePage) } label: { Image(systemName: "house") }
            Spacer()
            Button { browser.reload() } label: { Image(systemName: "arrow.clockwise") }
                .disabled(browser.webView == nil)
        }
        .padding(.horizontal, 24).padding(.vertical, 10)
    }
}

private struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

@MainActor
final class ProxyBrowserModel: NSObject, ObservableObject {
    static let homePage = "https://www.bing.com"

    enum Phase: Equatable {
        case idle
        case starting
        case ready
        case failed(String)
    }

    @Published var phase: Phase = .idle
    @Published var urlText = ""
    @Published var canGoBack = false
    @Published var canGoForward = false
    @Published var isLoading = false
    @Published var progress = 0.0
    @Published var pageTitle = ""

    private(set) var webView: WKWebView?
    private var proxy: SSHProxyServer?
    private var observations: [NSKeyValueObservation] = []
    private var started = false

    func start(service: SSHService, serverName: String) {
        guard !started else { return }
        started = true
        phase = .starting
        Task {
            do {
                let proxy = SSHProxyServer { host, port in
                    try await service.openTunnel(host: host, port: port)
                }
                let port = try await proxy.start()
                self.proxy = proxy
                let webView = self.makeWebView(proxyPort: port)
                self.webView = webView
                self.observe(webView)
                self.phase = .ready
                self.load(Self.homePage)
            } catch {
                self.phase = .failed(error.localizedDescription)
                self.started = false
            }
        }
    }

    func stop() {
        observations.forEach { $0.invalidate() }
        observations = []
        webView?.stopLoading()
        let proxy = self.proxy
        Task { await proxy?.stop() }
    }

    /// Tears everything down so a retry starts from scratch.
    func reset() {
        stop()
        webView = nil
        proxy = nil
        started = false
        phase = .idle
    }

    private func makeWebView(proxyPort: UInt16) -> WKWebView {
        let config = WKWebViewConfiguration()
        let store = WKWebsiteDataStore.nonPersistent()
        if let port = NWEndpoint.Port(rawValue: proxyPort) {
            let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
            store.proxyConfigurations = [ProxyConfiguration(socksv5Proxy: endpoint)]
        }
        config.websiteDataStore = store
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        return webView
    }

    private func observe(_ webView: WKWebView) {
        observations = [
            webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] wv, _ in
                Task { @MainActor in self?.canGoBack = wv.canGoBack }
            },
            webView.observe(\.canGoForward, options: [.initial, .new]) { [weak self] wv, _ in
                Task { @MainActor in self?.canGoForward = wv.canGoForward }
            },
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in self?.progress = wv.estimatedProgress }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in self?.isLoading = wv.isLoading }
            },
            webView.observe(\.title, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in self?.pageTitle = wv.title ?? "" }
            },
            webView.observe(\.url, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in
                    if let url = wv.url?.absoluteString { self?.urlText = url }
                }
            },
        ]
    }

    // MARK: Navigation actions

    func go() {
        load(urlText)
    }

    func load(_ text: String) {
        guard let webView else { return }
        webView.load(URLRequest(url: Self.normalizeURL(text)))
    }

    func reload() { webView?.reload() }
    func stopLoading() { webView?.stopLoading() }
    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }

    /// Turns address-bar text into a URL: a full URL as-is, a bare domain into
    /// https, otherwise a Bing search.
    static func normalizeURL(_ text: String) -> URL {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), let scheme = url.scheme,
           scheme == "http" || scheme == "https" {
            return url
        }
        if trimmed.contains("."), !trimmed.contains(" "),
           let url = URL(string: "https://\(trimmed)") {
            return url
        }
        let query = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? trimmed
        return URL(string: "https://www.bing.com/search?q=\(query)")
            ?? URL(string: homePage)!
    }
}

extension ProxyBrowserModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        urlText = webView.url?.absoluteString ?? urlText
    }
}

# ServerCase — iOS (SwiftUI)

An iOS client for managing Linux servers over SSH. Built with
SwiftUI and [Citadel](https://github.com/orlandos-nl/Citadel) (pure-Swift SSH
over SwiftNIO).

## Features

- Add / edit / delete servers (password auth; private-key auth is a TODO)
- Live status dashboard: CPU%, memory, swap, per-mount disks, network
  throughput, load average and uptime — parsed from `/proc` + `df`
- Interactive SwiftTerm PTY terminal over the live SSH connection, with a
  snippet menu and **multiple tabs** per server
- Remote file manager (browse, view/edit text, mkdir, rename, delete,
  upload/download) over the live connection
- **Proxy browser** — an in-app `WKWebView` whose traffic exits from the server.
  A loopback SOCKS5 proxy (`SSHProxyServer`) forwards each request over an SSH
  `direct-tcpip` channel; the web view is pointed at it with a SOCKSv5
  `ProxyConfiguration` (iOS 17+), so pages load — and DNS resolves — server-side.
- **One-tap probe install** on a server's Overview: creates a cloud probe named
  after the host, installs it over SSH, and links it (mirrors the desktop
  dashboard). Probe hosts can still be managed in Settings.
- **Adaptive layout** — a single navigation stack on iPhone and a
  sidebar + detail split view on iPad (`NavigationSplitView`), which also
  unlocks landscape on iPad
- **Global settings** (gear in the server list):
  - **Keychain (Bitwarden)** — credentials are stored in your Bitwarden vault,
    reached directly over the Bitwarden REST API with a clean-room crypto
    implementation (no `bw` CLI). Authenticate with a personal API key; the
    master password derives the vault key locally (PBKDF2 or Argon2id, the
    latter via the Argon2Swift package). When off, secrets stay on-device and
    are never written to the sync file.
  - **Snippets** — reusable terminal commands.
  - **Terminal** — font size and color scheme for the SSH terminal (synced
    across devices via Cloud).
  - **Cloud** — sign in to a [ServerCase Worker](../worker) and push/pull your
    secret-free config across devices (optionally auto-pushing on change). The
    session token stays on-device and is never written to the synced payload.
- Server list persisted locally (Codable + UserDefaults)

## Architecture (MVVM)

```
Models/
  ServerConfig.swift      Codable server model
  ServerStatus.swift      Parsed status model
  Settings.swift          GlobalSettings / Snippet / Cloud / Bitwarden models
  StatusParser.swift      statusCommand + /proc parsing, CPU/net deltas
Services/
  SSHService.swift        Citadel connection (actor): exec + raw PTY streams + tunnels
  SSHTunnel.swift         direct-tcpip channel ↔ byte-stream bridge (NIOSSH handlers)
  SSHProxyServer.swift    loopback SOCKS5 proxy backing the proxy browser
  RemoteFiles.swift       command-based SFTP-style file operations
  BitwardenVault.swift    clean-room Bitwarden client (CommonCrypto + CryptoKit)
  SettingsStore.swift     UserDefaults settings persistence
  SyncService.swift       builds the secret-free config snapshot
  CloudService.swift      ServerCase Worker REST client (auth + sync + device)
  CloudSessionStore.swift local-only worker session token
  AppDelegate.swift       Firebase/FCM setup + registration-token forwarding
  ServerStore.swift       UserDefaults persistence
  AppModel.swift          @MainActor ObservableObject: state, vault, polling, cloud
Views/
  RootView.swift          picks the layout by horizontal size class
  ServerListView          iPhone navigation-stack list
  ServerSplitView         iPad sidebar + detail (NavigationSplitView)
  ServerListSupport.swift shared filtering/grouping + ServerRow + row actions
  ServerFormView / DashboardView / TerminalView
  SettingsView / FilesView / ProxyBrowserView
  Components/Indicators.swift  GaugeView + UsageBarView + StatusDot
  Format.swift            byte/rate/uptime formatting + palette
ServerCaseApp.swift       @main App entry
```

The file manager is command-based (over the SSH exec channel) rather than
relying on Citadel's SFTP API, so it needs nothing on the host beyond
coreutils. The Bitwarden keychain talks to the Bitwarden REST API directly.

## Build

The Xcode project is generated from `project.yml` with
[XcodeGen](https://github.com/yonaskolb/XcodeGen):

```bash
brew install xcodegen     # once
cd ios
xcodegen generate         # produces ServerCase.xcodeproj (SPM: Citadel, Firebase…)
open ServerCase.xcodeproj # build & run in Xcode (iOS 18+)
```

`ServerCase.xcodeproj` is **generated and gitignored** — it is not tracked in
git. `project.yml` globs the whole `ServerCase/` folder (`sources: - ServerCase`),
so any `.swift` file there is picked up automatically — but only when the project
is (re)generated. **Re-run `xcodegen generate` whenever files are added or
removed** (e.g. after `git pull` brings in new sources), otherwise Xcode builds
the stale project and reports `Cannot find '…' in scope` for the new types. If
Xcode is open, let it reload the project after regenerating (or close and
re-`open ServerCase.xcodeproj`).

## Push notifications (FCM)

Alerts from the [worker](../worker) arrive over FCM (APNs under the hood). To
enable them:

1. In the [Firebase console](https://console.firebase.google.com), add an iOS
   app with bundle id `com.servercase.app` and upload your APNs auth key.
2. Download `GoogleService-Info.plist` into `ServerCase/` (gitignored; see
   [`GoogleService-Info.plist.example`](ServerCase/GoogleService-Info.plist.example)).
3. Enable the Push Notifications capability for your signing team (the
   `aps-environment` entitlement is in `ServerCase/ServerCase.entitlements`).
4. On the worker, set the matching `FCM_SERVICE_ACCOUNT` secret.

`AppDelegate` configures Firebase and forwards the registration token; once
signed in to Cloud, `AppModel` registers it with the worker (`POST /v1/devices`).
**Without `GoogleService-Info.plist` the app still runs** — Firebase is only
configured when the file is present, so push stays off.

> Host-key verification currently accepts any key to keep first-run UX simple;
> a production build should pin/confirm host keys and store secrets in the
> Keychain.

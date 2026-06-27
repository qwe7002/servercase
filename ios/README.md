# ServerCase — iOS (SwiftUI)

An iOS client for managing Linux servers over SSH. Built with
SwiftUI and [Citadel](https://github.com/orlandos-nl/Citadel) (pure-Swift SSH
over SwiftNIO).

## Features

- Add / edit / delete servers (password auth; private-key auth is a TODO)
- Live status dashboard: CPU%, memory, swap, per-mount disks, network
  throughput, load average and uptime — parsed from `/proc` + `df`
- Interactive SwiftTerm PTY terminal over the live SSH connection, with a
  snippet menu
- Remote file manager (browse, view/edit text, mkdir, rename, delete,
  upload/download) over the live connection
- **Live Activity** (ActivityKit + WidgetKit) showing the live connection
  status and key performance numbers (CPU, memory, network throughput) on the
  Lock Screen and in the Dynamic Island, kept fresh from the 3s status poll
- **Background connection** — a background-task assertion extends the SSH
  connection and polling for a window after the app is backgrounded, and a
  `BGAppRefreshTask` periodically wakes the app to reconnect, sample once and
  refresh the Live Activity
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
  - **Auto-sync** — periodic JSON export of servers + settings (secrets
    excluded), with document-picker export/import.
- Server list persisted locally (Codable + UserDefaults)

## Architecture (MVVM)

```
Models/
  ServerConfig.swift      Codable server model
  ServerStatus.swift      Parsed status model
  Settings.swift          GlobalSettings / Snippet / AutoSync / Bitwarden models
  StatusParser.swift      statusCommand + /proc parsing, CPU/net deltas
Services/
  SSHService.swift        Citadel connection (actor): exec + raw PTY streams
  RemoteFiles.swift       command-based SFTP-style file operations
  BitwardenVault.swift    clean-room Bitwarden client (CommonCrypto + CryptoKit)
  SettingsStore.swift     UserDefaults settings persistence
  SyncService.swift       secret-free config export/import
  ServerStore.swift       UserDefaults persistence
  LiveActivityManager.swift  ActivityKit: start/update/end the connection activity
  BackgroundManager.swift    background-task assertion + BGAppRefreshTask
  AppModel.swift          @MainActor ObservableObject: state, vault, polling
Shared/                   compiled into both the app and the widget extension
  ServerActivityAttributes.swift  Live Activity attributes + content state
ServerCaseWidget/         WidgetKit app-extension (Live Activity UI)
  ServerCaseWidgetBundle.swift    @main widget bundle
  ServerActivityWidget.swift      Lock Screen + Dynamic Island views
Views/
  RootView.swift          picks the layout by horizontal size class
  ServerListView          iPhone navigation-stack list
  ServerSplitView         iPad sidebar + detail (NavigationSplitView)
  ServerListSupport.swift shared filtering/grouping + ServerRow + row actions
  ServerFormView / DashboardView / TerminalView
  SettingsView / FilesView
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
cd clients/ios
xcodegen generate         # produces ServerCase.xcodeproj (Citadel via SPM)
open ServerCase.xcodeproj # build & run in Xcode (iOS 17+)
```

> Host-key verification currently accepts any key to keep first-run UX simple;
> a production build should pin/confirm host keys and store secrets in the
> Keychain.

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
  SSHService.swift        Citadel connection (actor): exec + raw PTY streams
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
xcodegen generate         # produces ServerCase.xcodeproj (SPM: Citadel, Firebase…)
open ServerCase.xcodeproj # build & run in Xcode (iOS 18+)
```

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

# ServerCase — iOS (SwiftUI)

An iOS client for managing Linux servers over SSH. Built with
SwiftUI and [Citadel](https://github.com/orlandos-nl/Citadel) (pure-Swift SSH
over SwiftNIO).

## Features

- Add / edit / delete servers (password auth; private-key auth is a TODO)
- Live status dashboard: CPU%, memory, swap, per-mount disks, network
  throughput, load average and uptime — parsed from `/proc` + `df`
- Command console over the live SSH connection, with a snippet menu
- Remote file manager (browse, view/edit text, mkdir, rename, delete,
  upload/download) over the live connection
- **Global settings** (gear in the server list):
  - **Keychain (Bitwarden)** — credentials are stored in your Bitwarden vault
    through a `bw serve` REST bridge and sync end-to-end. When off, secrets
    stay on-device and are never written to the sync file.
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
  SSHService.swift        Citadel connection (actor): run() for commands
  RemoteFiles.swift       command-based SFTP-style file operations
  BitwardenVault.swift    actor talking to a `bw serve` REST bridge
  SettingsStore.swift     UserDefaults settings persistence
  SyncService.swift       secret-free config export/import
  ServerStore.swift       UserDefaults persistence
  AppModel.swift          @MainActor ObservableObject: state, vault, polling
Views/
  ServerListView / ServerFormView / DashboardView / TerminalView
  SettingsView / FilesView
  Components/Indicators.swift  GaugeView + UsageBarView + StatusDot
  Format.swift            byte/rate/uptime formatting + palette
ServerCaseApp.swift       @main App entry
```

The file manager and Bitwarden integration are command/REST based rather than
relying on Citadel's SFTP API, so they need nothing on the host beyond
coreutils and (for the keychain) a reachable `bw serve` endpoint.

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

# ServerCase — Android (Jetpack Compose)

An Android client for managing Linux servers over SSH. Built with
Jetpack Compose, Material 3 and SSHJ.

## Features

- Add / edit / delete servers (password or private-key auth)
- Live status dashboard: CPU%, memory, swap, per-mount disks, network
  throughput, load average and uptime — parsed from `/proc` + `df`
- Interactive SSH shell (line-oriented terminal) with a snippet menu
- Remote file manager (browse, view/edit text, mkdir, rename, delete,
  upload/download via SAF) over the live connection
- **Global settings** (gear in the server list):
  - **Keychain (Bitwarden)** — credentials are stored in your Bitwarden vault,
    reached directly over the Bitwarden REST API with a clean-room crypto
    implementation (no `bw` CLI). Authenticate with a personal API key; the
    master password derives the vault key locally. Only the PBKDF2 KDF is
    supported. When off, secrets stay on-device and are never written to the
    sync file.
  - **Snippets** — reusable terminal commands.
  - **Auto-sync** — periodic JSON export of servers + settings (secrets
    excluded), with SAF export/import.
- Server list persisted locally with DataStore (kotlinx.serialization)

## Architecture (MVVM)

```
data/
  ServerConfig.kt         Server model (@Serializable)
  ServerStatus.kt         Parsed status model
  Settings.kt             GlobalSettings / Snippet / AutoSync / Bitwarden models
  StatusParser.kt         STATUS_COMMAND + /proc parsing, CPU/net deltas
  ServerRepository.kt     DataStore-backed persistence
  SettingsRepository.kt   DataStore-backed settings persistence
  bitwarden/BitwardenVault.kt  clean-room Bitwarden client (javax.crypto)
  ssh/SshClient.kt        SSHJ connection: exec (status) + shell (terminal)
  ssh/RemoteFiles.kt      command-based SFTP-style file operations
vm/ServersViewModel.kt    StateFlow UiState, connections, vault, polling, sync
ui/
  theme/Theme.kt          Material3 dark theme + usage colors
  components/Indicators.kt Gauge + UsageBar
  ServerListScreen / ServerFormScreen / DashboardScreen / TerminalScreen
  SettingsScreen / FilesScreen
MainActivity.kt           Navigation-Compose host
```

## Build

Requires the Android SDK (set `sdk.dir` in `local.properties` or `ANDROID_HOME`).

```bash
./gradlew assembleDebug      # debug APK
./gradlew installDebug       # install on a connected device/emulator
```

> Host-key verification is currently promiscuous to keep first-run UX simple;
> a production build should pin/confirm host keys.

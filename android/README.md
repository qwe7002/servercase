# ServerCase — Android (Jetpack Compose)

An Android client for managing Linux servers over SSH. Built with
Jetpack Compose, Material 3 and SSHJ.

## Features

- Add / edit / delete servers (password or private-key auth)
- Live status dashboard: CPU%, memory, swap, per-mount disks, network
  throughput, load average and uptime — parsed from `/proc` + `df`
- Interactive SSH terminal — a real VT/ANSI emulator (ConnectBot's
  [`termlib`](https://github.com/connectbot/termlib), libvterm under the hood)
  with a snippet menu and **multiple tabs** per server
- Remote file manager (browse, view/edit text, mkdir, rename, delete,
  upload/download via SAF) over the live connection
- **Global settings** (gear in the server list):
  - **Keychain (Bitwarden)** — credentials are stored in your Bitwarden vault,
    reached directly over the Bitwarden REST API with a clean-room crypto
    implementation (no `bw` CLI). Authenticate with a personal API key; the
    master password derives the vault key locally (PBKDF2 or Argon2id, the
    latter via BouncyCastle). When off, secrets stay on-device and are never
    written to the sync file.
  - **Snippets** — reusable terminal commands.
  - **Terminal** — font size and color scheme for the SSH terminal
    (synced across devices via Cloud). The `scrollback` field is still synced
    for the other clients but is a no-op on Android: `termlib` manages its own
    scrollback buffer.
  - **Cloud** — sign in to a [ServerCase Worker](../worker) and push/pull your
    secret-free config across devices (optionally auto-pushing on change). The
    session token stays on-device and is never written to the synced payload.
- Server list persisted locally with DataStore (kotlinx.serialization)

## Architecture (MVVM)

```
data/
  ServerConfig.kt         Server model (@Serializable)
  ServerStatus.kt         Parsed status model
  Settings.kt             GlobalSettings / Snippet / Cloud / Bitwarden models
  StatusParser.kt         STATUS_COMMAND + /proc parsing, CPU/net deltas
  ServerRepository.kt     DataStore-backed persistence
  SettingsRepository.kt   DataStore-backed settings persistence
  CloudClient.kt          ServerCase Worker REST client (auth + sync)
  CloudSession.kt         local-only worker session token (DataStore)
  bitwarden/BitwardenVault.kt  clean-room Bitwarden client (javax.crypto)
  ssh/SshClient.kt        SSHJ connection: exec (status) + openShellBytes (raw
                          PTY byte stream feeding the termlib emulator)
  ssh/RemoteFiles.kt      command-based SFTP-style file operations
vm/ServersViewModel.kt    StateFlow UiState, connections, vault, polling, cloud
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

> **Toolchain:** `termlib` is published against a recent toolchain, so this
> module tracks it — Kotlin 2.3.21, Compose BOM 2026.05.01, AGP 8.13, and
> `compileSdk`/`targetSdk` 36.
>
> **Terminal caveat:** SSHJ has no convenient PTY-resize call, so the shell is
> allocated at a fixed 100×40 and the emulator auto-fits the view. Full-screen
> TUI apps (htop, vim) render correctly but may not track live window-size
> changes.

## Push notifications (FCM)

Alerts from the [worker](../worker) are delivered over Firebase Cloud
Messaging. To enable them, add your Firebase config:

1. In the [Firebase console](https://console.firebase.google.com), add an
   Android app with package `com.servercase.app`.
2. Download `google-services.json` into `app/` (it is gitignored; see
   [`app/google-services.json.example`](app/google-services.json.example)).
3. On the worker, set the matching `FCM_SERVICE_ACCOUNT` secret.

The app fetches its FCM token, registers it with the worker (`POST /v1/devices`)
once signed in to Cloud, and shows alert notifications via
`ServerCaseMessagingService`. **Without `google-services.json` the project still
builds** — the google-services plugin is applied only when the file is present,
and push simply stays off.

> Host-key verification is currently promiscuous to keep first-run UX simple;
> a production build should pin/confirm host keys.

# ServerCase — Android (Jetpack Compose)

An Android client for managing Linux servers over SSH. Built with
Jetpack Compose, Material 3 and SSHJ.

## Features

- Add / edit / delete servers (password or private-key auth)
- Live status dashboard: CPU%, memory, swap, per-mount disks, network
  throughput, load average and uptime — parsed from `/proc` + `df`
- Interactive SSH shell (line-oriented terminal)
- Server list persisted locally with DataStore (kotlinx.serialization)

## Architecture (MVVM)

```
data/
  ServerConfig.kt         Server model (@Serializable)
  ServerStatus.kt         Parsed status model
  StatusParser.kt         STATUS_COMMAND + /proc parsing, CPU/net deltas
  ServerRepository.kt     DataStore-backed persistence
  ssh/SshClient.kt        SSHJ connection: exec (status) + shell (terminal)
vm/ServersViewModel.kt    StateFlow UiState, connections, 3s polling
ui/
  theme/Theme.kt          Material3 dark theme + usage colors
  components/Indicators.kt Gauge + UsageBar
  ServerListScreen.kt / ServerFormScreen.kt / DashboardScreen.kt / TerminalScreen.kt
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

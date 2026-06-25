# ServerCase — Multiplatform clients

Native clients for managing Linux servers over SSH. Each client is a
standalone, idiomatic implementation for its platform that shares the
**same product design and status-collection protocol**.

| Platform | Stack | SSH | Directory |
|----------|-------|-----|-----------|
| Desktop (Win/macOS/Linux) | Electron + React + TypeScript | [`ssh2`](https://github.com/mscdex/ssh2) | [`desktop/`](desktop) |
| Android | Jetpack Compose (Kotlin, MVVM) | [SSHJ](https://github.com/hierynomus/sshj) | [`android/`](android) |
| iOS | SwiftUI (MVVM) | [Citadel](https://github.com/orlandos-nl/Citadel) | [`ios/`](ios) |

## Shared design

All three clients implement the same flow:

1. **Server list** with password / private-key auth, persisted locally.
2. **Connect** over SSH.
3. **Status dashboard** — CPU%, memory, swap, per-mount disk usage, network
   throughput, load average and uptime.
4. **Terminal / console** over the live connection.

### Status-collection protocol

Every client runs one portable command and parses the result client-side, so
the remote host only needs coreutils and a Linux `/proc`:

```sh
echo "===stat==="; cat /proc/stat | grep "^cpu "
echo "===mem==="; cat /proc/meminfo
echo "===net==="; cat /proc/net/dev
echo "===uptime==="; cat /proc/uptime
echo "===load==="; cat /proc/loadavg
echo "===disk==="; df -k -P 2>/dev/null
echo "===host==="; uname -r; hostname
```

CPU usage and network throughput are computed as deltas between two samples, so
each client keeps a small per-server collector state between 3-second polls. The
parser lives in:

- Desktop — `desktop/electron/ssh/statusCollector.ts`
- Android — `android/app/src/main/java/com/servercase/app/data/StatusParser.kt`
- iOS — `ios/ServerCase/Models/StatusParser.swift`

See each subdirectory's `README.md` for build instructions.

## Status

These are working v1 foundations. Known follow-ups: private-key auth on iOS,
full PTY terminals on mobile, host-key pinning, and SFTP / Docker / systemd
management panels.

## License

Original work, released under the [BSD 3-Clause License](LICENSE).

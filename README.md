# ServerCase — Multiplatform clients

Native clients for managing Linux servers over SSH. Each client is a
standalone, idiomatic implementation for its platform that shares the
**same product design and status-collection protocol**.

| Platform | Stack | SSH | Directory |
|----------|-------|-----|-----------|
| Desktop (Win/macOS/Linux) | Electron + React + TypeScript | [`ssh2`](https://github.com/mscdex/ssh2) | [`desktop/`](desktop) |
| Android | Jetpack Compose (Kotlin, MVVM) | [SSHJ](https://github.com/hierynomus/sshj) | [`android/`](android) |
| iOS | SwiftUI (MVVM) | [Citadel](https://github.com/orlandos-nl/Citadel) | [`ios/`](ios) |
| MCP server | Node + TypeScript | [`ssh2`](https://github.com/mscdex/ssh2) | [`mcp/`](mcp) |
| Probe agent | Rust | local Linux `/proc` | [`probe/`](probe) |

The [`mcp/`](mcp) package is a [Model Context Protocol](https://modelcontextprotocol.io)
server that lets an AI assistant manage your servers (run command, status,
SFTP). It is a thin proxy to the desktop app's local control bridge: **login,
credentials and the Bitwarden vault stay in ServerCase** — the MCP server holds
only a URL and token and never sees secrets. Enable it under **Settings → AI**;
a read-only mode is available. See its [README](mcp/README.md).

The [`probe/`](probe) package is a Rust host probe agent. It emits stable
`servercase.probe.v1` JSON snapshots from Linux `/proc`; a future Cloudflare
Worker can receive those snapshots to provide cloud-side status visibility
without moving SSH credentials out of ServerCase.

## Shared design

All three clients implement the same flow:

1. **Server list** with password / private-key auth, persisted locally, and
   optional **groups** for organizing servers.
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

These are working v1 foundations. All three clients now ship global settings
(a Bitwarden-backed keychain for credentials, reusable command snippets, and
config auto-sync) and a file manager. The Bitwarden keychain is a **clean-room
client** — each platform speaks the Bitwarden REST API directly and
reimplements the account crypto (PBKDF2 / Argon2id → HKDF → AES‑CBC‑256 +
HMAC‑SHA256, with per-cipher keys) using native primitives (Node `crypto`,
CryptoKit/CommonCrypto, `javax.crypto`) plus a license-clean Argon2 library per
platform (`@noble/hashes`, Argon2Swift, BouncyCastle). It references the public
Bitwarden security protocol only — none of the official (GPL) client code is
used. The desktop file manager uses ssh2's SFTP; the mobile ones are
command-based — same product design, idiomatic per platform. Known follow-ups:
private-key auth on iOS, full PTY terminals on mobile, host-key pinning, and
Docker / systemd panels.

## License

Original work, released under the [BSD 3-Clause License](LICENSE).

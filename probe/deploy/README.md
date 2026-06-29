# Probe deployment

The [`servercase-probe`](..) binary installs itself on a Linux host, posting
`servercase.probe.v1` snapshots to the [`worker`](../../worker) over HTTPS. There
is no separate install script — the installer lives inside the binary
(`servercase-probe install`).

```
servercase-probe (stdout JSON) ──│ pipe │──> curl ──POST──> /v1/ingest
                                                           (per snapshot)
```

The probe stays a zero-dependency std-only Rust binary, and the host only needs
`curl` (already present nearly everywhere) — no `websocat` or other extra binary
is downloaded. The systemd service pipes the probe's stdout into a `curl` loop
that `POST`s one snapshot per line. By default, non-root installs run as a
per-user `systemd --user` service; root installs run as a hardened system
service.

## One command

Get the binary (download the matching release asset or build from this repo with
`cargo build --release`), then run its `install` subcommand.

Already have a probe token (from the app or `POST /v1/probes`):

```bash
servercase-probe install --api https://worker.example.com --token scp_xxxxx
```

Or auto-register this host with your account (mints a token for you):

```bash
servercase-probe install \
  --api https://worker.example.com \
  --session <your login token> \
  --name "$(hostname)" \
  --interval 10 --public-ip --security-updates
```

`install` copies the running binary into place, writes the config, and enables
the systemd service. Re-running it upgrades in place.

To download the release binary first:

```bash
target=x86_64-unknown-linux-gnu   # or aarch64-unknown-linux-gnu
curl -fsSL "https://github.com/qwe7002/servercase/releases/latest/download/servercase-probe-$target" -o servercase-probe
chmod +x servercase-probe
./servercase-probe install --api https://worker.example.com --token scp_xxxxx
```

## Flags

| Flag | Meaning |
|------|---------|
| `--api <url>` | Worker base URL; derives the `/v1/ingest` URL and is used for auto-register. |
| `--ingest-url <url>` | Full HTTP ingest URL, if you'd rather set it explicitly. |
| `--token <scp_…>` | Per-host probe token. |
| `--session <jwt>` | Login token used to auto-register the host (when `--token` is omitted). |
| `--name <name>` | Host name to register (default: `hostname`). |
| `--interval <secs>` | Snapshot interval (default `10`). |
| `--public-ip` | Also look up the host's public IP. |
| `--security-updates` | Also check whether cached package-manager metadata reports pending security updates (apt/dnf/yum; cached by the probe). |
| `--system` / `--user-service` | Force system-wide or per-user service mode (default auto: root = system, non-root = user). |
| `--prefix <dir>` / `--conf-dir <dir>` | Install/config directories. Defaults are `/opt/servercase-probe` + `/etc/servercase-probe` in system mode, or `~/.local/lib/servercase-probe` + `~/.config/servercase-probe` in user mode. |
| `--user <name>` | Service user for system mode (default `servercase`). |

Run `servercase-probe install --help` for the full list. Use
`servercase-probe uninstall` (with the same `--system` / `--user-service`
selection) to stop, disable and remove the service and files.

## What it installs

- User mode: binary in `~/.local/lib/servercase-probe/`, config in
  `~/.config/servercase-probe/probe.env`, unit in
  `~/.config/systemd/user/servercase-probe.service`.
- System mode: binary in `/opt/servercase-probe/`, config in
  `/etc/servercase-probe/probe.env`, unit in
  `/etc/systemd/system/servercase-probe.service`.

## Operate

```bash
systemctl --user status servercase-probe
journalctl --user -u servercase-probe -f
servercase-probe uninstall --user-service
```

For a system-wide service, run `install` as root or pass `--system`, then use
plain `systemctl` / `journalctl -u`.

## Transport

The service posts each snapshot to `POST /v1/ingest` with a per-host bearer
token. The worker also still accepts a streaming WebSocket at `/v1/ingest/ws`
(see the [worker README](../../worker/README.md)); to use that instead, point
the service's `ExecStart` at a WebSocket client such as `websocat` — see the
reference unit in [`servercase-probe.service`](servercase-probe.service).

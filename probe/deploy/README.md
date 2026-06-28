# Probe deployment

Automated install of the [`servercase-probe`](..) agent on a Linux host,
streaming `servercase.probe.v1` snapshots to the [`worker`](../../worker) over a
WebSocket.

```
servercase-probe (stdout JSON) ──│ pipe │──> websocat ──wss──> /v1/ingest/ws
                                                              (ProbeSocket DO)
```

The probe stays a zero-dependency std-only Rust binary; [`websocat`](https://github.com/vi/websocat)
(one static binary) is the TLS WebSocket client, so nothing is built on the
host. By default, non-root installs run as a per-user `systemd --user` service;
root installs run as a hardened system service.

## One command

Already have a probe token (from the app or `POST /v1/probes`):

```bash
./install.sh --api https://worker.example.com --token scp_xxxxx
```

Or auto-register this host with your account (mints a token for you):

```bash
./install.sh \
  --api https://worker.example.com \
  --session <your login token> \
  --name "$(hostname)" \
  --interval 10 --public-ip
```

Run straight from a checkout (builds the probe with `cargo` when available), or
pipe the hosted installer. Without a local build or `--probe-url`, the script
downloads the matching Linux binary from GitHub Releases.

## Flags

| Flag | Meaning |
|------|---------|
| `--api <url>` | Worker base URL; derives the `wss` ingest URL and is used for auto-register. |
| `--ws-url <url>` | Full ingest URL, if you'd rather set it explicitly. |
| `--token <scp_…>` | Per-host probe token. |
| `--session <jwt>` | Login token used to auto-register the host (when `--token` is omitted). |
| `--name <name>` | Host name to register (default: `hostname`). |
| `--interval <secs>` | Snapshot interval (default `10`). |
| `--public-ip` | Also look up the host's public IP. |
| `--probe-path <file>` / `--probe-url <url>` | Use a prebuilt probe binary instead of building. |
| `--build <dir>` | Cargo source dir to build from (default: repo `probe/`). |
| `--github-repo <owner/repo>` | Release repo for automatic probe downloads (default `qwe7002/servercase`, or `$SERVERCASE_GITHUB_REPO`). |
| `--probe-version <tag>` | Release tag to download (default `latest`, or `$SERVERCASE_PROBE_VERSION`). |
| `--websocat-url <url>` | Override the websocat download. |
| `--system` / `--user-service` | Force system-wide or per-user service mode (default auto: root = system, non-root = user). |
| `--prefix <dir>` / `--conf-dir <dir>` | Install/config directories. Defaults are `/opt/servercase-probe` + `/etc/servercase-probe` in system mode, or `~/.local/lib/servercase-probe` + `~/.config/servercase-probe` in user mode. |
| `--user <name>` | Service user for system mode (default `servercase`). |
| `--uninstall` | Stop, disable and remove the service and files. |

## What it installs

- User mode: binaries in `~/.local/lib/servercase-probe/`, config in
  `~/.config/servercase-probe/probe.env`, unit in
  `~/.config/systemd/user/servercase-probe.service`.
- System mode: binaries in `/opt/servercase-probe/`, config in
  `/etc/servercase-probe/probe.env`, unit in
  `/etc/systemd/system/servercase-probe.service`.

## Operate

```bash
systemctl --user status servercase-probe
journalctl --user -u servercase-probe -f
./install.sh --uninstall
```

For a system-wide service, run the script as root or pass `--system`, then use
plain `systemctl` / `journalctl -u`.

## HTTP fallback

If WebSocket egress is blocked, skip this and post snapshots over plain HTTPS
instead — see the `POST /v1/ingest` example in the [worker README](../../worker/README.md).

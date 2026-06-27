# Probe deployment

Automated install of the [`servercase-probe`](../probe) agent on a Linux host,
streaming `servercase.probe.v1` snapshots to the [`worker`](../worker) over a
WebSocket.

```
servercase-probe (stdout JSON) ──│ pipe │──> websocat ──wss──> /v1/ingest/ws
                                                              (ProbeSocket DO)
```

The probe stays a zero-dependency std-only Rust binary; [`websocat`](https://github.com/vi/websocat)
(one static binary) is the TLS WebSocket client, so nothing is built on the
host. Everything runs as a hardened `systemd` service that reconnects on drop.

## One command

Already have a probe token (from the app or `POST /v1/probes`):

```bash
sudo ./install.sh --api https://worker.example.com --token scp_xxxxx
```

Or auto-register this host with your account (mints a token for you):

```bash
sudo ./install.sh \
  --api https://worker.example.com \
  --session <your login token> \
  --name "$(hostname)" \
  --interval 10 --public-ip
```

Run straight from a checkout (builds the probe with `cargo` if no binary is
given), or `curl … | sudo bash -s -- --api … --token …` once `install.sh` is
hosted.

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
| `--build <dir>` | Cargo source dir to build from (default: repo `../probe`). |
| `--websocat-url <url>` | Override the websocat download. |
| `--prefix <dir>` / `--user <name>` | Install dir (default `/opt/servercase-probe`) / service user. |
| `--uninstall` | Stop, disable and remove the service and files. |

## What it installs

- Binaries in `/opt/servercase-probe/` (`servercase-probe`, `websocat`).
- `/etc/servercase-probe/probe.env` (mode `0600`) holding the token + settings.
- `/etc/systemd/system/servercase-probe.service` (see
  [`servercase-probe.service`](servercase-probe.service) for the manual form).

## Operate

```bash
systemctl status servercase-probe
journalctl -u servercase-probe -f
sudo ./install.sh --uninstall
```

## HTTP fallback

If WebSocket egress is blocked, skip this and post snapshots over plain HTTPS
instead — see the `POST /v1/ingest` example in the [worker README](../worker/README.md).

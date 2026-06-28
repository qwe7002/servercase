# ServerCase Probe

`servercase-probe` is a small Rust agent for host probing. It collects the same
kind of Linux status data used by the ServerCase clients, but produces a stable
JSON payload that can later be pushed to a Cloudflare Worker endpoint.

It uses no external crates:

- reads Linux `/proc` directly for hostname, kernel, uptime, load average,
  memory, CPU usage and network totals/rates
- reports **per-mount disk usage** (via `df`), **NIC IPv4/IPv6 addresses** (via
  `ip`), and optionally the host's **public IPv4/IPv6** (via `curl`/`wget`)
- prints `servercase.probe.v1` JSON to stdout
- keeps CPU/network delta state in memory for interval mode

Disk and NIC data come from the standard `df`/`ip` utilities because the kernel
exposes no simple `/proc` file for free space or IPv4 addresses — the same
"portable command + parse" approach the SSH clients use. If a tool is missing,
that section is simply empty.

## Run

```sh
cargo run -- --once
cargo run -- --interval 10
cargo run -- --interval 10 --public-ip
```

`--once` emits a single snapshot; `--interval <seconds>` emits one per interval.
`--public-ip` additionally looks up the host's public addresses (needs outbound
internet and `curl`/`wget`; cached for ~5 minutes, off by default).

## Release binaries

The repository includes a GitHub Actions workflow that publishes Linux binaries
for `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu` on `v*` tags.
The deployment script can download those assets automatically:

```sh
curl -fsSL https://raw.githubusercontent.com/qwe7002/servercase/main/probe/deploy/install.sh \
  | bash -s -- --api https://worker.example.com --token scp_xxx
```

## Cloudflare Worker

The cloud side lives in [`../worker`](../worker) and stays thin:

1. receives `servercase.probe.v1` JSON over HTTPS (`POST /v1/ingest`)
2. authenticates each probe with a per-host token (`Authorization: Bearer`)
3. stores the latest snapshot and optional history
4. exposes a read API for ServerCase clients

That keeps SSH credentials and local management inside ServerCase while allowing
cloud status visibility.

The probe stays std-only (no TLS stack) and does not make network calls itself.
Instead its stdout JSON is posted line-by-line to the worker's HTTP ingest
endpoint with `curl`:

```sh
TOKEN=scp_...   # created automatically over SSH by the app / deploy script
servercase-probe --interval 10 \
  | while IFS= read -r line; do \
      printf %s "$line" | curl -fsS -X POST \
        -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
        --data-binary @- https://<your-worker>/v1/ingest; \
    done
```

[`deploy`](deploy) automates all of this — fetching the binary, registering the
host and installing a hardened `systemd` service. The worker also still accepts
a streaming WebSocket at `/v1/ingest/ws` (e.g. via `websocat`) for environments
that prefer a single long-lived connection.

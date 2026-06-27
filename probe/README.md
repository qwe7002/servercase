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

## Cloudflare Worker

The cloud side lives in [`../worker`](../worker) and stays thin:

1. receives `servercase.probe.v1` JSON over HTTPS (`POST /v1/ingest`)
2. authenticates each probe with a per-host token (`Authorization: Bearer`)
3. stores the latest snapshot and optional history
4. exposes a read API for ServerCase clients

That keeps SSH credentials and local management inside ServerCase while allowing
cloud status visibility.

The probe stays std-only (no TLS stack), so it does not speak WebSocket itself.
Instead its stdout JSON is piped through [`websocat`](https://github.com/vi/websocat)
to the worker's streaming endpoint:

```sh
TOKEN=scp_...   # created in the app / via POST /v1/probes
servercase-probe --interval 10 \
  | websocat --ping-interval 25 -H "Authorization: Bearer $TOKEN" \
      wss://<your-worker>/v1/ingest/ws
```

[`../deploy`](../deploy) automates all of this — fetching the binaries,
registering the host and installing a `systemd` service. An HTTP fallback
(`POST /v1/ingest` via `curl`) is also available where WebSockets are blocked.

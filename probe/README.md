# ServerCase Probe

`servercase-probe` is a small Rust agent for host probing. It collects the same
kind of Linux status data used by the ServerCase clients, but produces a stable
JSON payload that can later be pushed to a Cloudflare Worker endpoint.

The first version is intentionally dependency-free:

- reads Linux `/proc` directly
- reports hostname, kernel, uptime, load average, memory, CPU usage and network
  totals/rates
- prints `servercase.probe.v1` JSON to stdout
- keeps CPU/network delta state in memory for interval mode

## Run

```sh
cargo run -- --once
cargo run -- --interval 10
```

`--once` emits a single snapshot. `--interval <seconds>` emits one JSON snapshot
per interval.

## Cloudflare Worker Plan

The cloud side should stay thin:

1. receive `servercase.probe.v1` JSON over HTTPS
2. authenticate each probe with a per-host token
3. store the latest snapshot and optional history
4. expose a read API for ServerCase clients

That keeps SSH credentials and local management inside ServerCase while allowing
cloud status visibility later.

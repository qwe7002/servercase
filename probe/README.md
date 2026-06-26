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

## Cloudflare Worker Plan

The cloud side should stay thin:

1. receive `servercase.probe.v1` JSON over HTTPS
2. authenticate each probe with a per-host token
3. store the latest snapshot and optional history
4. expose a read API for ServerCase clients

That keeps SSH credentials and local management inside ServerCase while allowing
cloud status visibility later.

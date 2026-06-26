use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a fetched public IP stays fresh before it is looked up again.
const PUBLIC_IP_TTL_MS: u128 = 5 * 60 * 1000;

#[derive(Clone, Debug, Default)]
pub struct CollectorState {
    cpu: Option<CpuSample>,
    net: Option<NetSample>,
    public_ip: Option<PublicIpCache>,
}

/// Options controlling what an individual snapshot collects.
#[derive(Clone, Copy, Debug, Default)]
pub struct CollectOptions {
    /// Look up the host's public IPv4/IPv6 via an external service (needs
    /// outbound internet and `curl`/`wget`). Cached for a few minutes.
    pub public_ip: bool,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub collected_at_ms: u128,
    pub hostname: String,
    pub kernel: String,
    pub uptime_sec: f64,
    pub load_avg: [f64; 3],
    pub cpu_usage: Option<f64>,
    pub memory: Memory,
    pub disks: Vec<Disk>,
    pub network: Network,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Memory {
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub swap_total_kb: u64,
    pub swap_used_kb: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Disk {
    pub mount: String,
    pub fs: String,
    pub used_kb: u64,
    pub total_kb: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Nic {
    pub name: String,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Network {
    pub rx_bytes_total: u64,
    pub tx_bytes_total: u64,
    pub rx_bytes_per_sec: Option<f64>,
    pub tx_bytes_per_sec: Option<f64>,
    pub interfaces: Vec<Nic>,
    pub public_ipv4: Option<String>,
    pub public_ipv6: Option<String>,
}

#[derive(Clone, Copy, Debug)]
struct CpuSample {
    total: u64,
    idle: u64,
}

#[derive(Clone, Copy, Debug)]
struct NetSample {
    rx: u64,
    tx: u64,
    at_ms: u128,
}

#[derive(Clone, Debug)]
struct PublicIpCache {
    ipv4: Option<String>,
    ipv6: Option<String>,
    fetched_at_ms: u128,
}

pub fn collect_snapshot(
    state: &mut CollectorState,
    options: CollectOptions,
) -> io::Result<Snapshot> {
    if !cfg!(target_os = "linux") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "servercase-probe currently collects from Linux /proc hosts only",
        ));
    }

    let now = now_ms();
    let stat = fs::read_to_string("/proc/stat")?;
    let meminfo = fs::read_to_string("/proc/meminfo")?;
    let netdev = fs::read_to_string("/proc/net/dev")?;
    let uptime = fs::read_to_string("/proc/uptime")?;
    let loadavg = fs::read_to_string("/proc/loadavg")?;

    let cpu_sample = parse_cpu_sample(&stat);
    let cpu_usage = match (state.cpu, cpu_sample) {
        (Some(prev), Some(next)) => cpu_usage(prev, next),
        _ => None,
    };
    state.cpu = cpu_sample;

    let net_totals = parse_network_totals(&netdev);
    let net_rates = state
        .net
        .and_then(|prev| network_rates(prev, net_totals.0, net_totals.1, now));
    state.net = Some(NetSample {
        rx: net_totals.0,
        tx: net_totals.1,
        at_ms: now,
    });

    let (public_ipv4, public_ipv6) = if options.public_ip {
        refresh_public_ip(state, now)
    } else {
        (None, None)
    };

    Ok(Snapshot {
        collected_at_ms: now,
        hostname: read_trimmed("/proc/sys/kernel/hostname").unwrap_or_default(),
        kernel: read_trimmed("/proc/sys/kernel/osrelease").unwrap_or_default(),
        uptime_sec: parse_uptime(&uptime),
        load_avg: parse_load_avg(&loadavg),
        cpu_usage,
        memory: parse_memory(&meminfo),
        disks: read_disks(),
        network: Network {
            rx_bytes_total: net_totals.0,
            tx_bytes_total: net_totals.1,
            rx_bytes_per_sec: net_rates.map(|r| r.0),
            tx_bytes_per_sec: net_rates.map(|r| r.1),
            interfaces: read_interfaces(),
            public_ipv4,
            public_ipv6,
        },
    })
}

impl Snapshot {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"schema\":\"servercase.probe.v1\",\"collected_at_ms\":{},\"hostname\":\"{}\",\"kernel\":\"{}\",\"uptime_sec\":{},\"load_avg\":[{},{},{}],\"cpu_usage\":{},\"memory\":{{\"mem_total_kb\":{},\"mem_used_kb\":{},\"swap_total_kb\":{},\"swap_used_kb\":{}}},\"disks\":{},\"network\":{{\"rx_bytes_total\":{},\"tx_bytes_total\":{},\"rx_bytes_per_sec\":{},\"tx_bytes_per_sec\":{},\"interfaces\":{},\"public_ipv4\":{},\"public_ipv6\":{}}}}}",
            self.collected_at_ms,
            escape_json(&self.hostname),
            escape_json(&self.kernel),
            number(self.uptime_sec),
            number(self.load_avg[0]),
            number(self.load_avg[1]),
            number(self.load_avg[2]),
            option_number(self.cpu_usage),
            self.memory.mem_total_kb,
            self.memory.mem_used_kb,
            self.memory.swap_total_kb,
            self.memory.swap_used_kb,
            disks_json(&self.disks),
            self.network.rx_bytes_total,
            self.network.tx_bytes_total,
            option_number(self.network.rx_bytes_per_sec),
            option_number(self.network.tx_bytes_per_sec),
            interfaces_json(&self.network.interfaces),
            option_string(&self.network.public_ipv4),
            option_string(&self.network.public_ipv6),
        )
    }
}

fn parse_cpu_sample(raw: &str) -> Option<CpuSample> {
    let line = raw.lines().find(|line| line.starts_with("cpu "))?;
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|part| part.parse().ok())
        .collect();
    if values.len() < 4 {
        return None;
    }
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    let total = values.iter().sum();
    Some(CpuSample { total, idle })
}

fn cpu_usage(prev: CpuSample, next: CpuSample) -> Option<f64> {
    let total = next.total.checked_sub(prev.total)?;
    let idle = next.idle.checked_sub(prev.idle)?;
    if total == 0 {
        return None;
    }
    Some((((total - idle) as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
}

fn parse_memory(raw: &str) -> Memory {
    let mut values = BTreeMap::new();
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let Some(value) = parts.next() else { continue };
        if let Ok(kb) = value.parse::<u64>() {
            values.insert(key.trim_end_matches(':').to_string(), kb);
        }
    }

    let mem_total = *values.get("MemTotal").unwrap_or(&0);
    let mem_available = values.get("MemAvailable").copied().unwrap_or_else(|| {
        values.get("MemFree").copied().unwrap_or(0)
            + values.get("Buffers").copied().unwrap_or(0)
            + values.get("Cached").copied().unwrap_or(0)
    });
    let swap_total = *values.get("SwapTotal").unwrap_or(&0);
    let swap_free = *values.get("SwapFree").unwrap_or(&0);

    Memory {
        mem_total_kb: mem_total,
        mem_used_kb: mem_total.saturating_sub(mem_available),
        swap_total_kb: swap_total,
        swap_used_kb: swap_total.saturating_sub(swap_free),
    }
}

/// Per-mount disk usage via `df -k -P` (the kernel exposes no free-space file
/// in /proc, so we use coreutils, like the SSH clients do).
fn read_disks() -> Vec<Disk> {
    match Command::new("df").args(["-k", "-P"]).output() {
        Ok(out) if out.status.success() => {
            parse_disks(&String::from_utf8_lossy(&out.stdout))
        }
        _ => Vec::new(),
    }
}

fn parse_disks(raw: &str) -> Vec<Disk> {
    let mut out = Vec::new();
    for line in raw.lines().skip(1) {
        // Filesystem 1024-blocks Used Available Capacity Mounted-on
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 6 {
            continue;
        }
        let fs = cols[0];
        if fs == "tmpfs" || fs == "devtmpfs" || fs == "overlay" || fs.starts_with("/dev/loop") {
            continue;
        }
        let Ok(total_kb) = cols[1].parse::<u64>() else {
            continue;
        };
        if total_kb == 0 {
            continue;
        }
        out.push(Disk {
            fs: fs.to_string(),
            mount: cols[cols.len() - 1].to_string(),
            used_kb: cols[2].parse().unwrap_or(0),
            total_kb,
        });
    }
    out
}

/// NIC addresses via `ip -o addr show scope global` (IPv4 addresses are not
/// available in a simple /proc file, so we use iproute2).
fn read_interfaces() -> Vec<Nic> {
    match Command::new("ip")
        .args(["-o", "addr", "show", "scope", "global"])
        .output()
    {
        Ok(out) if out.status.success() => {
            parse_interfaces(&String::from_utf8_lossy(&out.stdout))
        }
        _ => Vec::new(),
    }
}

fn parse_interfaces(raw: &str) -> Vec<Nic> {
    let mut order: Vec<String> = Vec::new();
    let mut map: BTreeMap<String, (Vec<String>, Vec<String>)> = BTreeMap::new();
    for line in raw.lines() {
        // "2: eth0    inet 10.0.0.5/24 brd ... scope global eth0 ..."
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        let iface = parts[1];
        if skip_interface(iface) {
            continue;
        }
        let address = parts[3].split('/').next().unwrap_or("").to_string();
        if address.is_empty() {
            continue;
        }
        let entry = map.entry(iface.to_string()).or_insert_with(|| {
            order.push(iface.to_string());
            (Vec::new(), Vec::new())
        });
        match parts[2] {
            "inet" => entry.0.push(address),
            "inet6" => entry.1.push(address),
            _ => {}
        }
    }
    order
        .into_iter()
        .map(|name| {
            let (ipv4, ipv6) = map.remove(&name).unwrap_or_default();
            Nic { name, ipv4, ipv6 }
        })
        .collect()
}

fn refresh_public_ip(
    state: &mut CollectorState,
    now: u128,
) -> (Option<String>, Option<String>) {
    if let Some(cache) = &state.public_ip {
        if now.saturating_sub(cache.fetched_at_ms) < PUBLIC_IP_TTL_MS {
            return (cache.ipv4.clone(), cache.ipv6.clone());
        }
    }
    let ipv4 = fetch_public_ip("-4", "https://api.ipify.org");
    let ipv6 = fetch_public_ip("-6", "https://api6.ipify.org");
    state.public_ip = Some(PublicIpCache {
        ipv4: ipv4.clone(),
        ipv6: ipv6.clone(),
        fetched_at_ms: now,
    });
    (ipv4, ipv6)
}

fn fetch_public_ip(family: &str, url: &str) -> Option<String> {
    let attempts: [(&str, Vec<&str>); 2] = [
        ("curl", vec![family, "-fsS", "--max-time", "4", url]),
        ("wget", vec![family, "-qO-", "--timeout=4", url]),
    ];
    for (cmd, args) in attempts {
        if let Ok(out) = Command::new(cmd).args(&args).output() {
            if out.status.success() {
                let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn parse_network_totals(raw: &str) -> (u64, u64) {
    let mut rx = 0;
    let mut tx = 0;

    for line in raw.lines() {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        if skip_interface(iface) {
            continue;
        }
        let cols: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|part| part.parse().ok())
            .collect();
        if cols.len() >= 16 {
            rx += cols[0];
            tx += cols[8];
        }
    }

    (rx, tx)
}

fn skip_interface(name: &str) -> bool {
    name == "lo"
        || name.starts_with("docker")
        || name.starts_with("veth")
        || name.starts_with("br-")
}

fn network_rates(prev: NetSample, rx: u64, tx: u64, now_ms: u128) -> Option<(f64, f64)> {
    let elapsed = now_ms.checked_sub(prev.at_ms)? as f64 / 1000.0;
    if elapsed <= 0.0 {
        return None;
    }
    Some((
        rx.saturating_sub(prev.rx) as f64 / elapsed,
        tx.saturating_sub(prev.tx) as f64 / elapsed,
    ))
}

fn parse_uptime(raw: &str) -> f64 {
    raw.split_whitespace()
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0.0)
}

fn parse_load_avg(raw: &str) -> [f64; 3] {
    let mut values = raw
        .split_whitespace()
        .take(3)
        .filter_map(|value| value.parse::<f64>().ok());
    [
        values.next().unwrap_or(0.0),
        values.next().unwrap_or(0.0),
        values.next().unwrap_or(0.0),
    ]
}

fn read_trimmed(path: &str) -> io::Result<String> {
    Ok(fs::read_to_string(path)?.trim().to_string())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn disks_json(disks: &[Disk]) -> String {
    let items: Vec<String> = disks
        .iter()
        .map(|d| {
            format!(
                "{{\"mount\":\"{}\",\"fs\":\"{}\",\"used_kb\":{},\"total_kb\":{}}}",
                escape_json(&d.mount),
                escape_json(&d.fs),
                d.used_kb,
                d.total_kb,
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn interfaces_json(nics: &[Nic]) -> String {
    let items: Vec<String> = nics
        .iter()
        .map(|n| {
            format!(
                "{{\"name\":\"{}\",\"ipv4\":{},\"ipv6\":{}}}",
                escape_json(&n.name),
                string_array_json(&n.ipv4),
                string_array_json(&n.ipv6),
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn string_array_json(items: &[String]) -> String {
    let parts: Vec<String> = items
        .iter()
        .map(|s| format!("\"{}\"", escape_json(s)))
        .collect();
    format!("[{}]", parts.join(","))
}

fn option_string(value: &Option<String>) -> String {
    match value {
        Some(s) => format!("\"{}\"", escape_json(s)),
        None => "null".to_string(),
    }
}

fn escape_json(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn option_number(value: Option<f64>) -> String {
    value.map(number).unwrap_or_else(|| "null".to_string())
}

fn number(value: f64) -> String {
    if value.is_finite() {
        format!("{value:.2}")
    } else {
        "0.00".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_memory_with_mem_available() {
        let memory = parse_memory(
            "MemTotal:       1000 kB\nMemAvailable:    250 kB\nSwapTotal:        500 kB\nSwapFree:         125 kB\n",
        );
        assert_eq!(
            memory,
            Memory {
                mem_total_kb: 1000,
                mem_used_kb: 750,
                swap_total_kb: 500,
                swap_used_kb: 375,
            }
        );
    }

    #[test]
    fn computes_cpu_usage_from_two_samples() {
        let prev = parse_cpu_sample("cpu  100 0 50 850 0 0 0 0 0 0\n").unwrap();
        let next = parse_cpu_sample("cpu  130 0 70 900 0 0 0 0 0 0\n").unwrap();
        assert_eq!(cpu_usage(prev, next), Some(50.0));
    }

    #[test]
    fn parses_network_totals_and_skips_virtual_interfaces() {
        let raw = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0
  eth0: 300 0 0 0 0 0 0 0 400 0 0 0 0 0 0 0
docker0: 500 0 0 0 0 0 0 0 600 0 0 0 0 0 0 0
";
        assert_eq!(parse_network_totals(raw), (300, 400));
    }

    #[test]
    fn parses_disks_and_skips_pseudo_filesystems() {
        let raw = "\
Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/sda1         10240000 4096000   6144000      40% /
tmpfs              1024000       0   1024000       0% /run
/dev/sdb1         20480000 1024000  19456000       5% /data
";
        assert_eq!(
            parse_disks(raw),
            vec![
                Disk { fs: "/dev/sda1".into(), mount: "/".into(), used_kb: 4096000, total_kb: 10240000 },
                Disk { fs: "/dev/sdb1".into(), mount: "/data".into(), used_kb: 1024000, total_kb: 20480000 },
            ]
        );
    }

    #[test]
    fn parses_interfaces_grouping_addresses() {
        let raw = "\
1: lo    inet 127.0.0.1/8 scope host lo
2: eth0    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0
2: eth0    inet6 2400:abcd::1/64 scope global
3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0
";
        assert_eq!(
            parse_interfaces(raw),
            vec![Nic {
                name: "eth0".into(),
                ipv4: vec!["10.0.0.5".into()],
                ipv6: vec!["2400:abcd::1".into()],
            }]
        );
    }

    #[test]
    fn escapes_json_strings() {
        assert_eq!(escape_json("host\"a\\b\n"), "host\\\"a\\\\b\\n");
    }
}

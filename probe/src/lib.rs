use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default)]
pub struct CollectorState {
    cpu: Option<CpuSample>,
    net: Option<NetSample>,
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
pub struct Network {
    pub rx_bytes_total: u64,
    pub tx_bytes_total: u64,
    pub rx_bytes_per_sec: Option<f64>,
    pub tx_bytes_per_sec: Option<f64>,
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

pub fn collect_snapshot(state: &mut CollectorState) -> io::Result<Snapshot> {
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

    Ok(Snapshot {
        collected_at_ms: now,
        hostname: read_trimmed("/proc/sys/kernel/hostname").unwrap_or_default(),
        kernel: read_trimmed("/proc/sys/kernel/osrelease").unwrap_or_default(),
        uptime_sec: parse_uptime(&uptime),
        load_avg: parse_load_avg(&loadavg),
        cpu_usage,
        memory: parse_memory(&meminfo),
        network: Network {
            rx_bytes_total: net_totals.0,
            tx_bytes_total: net_totals.1,
            rx_bytes_per_sec: net_rates.map(|r| r.0),
            tx_bytes_per_sec: net_rates.map(|r| r.1),
        },
    })
}

impl Snapshot {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"schema\":\"servercase.probe.v1\",\"collected_at_ms\":{},\"hostname\":\"{}\",\"kernel\":\"{}\",\"uptime_sec\":{},\"load_avg\":[{},{},{}],\"cpu_usage\":{},\"memory\":{{\"mem_total_kb\":{},\"mem_used_kb\":{},\"swap_total_kb\":{},\"swap_used_kb\":{}}},\"network\":{{\"rx_bytes_total\":{},\"tx_bytes_total\":{},\"rx_bytes_per_sec\":{},\"tx_bytes_per_sec\":{}}}}}",
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
            self.network.rx_bytes_total,
            self.network.tx_bytes_total,
            option_number(self.network.rx_bytes_per_sec),
            option_number(self.network.tx_bytes_per_sec),
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
    fn escapes_json_strings() {
        assert_eq!(escape_json("host\"a\\b\n"), "host\\\"a\\\\b\\n");
    }
}

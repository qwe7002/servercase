use std::env;
use std::process;
use std::thread;
use std::time::Duration;

use servercase_probe::{collect_snapshot, CollectOptions, CollectorState};

mod install;

struct Config {
    interval: Option<u64>,
    options: CollectOptions,
}

fn main() {
    let args: Vec<String> = env::args().collect();

    // `install` / `uninstall` set up (or tear down) the systemd service from
    // the running binary, replacing the old deploy/install.sh script.
    if let Some(code) = install::dispatch(&args) {
        process::exit(code);
    }

    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print_help();
        return;
    }

    let config = match parse_args(&args) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            print_help();
            process::exit(2);
        }
    };

    let mut state = CollectorState::default();
    loop {
        match collect_snapshot(&mut state, config.options) {
            Ok(snapshot) => println!("{}", snapshot.to_json()),
            Err(err) => {
                eprintln!("failed to collect probe snapshot: {err}");
                process::exit(1);
            }
        }

        let Some(seconds) = config.interval else {
            break;
        };
        thread::sleep(Duration::from_secs(seconds));
    }
}

fn parse_args(args: &[String]) -> Result<Config, String> {
    let mut interval = None;
    let mut options = CollectOptions::default();
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--once" => {
                interval = None;
                index += 1;
            }
            "--public-ip" => {
                options.public_ip = true;
                index += 1;
            }
            "--security-updates" => {
                options.security_updates = true;
                index += 1;
            }
            "--interval" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("--interval requires seconds".to_string());
                };
                let seconds = value
                    .parse::<u64>()
                    .map_err(|_| "--interval must be a positive integer".to_string())?;
                if seconds == 0 {
                    return Err("--interval must be greater than zero".to_string());
                }
                interval = Some(seconds);
                index += 2;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(Config { interval, options })
}

fn print_help() {
    println!(
        "servercase-probe\n\nUsage:\n  servercase-probe --once [--public-ip] [--security-updates]\n  servercase-probe --interval <seconds> [--public-ip] [--security-updates]\n  servercase-probe install [--api <url>] [--token <scp_…> | --session <jwt>] ...\n  servercase-probe uninstall [--system | --user-service]\n\nFlags:\n  --once              emit a single snapshot\n  --interval <secs>   emit one snapshot per interval\n  --public-ip         also look up the host's public IPv4/IPv6 (needs outbound\n                      internet and curl/wget; cached for a few minutes)\n  --security-updates  best-effort check for pending security updates via apt,\n                      dnf or yum; cached for several hours\n\nCommands:\n  install             install the probe as a hardened systemd service that\n                      posts snapshots to the worker (see `install --help`)\n  uninstall           stop and remove that service\n\nThe probe prints ServerCase probe v1 JSON snapshots to stdout, and the worker\nreceives the same payload over HTTPS (POST /v1/ingest)."
    );
}

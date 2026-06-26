use std::env;
use std::process;
use std::thread;
use std::time::Duration;

use servercase_probe::{collect_snapshot, CollectorState};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print_help();
        return;
    }

    let interval = match parse_interval(&args) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            print_help();
            process::exit(2);
        }
    };

    let mut state = CollectorState::default();
    loop {
        match collect_snapshot(&mut state) {
            Ok(snapshot) => println!("{}", snapshot.to_json()),
            Err(err) => {
                eprintln!("failed to collect probe snapshot: {err}");
                process::exit(1);
            }
        }

        let Some(seconds) = interval else {
            break;
        };
        thread::sleep(Duration::from_secs(seconds));
    }
}

fn parse_interval(args: &[String]) -> Result<Option<u64>, String> {
    let mut interval = None;
    let mut index = 1;

    while index < args.len() {
        match args[index].as_str() {
            "--once" => {
                interval = None;
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

    Ok(interval)
}

fn print_help() {
    println!(
        "servercase-probe\n\nUsage:\n  servercase-probe --once\n  servercase-probe --interval <seconds>\n\nThe probe prints ServerCase probe v1 JSON snapshots to stdout. A future Cloudflare Worker can receive the same payload over HTTPS."
    );
}

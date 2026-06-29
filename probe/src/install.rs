//! Self-install of the `servercase-probe` agent as a systemd service.
//!
//! This replaces the old `probe/deploy/install.sh`: the probe binary now
//! installs itself. It copies the running executable into place, wires up a
//! hardened systemd service that posts `servercase.probe.v1` snapshots to the
//! ServerCase Worker over HTTPS (probe stdout → curl → POST /v1/ingest) and
//! restarts automatically. Non-root installs use a per-user `systemd --user`
//! service; root installs use a system-wide service.
//!
//! The probe stays a zero-dependency std-only binary — registration and
//! ingest both go through `curl`, which the host already needs.

use std::env;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SERVICE_NAME: &str = "servercase-probe";

/// Dispatch `servercase-probe install` / `servercase-probe uninstall`.
///
/// Returns `Some(exit_code)` when `args` is an install/uninstall invocation
/// (the caller should exit with that code), or `None` when it is an ordinary
/// probe run that `main` should keep handling itself.
pub fn dispatch(args: &[String]) -> Option<i32> {
    let sub = args.get(1).map(String::as_str)?;
    let rest = &args[2..];
    let result = match sub {
        "install" => run_install(rest),
        "uninstall" => run_uninstall(rest),
        _ => return None,
    };
    Some(match result {
        Ok(()) => 0,
        Err(message) => {
            die(&message);
            1
        }
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    System,
    User,
}

struct Paths {
    prefix: PathBuf,
    conf_dir: PathBuf,
    unit_path: PathBuf,
}

struct Options {
    api: Option<String>,
    ingest_url: Option<String>,
    token: Option<String>,
    session: Option<String>,
    name: String,
    interval: u64,
    public_ip: bool,
    security_updates: bool,
    prefix: Option<String>,
    conf_dir: Option<String>,
    mode: Option<Mode>,
    service_user: String,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            api: None,
            ingest_url: None,
            token: None,
            session: None,
            name: hostname(),
            interval: 10,
            public_ip: false,
            security_updates: false,
            prefix: None,
            conf_dir: None,
            mode: None,
            service_user: "servercase".to_string(),
        }
    }
}

fn run_install(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print_install_help();
        return Ok(());
    }

    let opts = parse_options(args)?;
    let mode = resolve_mode(opts.mode)?;
    let paths = resolve_paths(mode, &opts);

    let ingest_url = resolve_ingest_url(&opts)?;

    // The probe posts each snapshot with curl, so it is a hard runtime dependency.
    require_command("curl").map_err(|_| "the probe service needs curl on the host".to_string())?;

    let token = resolve_token(&opts)?;

    // ── Install the binary (copy the running executable into place) ──────────
    mkdir_mode(&paths.prefix, 0o755)?;
    let target_bin = paths.prefix.join("servercase-probe");
    install_self(&target_bin)?;

    // ── Service user (system mode only) ─────────────────────────────────────
    if mode == Mode::System {
        ensure_service_user(&opts.service_user)?;
    }

    // ── Config (holds the token; keep it 0600) ──────────────────────────────
    mkdir_mode(&paths.conf_dir, 0o750)?;
    let env_file = paths.conf_dir.join("probe.env");
    write_env_file(&env_file, &target_bin, &ingest_url, &token, &opts)?;
    if mode == Mode::System {
        chown_recursive(&paths.conf_dir, &opts.service_user)?;
    }

    // ── systemd unit ────────────────────────────────────────────────────────
    log(&format!("Installing {} systemd unit", mode_label(mode)));
    if mode == Mode::User {
        if let Some(parent) = paths.unit_path.parent() {
            mkdir_mode(parent, 0o755)?;
        }
    }
    let unit = render_unit(mode, &env_file, &opts.service_user);
    write_file(&paths.unit_path, unit.as_bytes())?;

    systemctl(mode, &["daemon-reload"])?;
    systemctl(mode, &["enable", "--now", SERVICE_NAME])?;

    log(&format!("Done. Posting to {ingest_url}"));
    match mode {
        Mode::System => {
            log(&format!("  systemctl status {SERVICE_NAME}"));
            log(&format!("  journalctl -u {SERVICE_NAME} -f"));
        }
        Mode::User => {
            log(&format!("  systemctl --user status {SERVICE_NAME}"));
            log(&format!("  journalctl --user -u {SERVICE_NAME} -f"));
            warn("User services may stop after logout unless linger is enabled by an admin.");
        }
    }
    Ok(())
}

fn run_uninstall(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print_install_help();
        return Ok(());
    }

    let opts = parse_options(args)?;
    let mode = resolve_mode(opts.mode)?;
    let paths = resolve_paths(mode, &opts);

    log(&format!("Stopping and removing {SERVICE_NAME}"));
    // Best-effort: the unit may already be gone.
    let _ = systemctl(mode, &["disable", "--now", SERVICE_NAME]);
    let _ = fs::remove_file(&paths.unit_path);
    systemctl(mode, &["daemon-reload"])?;
    let _ = fs::remove_dir_all(&paths.prefix);
    let _ = fs::remove_dir_all(&paths.conf_dir);

    match mode {
        Mode::System => log(&format!(
            "Removed. (The user '{}' was left in place.)",
            opts.service_user
        )),
        Mode::User => log("Removed."),
    }
    Ok(())
}

// ── Argument parsing ─────────────────────────────────────────────────────────

fn parse_options(args: &[String]) -> Result<Options, String> {
    let mut opts = Options::default();
    let mut index = 0;

    let take = |index: &mut usize, flag: &str| -> Result<String, String> {
        let value = args
            .get(*index + 1)
            .ok_or_else(|| format!("{flag} requires a value"))?
            .clone();
        *index += 2;
        Ok(value)
    };

    while index < args.len() {
        match args[index].as_str() {
            "--api" => opts.api = Some(take(&mut index, "--api")?),
            "--ingest-url" => opts.ingest_url = Some(take(&mut index, "--ingest-url")?),
            "--token" => opts.token = Some(take(&mut index, "--token")?),
            "--session" => opts.session = Some(take(&mut index, "--session")?),
            "--name" => opts.name = take(&mut index, "--name")?,
            "--interval" => {
                let value = take(&mut index, "--interval")?;
                let seconds = value
                    .parse::<u64>()
                    .map_err(|_| "--interval must be a positive integer".to_string())?;
                if seconds == 0 {
                    return Err("--interval must be greater than zero".to_string());
                }
                opts.interval = seconds;
            }
            "--public-ip" => {
                opts.public_ip = true;
                index += 1;
            }
            "--security-updates" => {
                opts.security_updates = true;
                index += 1;
            }
            "--prefix" => opts.prefix = Some(take(&mut index, "--prefix")?),
            "--conf-dir" => opts.conf_dir = Some(take(&mut index, "--conf-dir")?),
            "--system" => {
                opts.mode = Some(Mode::System);
                index += 1;
            }
            "--user-service" => {
                opts.mode = Some(Mode::User);
                index += 1;
            }
            "--user" => opts.service_user = take(&mut index, "--user")?,
            other => return Err(format!("unknown argument: {other} (try --help)")),
        }
    }

    Ok(opts)
}

fn resolve_mode(requested: Option<Mode>) -> Result<Mode, String> {
    let root = is_root();
    match requested {
        Some(Mode::System) => {
            if !root {
                return Err("--system install must run as root".to_string());
            }
            Ok(Mode::System)
        }
        Some(Mode::User) => {
            if root {
                return Err("--user-service should not run as root".to_string());
            }
            Ok(Mode::User)
        }
        None => Ok(if root { Mode::System } else { Mode::User }),
    }
}

fn resolve_paths(mode: Mode, opts: &Options) -> Paths {
    match mode {
        Mode::System => {
            let prefix = opts
                .prefix
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/opt/servercase-probe"));
            let conf_dir = opts
                .conf_dir
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/etc/servercase-probe"));
            let unit_path =
                PathBuf::from(format!("/etc/systemd/system/{SERVICE_NAME}.service"));
            Paths {
                prefix,
                conf_dir,
                unit_path,
            }
        }
        Mode::User => {
            let home = env::var("HOME").unwrap_or_default();
            let prefix = opts.prefix.clone().map(PathBuf::from).unwrap_or_else(|| {
                PathBuf::from(&home).join(".local/lib/servercase-probe")
            });
            let conf_dir = opts.conf_dir.clone().map(PathBuf::from).unwrap_or_else(|| {
                PathBuf::from(&home).join(".config/servercase-probe")
            });
            let config_home = env::var("XDG_CONFIG_HOME")
                .ok()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("{home}/.config"));
            let unit_path = PathBuf::from(config_home)
                .join("systemd/user")
                .join(format!("{SERVICE_NAME}.service"));
            Paths {
                prefix,
                conf_dir,
                unit_path,
            }
        }
    }
}

fn resolve_ingest_url(opts: &Options) -> Result<String, String> {
    if let Some(url) = &opts.ingest_url {
        return Ok(url.clone());
    }
    let api = opts
        .api
        .as_deref()
        .ok_or_else(|| "need --ingest-url or --api".to_string())?;
    if !(api.starts_with("http://") || api.starts_with("https://")) {
        return Err("--api must start with http:// or https://".to_string());
    }
    Ok(format!("{}/v1/ingest", api.trim_end_matches('/')))
}

fn resolve_token(opts: &Options) -> Result<String, String> {
    if let Some(token) = &opts.token {
        return Ok(token.clone());
    }
    let session = opts
        .session
        .as_deref()
        .ok_or_else(|| "need --token, or --session (+--api) to auto-register".to_string())?;
    let api = opts
        .api
        .as_deref()
        .ok_or_else(|| "auto-registration needs --api".to_string())?;
    register_host(api, session, &opts.name)
}

// ── Registration (over curl, like the probe's other network calls) ───────────

fn register_host(api: &str, session: &str, name: &str) -> Result<String, String> {
    log(&format!("Registering host '{name}' with {api}"));
    let url = format!("{}/v1/probes", api.trim_end_matches('/'));
    let body = format!("{{\"name\":\"{}\"}}", escape_json(name));
    let out = Command::new("curl")
        .args([
            "-fsS",
            "-X",
            "POST",
            &url,
            "-H",
            &format!("Authorization: Bearer {session}"),
            "-H",
            "content-type: application/json",
            "-d",
            &body,
        ])
        .output()
        .map_err(|err| format!("registration request failed: {err}"))?;
    if !out.status.success() {
        return Err("registration request failed".to_string());
    }
    let response = String::from_utf8_lossy(&out.stdout);
    let token = extract_token(&response)
        .ok_or_else(|| format!("could not read token from response: {response}"))?;
    log("Host registered; token captured.");
    Ok(token)
}

/// Pull `"token":"…"` out of the JSON registration response without a JSON
/// dependency (the probe is std-only).
fn extract_token(response: &str) -> Option<String> {
    let key = "\"token\":\"";
    let start = response.find(key)? + key.len();
    let rest = &response[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

fn install_self(target: &Path) -> Result<(), String> {
    log("Installing servercase-probe");
    let source = env::current_exe()
        .map_err(|err| format!("could not locate the running probe binary: {err}"))?;
    // Re-running to upgrade in place can point source and target at the same
    // file; copying a file onto itself truncates it, so skip that case.
    let same = fs::canonicalize(&source)
        .ok()
        .zip(fs::canonicalize(target).ok())
        .map(|(a, b)| a == b)
        .unwrap_or(false);
    if !same {
        fs::copy(&source, target).map_err(|err| {
            format!(
                "could not install probe binary to {}: {err}",
                target.display()
            )
        })?;
    }
    set_mode(target, 0o755)?;
    Ok(())
}

fn write_env_file(
    path: &Path,
    bin: &Path,
    ingest_url: &str,
    token: &str,
    opts: &Options,
) -> Result<(), String> {
    let body = format!(
        "# Generated by `servercase-probe install` — contains the probe token; keep private.\n\
         PROBE_BIN={bin}\n\
         INGEST_URL={ingest_url}\n\
         TOKEN={token}\n\
         INTERVAL={interval}\n\
         PUBLIC_IP={public_ip}\n\
         SECURITY_UPDATES={security_updates}\n",
        bin = bin.display(),
        interval = opts.interval,
        public_ip = if opts.public_ip { "--public-ip" } else { "" },
        security_updates = if opts.security_updates {
            "--security-updates"
        } else {
            ""
        },
    );
    write_file(path, body.as_bytes())?;
    set_mode(path, 0o600)?;
    Ok(())
}

/// Build the systemd unit. The `$$VAR` form passes a literal `$VAR` through
/// systemd to /bin/sh, which expands it from the EnvironmentFile — so the token
/// is never rendered into systemd state by variable substitution.
fn render_unit(mode: Mode, env_file: &Path, service_user: &str) -> String {
    let mut unit = String::new();
    unit.push_str(
        "[Unit]\n\
         Description=ServerCase probe -> cloud (HTTP)\n\
         After=network-online.target\n\
         Wants=network-online.target\n\n\
         [Service]\n\
         Type=simple\n",
    );
    if mode == Mode::System {
        unit.push_str(&format!("User={service_user}\n"));
    }
    unit.push_str(&format!("EnvironmentFile={}\n", env_file.display()));
    unit.push_str(
        "ExecStart=/bin/sh -c '\"$$PROBE_BIN\" --interval \"$$INTERVAL\" $$PUBLIC_IP $$SECURITY_UPDATES | while IFS= read -r line; do printf %s \"$$line\" | curl -fsS -m 20 -X POST -H \"Authorization: Bearer $$TOKEN\" -H \"content-type: application/json\" --data-binary @- \"$$INGEST_URL\" >/dev/null 2>&1 || true; done'\n",
    );
    unit.push_str(
        "Restart=always\n\
         RestartSec=5\n\
         # Hardening — the probe only needs to read /proc and run df/ip/curl.\n\
         NoNewPrivileges=true\n\
         PrivateTmp=true\n",
    );
    match mode {
        Mode::System => unit.push_str(
            "ProtectSystem=strict\n\
             ProtectHome=true\n\n\
             [Install]\n\
             WantedBy=multi-user.target\n",
        ),
        Mode::User => unit.push_str(
            "\n[Install]\n\
             WantedBy=default.target\n",
        ),
    }
    unit
}

fn mkdir_mode(path: &Path, mode: u32) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|err| format!("could not create {}: {err}", path.display()))?;
    set_mode(path, mode)
}

fn write_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path)
        .map_err(|err| format!("could not write {}: {err}", path.display()))?;
    file.write_all(contents)
        .map_err(|err| format!("could not write {}: {err}", path.display()))
}

fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|err| format!("could not chmod {}: {err}", path.display()))
}

// ── External commands (systemctl, useradd, chown) ────────────────────────────

fn systemctl(mode: Mode, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new("systemctl");
    if mode == Mode::User {
        command.arg("--user");
        let runtime = env::var("XDG_RUNTIME_DIR")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("/run/user/{}", uid()));
        command.env("XDG_RUNTIME_DIR", runtime);
    }
    command.args(args);
    let status = command
        .status()
        .map_err(|err| format!("could not run systemctl: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("systemctl {} failed", args.join(" ")))
    }
}

fn ensure_service_user(user: &str) -> Result<(), String> {
    if user_exists(user) {
        return Ok(());
    }
    log(&format!("Creating system user '{user}'"));
    let nologin = Command::new("useradd")
        .args([
            "--system",
            "--no-create-home",
            "--shell",
            "/usr/sbin/nologin",
            user,
        ])
        .status();
    if matches!(nologin, Ok(status) if status.success()) {
        return Ok(());
    }
    let status = Command::new("useradd")
        .args([
            "--system",
            "--no-create-home",
            "--shell",
            "/bin/false",
            user,
        ])
        .status()
        .map_err(|err| format!("could not run useradd: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("could not create system user '{user}'"))
    }
}

fn user_exists(user: &str) -> bool {
    Command::new("id")
        .arg(user)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn chown_recursive(path: &Path, user: &str) -> Result<(), String> {
    let status = Command::new("chown")
        .args(["-R", &format!("{user}:{user}")])
        .arg(path)
        .status()
        .map_err(|err| format!("could not run chown: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("could not chown {}", path.display()))
    }
}

fn require_command(name: &str) -> Result<(), ()> {
    let status = Command::new("sh")
        .args(["-c", &format!("command -v {name} >/dev/null 2>&1")])
        .status();
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => Err(()),
    }
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

fn hostname() -> String {
    fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|_| "localhost".to_string())
}

fn is_root() -> bool {
    uid() == 0
}

/// The effective user id, via `id -u` (keeps the probe std-only with no FFI,
/// matching how it already shells out to `df`/`ip`/`curl`).
fn uid() -> u32 {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
        .unwrap_or(0)
}

fn mode_label(mode: Mode) -> &'static str {
    match mode {
        Mode::System => "system",
        Mode::User => "user",
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

fn log(message: &str) {
    eprintln!("\x1b[1;34m==>\x1b[0m {message}");
}

fn warn(message: &str) {
    eprintln!("\x1b[1;33mwarn:\x1b[0m {message}");
}

fn die(message: &str) {
    eprintln!("\x1b[1;31merror:\x1b[0m {message}");
}

fn print_install_help() {
    let text = "\
servercase-probe install — install the probe as a systemd service

Usage (already have a probe token):
  servercase-probe install --api https://worker.example.com --token scp_xxx

Usage (auto-register this host with your account):
  servercase-probe install --api https://worker.example.com \\
      --session <your login token> --name \"$(hostname)\"

Uninstall:
  servercase-probe uninstall [--system | --user-service]

Re-running `install` upgrades the binary and service in place. Non-root installs
use a per-user `systemd --user` service; root installs use a system-wide one.

Flags:
  --api <url>           Worker base URL; derives /v1/ingest and is used to register.
  --ingest-url <url>    Full HTTP ingest URL, instead of deriving it from --api.
  --token <scp_…>       Per-host probe token.
  --session <jwt>       Login token used to auto-register the host (when --token is omitted).
  --name <name>         Host name to register (default: hostname).
  --interval <secs>     Snapshot interval (default 10).
  --public-ip           Also look up the host's public IPv4/IPv6.
  --security-updates    Also check for pending package-manager security updates.
  --prefix <dir>        Install directory (default /opt/servercase-probe or ~/.local/lib/...).
  --conf-dir <dir>      Config directory (default /etc/servercase-probe or ~/.config/...).
  --system              Force a system-wide service (root only).
  --user-service        Force a per-user service (non-root).
  --user <name>         Service user for system mode (default servercase).";
    eprintln!("{text}");
}

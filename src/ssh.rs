//! Drive the system OpenSSH client. Never reimplements the wire protocol.

use anyhow::{anyhow, Context, Result};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Kill a hung remote login shell instead of freezing the TUI forever.
pub const EXEC_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
}

impl SshHost {
    pub fn label(&self) -> String {
        let mut extra = Vec::new();
        if let Some(user) = &self.user {
            extra.push(user.clone());
        }
        if let Some(hn) = &self.hostname {
            extra.push(hn.clone());
        }
        if let Some(port) = self.port {
            extra.push(port.to_string());
        }
        if extra.is_empty() {
            self.alias.clone()
        } else {
            format!("{}  ({})", self.alias, extra.join(" "))
        }
    }
}

pub fn ssh_config_path() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("cannot resolve home directory"))?;
    Ok(home.join(".ssh").join("config"))
}

pub fn list_hosts() -> Result<Vec<SshHost>> {
    let path = ssh_config_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    parse_ssh_config(
        &fs::read_to_string(&path).with_context(|| path.display().to_string())?,
        &path,
    )
}

pub fn parse_ssh_config(text: &str, origin: &Path) -> Result<Vec<SshHost>> {
    parse_ssh_config_inner(text, origin, 0)
}

fn parse_ssh_config_inner(text: &str, origin: &Path, depth: u8) -> Result<Vec<SshHost>> {
    if depth > 8 {
        return Ok(Vec::new());
    }
    let mut hosts = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut hostname = None;
    let mut user = None;
    let mut port = None;

    let flush = |current: &mut Vec<String>,
                 hostname: &mut Option<String>,
                 user: &mut Option<String>,
                 port: &mut Option<u16>,
                 hosts: &mut Vec<SshHost>| {
        for alias in current.drain(..) {
            if is_pattern(&alias) {
                continue;
            }
            hosts.push(SshHost {
                alias,
                hostname: hostname.clone(),
                user: user.clone(),
                port: *port,
            });
        }
        *hostname = None;
        *user = None;
        *port = None;
    };

    for raw in text.lines() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let key = match parts.next() {
            Some(k) => k,
            None => continue,
        };
        let value = parts.collect::<Vec<_>>().join(" ");
        if key.eq_ignore_ascii_case("Match") {
            flush(
                &mut current,
                &mut hostname,
                &mut user,
                &mut port,
                &mut hosts,
            );
            break;
        }
        if key.eq_ignore_ascii_case("Include") {
            flush(
                &mut current,
                &mut hostname,
                &mut user,
                &mut port,
                &mut hosts,
            );
            for extra in expand_include(&value, origin)? {
                hosts.extend(parse_ssh_config_inner(
                    &fs::read_to_string(&extra).unwrap_or_default(),
                    &extra,
                    depth + 1,
                )?);
            }
            continue;
        }
        if key.eq_ignore_ascii_case("Host") {
            flush(
                &mut current,
                &mut hostname,
                &mut user,
                &mut port,
                &mut hosts,
            );
            current = value.split_whitespace().map(|s| s.to_string()).collect();
            continue;
        }
        if current.is_empty() {
            continue;
        }
        if key.eq_ignore_ascii_case("HostName") {
            hostname = Some(value);
        } else if key.eq_ignore_ascii_case("User") {
            user = Some(value);
        } else if key.eq_ignore_ascii_case("Port") {
            port = value.parse().ok();
        }
    }
    flush(
        &mut current,
        &mut hostname,
        &mut user,
        &mut port,
        &mut hosts,
    );
    let mut seen = std::collections::HashSet::new();
    hosts.retain(|h| seen.insert(h.alias.clone()));
    Ok(hosts)
}

fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(i) => &line[..i],
        None => line,
    }
}

pub fn is_pattern(alias: &str) -> bool {
    alias.contains('*') || alias.contains('?') || alias.contains('!')
}

fn expand_include(value: &str, origin: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for token in value.split_whitespace() {
        let expanded = expand_tilde(token)?;
        let path = if Path::new(&expanded).is_absolute() {
            PathBuf::from(&expanded)
        } else {
            origin.parent().unwrap_or(Path::new(".")).join(&expanded)
        };
        if let Some(parent) = path.parent() {
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                if name.contains('*') || name.contains('?') {
                    if let Ok(entries) = fs::read_dir(parent) {
                        for entry in entries.flatten() {
                            out.push(entry.path());
                        }
                    }
                    continue;
                }
            }
        }
        if path.exists() {
            out.push(path);
        }
    }
    Ok(out)
}

fn expand_tilde(token: &str) -> Result<String> {
    if let Some(rest) = token.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or_else(|| anyhow!("cannot resolve home directory"))?;
        return Ok(home.join(rest).to_string_lossy().into_owned());
    }
    if token == "~" {
        let home = dirs::home_dir().ok_or_else(|| anyhow!("cannot resolve home directory"))?;
        return Ok(home.to_string_lossy().into_owned());
    }
    Ok(token.to_string())
}

pub const APP_HOME_DIR: &str = ".faragent";
pub const LEGACY_APP_HOME_DIR: &str = ".farssh";

/// Local config / ControlMaster dir. Renames `~/.farssh` once if the new dir is absent.
pub fn faragent_home() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("cannot resolve home directory"))?;
    migrate_app_home(&home)
}

pub fn migrate_app_home(home: &Path) -> Result<PathBuf> {
    let dest = home.join(APP_HOME_DIR);
    let src = home.join(LEGACY_APP_HOME_DIR);
    if !dest.exists() && src.exists() {
        fs::rename(&src, &dest)
            .with_context(|| format!("rename {} -> {}", src.display(), dest.display()))?;
    }
    Ok(dest)
}

pub fn control_dir() -> Result<PathBuf> {
    let dir = faragent_home()?.join("cm");
    fs::create_dir_all(&dir).ok();
    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    Ok(dir)
}

pub fn control_path() -> Result<String> {
    Ok(control_dir()?
        .join("%r@%h:%p")
        .to_string_lossy()
        .into_owned())
}

/// OpenSSH flags shared by exec and PTY attach.
pub fn base_args(control_path: &str) -> Vec<String> {
    vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "PreferredAuthentications=publickey".into(),
        "-o".into(),
        "GSSAPIAuthentication=no".into(),
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={control_path}"),
        "-o".into(),
        "ControlPersist=600".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
        "-o".into(),
        "ServerAliveInterval=5".into(),
        "-o".into(),
        "ServerAliveCountMax=2".into(),
    ]
}

#[derive(Debug, Clone)]
pub struct Client {
    pub host: String,
    control_path: String,
}

impl Client {
    pub fn new(host: impl Into<String>) -> Result<Self> {
        Ok(Self {
            host: host.into(),
            control_path: control_path()?,
        })
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new("ssh");
        for arg in base_args(&self.control_path) {
            cmd.arg(arg);
        }
        cmd.arg(&self.host);
        cmd
    }

    pub fn exec(&self, remote: &[&str]) -> Result<Output> {
        let joined = remote
            .iter()
            .map(|a| shell_single_quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        let mut cmd = self.command();
        cmd.arg("--");
        cmd.arg(&joined);
        cmd.stdin(Stdio::null());
        run_cmd_timeout(cmd, EXEC_TIMEOUT)
    }

    /// Login-shell so nvm / Homebrew / ~/.local/bin are visible.
    pub fn exec_login(&self, script: &str) -> Result<Output> {
        let mut cmd = self.command();
        cmd.arg("--");
        cmd.arg(bash_login_command(script));
        cmd.stdin(Stdio::null());
        run_cmd_timeout(cmd, EXEC_TIMEOUT)
    }

    pub fn exec_login_stdin(&self, bash_lc: &str, stdin: &[u8]) -> Result<Output> {
        let mut cmd = self.command();
        cmd.arg("--");
        cmd.arg(bash_login_command(bash_lc));
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let mut child = cmd.spawn().context("failed to spawn ssh")?;
        if let Some(mut s) = child.stdin.take() {
            s.write_all(stdin).ok();
        }
        wait_child_timeout(child, EXEC_TIMEOUT)
    }

    pub fn output_text(output: &Output) -> String {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.success() {
            stdout.into_owned()
        } else {
            format!("{stdout}{stderr}")
        }
    }

    pub fn require_ok(output: &Output) -> Result<()> {
        if output.status.success() {
            return Ok(());
        }
        let msg = Self::output_text(output);
        let trimmed = msg.trim();
        if trimmed.contains("Permission denied")
            || trimmed.contains("No matching host key")
            || trimmed.contains("Host key verification failed")
        {
            return Err(anyhow!(
                "SSH failed (BatchMode, key/agent only): {}",
                trimmed
            ));
        }
        Err(anyhow!(
            "SSH command failed (status {:?}): {}",
            output.status.code(),
            trimmed
        ))
    }
}

pub fn shell_single_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:@%=+,".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Single remote argv. OpenSSH joins extra args with spaces and does **not**
/// re-quote, so `ssh host -- bash -lc 'printf hi'` must be one string
/// or the remote shell runs `bash -lc printf` and drops `hi`.
pub fn bash_login_command(script: &str) -> String {
    format!("bash -lc {}", shell_single_quote(script))
}

fn run_cmd_timeout(mut cmd: Command, timeout: Duration) -> Result<Output> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let child = cmd.spawn().context("failed to spawn ssh")?;
    wait_child_timeout(child, timeout)
}

fn wait_child_timeout(mut child: std::process::Child, timeout: Duration) -> Result<Output> {
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_h = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = stdout_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_h = thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = stderr_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait().context("ssh wait")? {
            Some(st) => break st,
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow!(
                    "SSH command timed out after {}s. Host unreachable, or the remote login shell hung.",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(40)),
        }
    };
    let stdout = stdout_h.join().unwrap_or_default();
    let stderr = stderr_h.join().unwrap_or_default();
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn skips_wildcard_hosts() {
        let text = r#"
Host *
    Compression yes
Host devbox
    HostName 10.0.0.2
    User sunny
Host *.github.com
    User git
Host work laptop
    HostName office.example
"#;
        let hosts = parse_ssh_config(text, Path::new("/tmp/config")).unwrap();
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, vec!["devbox", "work", "laptop"]);
        assert_eq!(hosts[0].hostname.as_deref(), Some("10.0.0.2"));
        assert_eq!(hosts[0].user.as_deref(), Some("sunny"));
    }

    #[test]
    fn match_blocks_stop_host_parsing() {
        let text = r#"
Host ok
    HostName a.example
Match host foo
Host ignored
    HostName b.example
"#;
        let hosts = parse_ssh_config(text, Path::new("/tmp/config")).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "ok");
    }

    #[test]
    fn base_args_include_batchmode_and_controlmaster() {
        let args = base_args("/tmp/cm/%r@%h:%p");
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-o" && w[1] == "BatchMode=yes"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-o" && w[1] == "ControlMaster=auto"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-o" && w[1].starts_with("ControlPath=")));
    }

    #[test]
    fn shell_quote_safe_and_unsafe() {
        assert_eq!(shell_single_quote("abc"), "abc");
        assert_eq!(shell_single_quote("a b"), "'a b'");
        assert_eq!(shell_single_quote("a'b"), "'a'\"'\"'b'");
    }

    #[test]
    fn bash_login_command_is_one_ssh_argv() {
        let cmd = bash_login_command(r#"printf 'FARAGENT_PROBE_V1\n'"#);
        assert!(cmd.starts_with("bash -lc "));
        assert!(
            cmd.contains("'printf"),
            "script must be single-quoted so OpenSSH cannot split it: {cmd}"
        );
        assert!(cmd.contains("FARAGENT_PROBE_V1"));
        assert_ne!(cmd, r#"bash -lc printf 'FARAGENT_PROBE_V1\n'"#);
    }

    #[test]
    fn migrate_renames_legacy_home() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(".farssh");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("config.json"), "{}\n").unwrap();
        let dest = migrate_app_home(tmp.path()).unwrap();
        assert_eq!(dest, tmp.path().join(".faragent"));
        assert!(dest.join("config.json").is_file());
        assert!(!old.exists());
    }

    #[test]
    fn migrate_leaves_existing_new_home() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(".farssh");
        let new = tmp.path().join(".faragent");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        std::fs::write(old.join("config.json"), "old").unwrap();
        std::fs::write(new.join("config.json"), "new").unwrap();
        migrate_app_home(tmp.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(new.join("config.json")).unwrap(),
            "new"
        );
        assert!(old.exists());
    }

    #[test]
    fn base_args_include_alive_and_pubkey() {
        let args = base_args("/tmp/cm/%r@%h:%p");
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-o" && w[1] == "ServerAliveInterval=5"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-o" && w[1] == "GSSAPIAuthentication=no"));
    }
}

//! Drive the system OpenSSH client. Never reimplements the wire protocol.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

/// Kill a hung remote login shell instead of freezing the TUI forever.
pub const EXEC_TIMEOUT: Duration = Duration::from_secs(25);

/// A no-op remote command that exits 0 in bash, cmd.exe and PowerShell alike.
pub const REMOTE_PING: &str = "echo FARAGENT_OK";

/// How long the multiplexed ControlMaster socket is kept alive.
pub const KEY_PERSIST: &str = "600";
/// Password logins prompt **once**; keep the multiplexed master around longer
/// so the user is not asked again for every probe. The password itself is only
/// ever typed into OpenSSH and is never stored by FarAgent.
pub const PASSWORD_PERSIST: &str = "4h";

/// How FarAgent is allowed to authenticate to a host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// Key first (BatchMode). If the server only offers password, say so and
    /// offer an interactive login instead of guessing.
    #[default]
    Auto,
    /// Key / ssh-agent only. Never prompts, fails fast.
    Key,
    /// Password / keyboard-interactive. Prompts once through OpenSSH, then
    /// multiplexes every later command over the ControlMaster socket.
    Password,
}

impl AuthMode {
    pub const ALL: [AuthMode; 3] = [Self::Auto, Self::Key, Self::Password];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "key" | "keys" | "publickey" | "pubkey" => Some(Self::Key),
            "password" | "passwd" | "pw" | "interactive" | "keyboard-interactive" => {
                Some(Self::Password)
            }
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Key => "key",
            Self::Password => "password",
        }
    }
}

/// Which bundle of `-o` options we hand to OpenSSH.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    /// BatchMode + publickey only. Probe/list/exec for key hosts.
    Key,
    /// BatchMode, but the server may also accept password or
    /// keyboard-interactive. Never prompts; rides an existing ControlMaster.
    BatchPassword,
    /// Key first, but OpenSSH may still ask (host key confirmation).
    InteractiveKey,
    /// Password / keyboard-interactive first, and OpenSSH may ask.
    InteractivePassword,
    /// `ssh -O check`: is the ControlMaster socket alive?
    MuxCheck,
    /// `PreferredAuthentications=none`: ask the server which methods it offers.
    Enumerate,
}

/// Shared flags plus the auth bundle. `ControlMaster=auto` means the first
/// connection to a host becomes the master and everything else rides it.
///
/// `mux` is false on Win32 OpenSSH, which cannot create the ControlMaster
/// socket — passing `ControlPath` there breaks every connection outright, so
/// the three mux options are omitted entirely instead of degraded.
pub fn args_for(mux: bool, control_path: &str, persist: &str, flavor: Flavor) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if mux {
        args.extend([
            "-o".into(),
            "ControlMaster=auto".into(),
            "-o".into(),
            format!("ControlPath={control_path}"),
            "-o".into(),
            format!("ControlPersist={persist}"),
        ]);
    }
    args.extend([
        "-o".into(),
        "GSSAPIAuthentication=no".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
        "-o".into(),
        "ServerAliveInterval=5".into(),
        "-o".into(),
        "ServerAliveCountMax=2".into(),
    ]);
    let mut opt = |k: &str| {
        args.push("-o".into());
        args.push(k.into());
    };
    match flavor {
        Flavor::Key => {
            opt("BatchMode=yes");
            opt("PreferredAuthentications=publickey");
        }
        Flavor::BatchPassword => {
            opt("BatchMode=yes");
            opt("PreferredAuthentications=publickey,password,keyboard-interactive");
        }
        Flavor::InteractiveKey => {
            opt("BatchMode=no");
            opt("PreferredAuthentications=publickey,password,keyboard-interactive");
            opt("NumberOfPasswordPrompts=3");
        }
        Flavor::InteractivePassword => {
            opt("BatchMode=no");
            opt("PreferredAuthentications=password,keyboard-interactive");
            opt("NumberOfPasswordPrompts=3");
        }
        Flavor::MuxCheck => {
            opt("BatchMode=yes");
        }
        Flavor::Enumerate => {
            opt("BatchMode=yes");
            opt("PreferredAuthentications=none");
        }
    }
    args
}

/// `OpenSSH_for_Windows_8.6p1, LibreSSL 3.8.2` → true. The Win32 build has no
/// ControlMaster (AF_UNIX control socket) support at any released version.
pub fn openssh_is_windows(version: &str) -> bool {
    version.to_ascii_lowercase().contains("for_windows")
}

/// Can this machine's `ssh` multiplex connections? Probed once per process
/// (`ssh -V` prints to stderr). If ssh cannot even spawn we report capable so
/// the real failure surfaces later as a classified `SshMissing`.
pub fn mux_capable() -> bool {
    static CAPABLE: OnceLock<bool> = OnceLock::new();
    *CAPABLE.get_or_init(|| match Command::new("ssh").arg("-V").output() {
        Ok(o) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stderr),
                String::from_utf8_lossy(&o.stdout)
            );
            !openssh_is_windows(&text)
        }
        Err(_) => true,
    })
}

/// A failed SSH run, kept structured so the UI can show the verbatim error
/// **and** the matching fix instead of a paraphrased one-liner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshError {
    pub host: String,
    pub mode: AuthMode,
    /// Local command line we actually executed (copy-pasteable).
    pub command: String,
    /// Verbatim OpenSSH stdout + stderr. Never truncated.
    pub raw: String,
    pub status: Option<i32>,
    pub timed_out: bool,
    /// The server wants an interactive login (password / host key confirm).
    pub needs_auth: bool,
    /// Auth methods the server reported, e.g. `publickey,password`.
    pub methods: String,
}

impl fmt::Display for SshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let raw = self.raw.trim();
        if raw.is_empty() {
            write!(f, "ssh to {} failed (status {:?})", self.host, self.status)
        } else {
            write!(f, "{raw}")
        }
    }
}

impl std::error::Error for SshError {}

/// `Permission denied (publickey,password).` → `publickey,password`
pub fn parse_auth_methods(text: &str) -> Option<String> {
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(i) = lower.find("permission denied (") {
            let rest = &line[i + "permission denied (".len()..];
            if let Some(end) = rest.find(')') {
                let methods = rest[..end].trim();
                if !methods.is_empty() {
                    return Some(methods.to_string());
                }
            }
        }
        if let Some(i) = lower.find("authentications that can continue:") {
            let rest = &line[i + "authentications that can continue:".len()..];
            let methods = rest.trim();
            if !methods.is_empty() {
                return Some(methods.to_string());
            }
        }
    }
    None
}

/// Did the server refuse us over credentials (as opposed to network, host key,
/// or algorithm problems)?
pub fn is_auth_failure(raw: &str) -> bool {
    let r = raw.to_ascii_lowercase();
    r.contains("permission denied")
        || r.contains("authentication failed")
        || r.contains("too many authentication failures")
        || r.contains("no supported authentication methods")
}

pub fn offers_password(methods: &str) -> bool {
    let m = methods.to_ascii_lowercase();
    m.contains("password") || m.contains("keyboard-interactive")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity: Option<String>,
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

    /// Hostname as OpenSSH would use it: `HostName`, else the alias itself.
    pub fn target(&self) -> &str {
        self.hostname.as_deref().unwrap_or(&self.alias)
    }

    pub fn port_or_22(&self) -> u16 {
        self.port.unwrap_or(22)
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
    let mut identity = None;

    let flush = |current: &mut Vec<String>,
                 hostname: &mut Option<String>,
                 user: &mut Option<String>,
                 port: &mut Option<u16>,
                 identity: &mut Option<String>,
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
                identity: identity.clone(),
            });
        }
        *hostname = None;
        *user = None;
        *port = None;
        *identity = None;
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
                &mut identity,
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
                &mut identity,
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
                &mut identity,
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
        } else if key.eq_ignore_ascii_case("IdentityFile") {
            identity = Some(expand_tilde(&value).unwrap_or(value));
        }
    }
    flush(
        &mut current,
        &mut hostname,
        &mut user,
        &mut port,
        &mut identity,
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
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

pub fn control_path() -> Result<String> {
    Ok(control_dir()?
        .join("%r@%h:%p")
        .to_string_lossy()
        .into_owned())
}

/// OpenSSH flags shared by exec and PTY attach.
#[derive(Debug, Clone)]
pub struct Client {
    pub host: String,
    pub mode: AuthMode,
    /// None when this machine's ssh cannot multiplex (Win32 OpenSSH).
    control_path: Option<String>,
    persist: String,
    mux: bool,
}

impl Client {
    /// Auth mode comes from `~/.faragent/config.json` (`auto` unless set).
    pub fn new(host: impl Into<String>) -> Result<Self> {
        let host = host.into();
        let mode = crate::config::auth_for(&host);
        Self::with_mode(host, mode)
    }

    pub fn with_mode(host: impl Into<String>, mode: AuthMode) -> Result<Self> {
        let persist = match mode {
            AuthMode::Password => PASSWORD_PERSIST,
            _ => KEY_PERSIST,
        };
        let mux = mux_capable();
        let control_path = if mux { Some(control_path()?) } else { None };
        Ok(Self {
            host: host.into(),
            mode,
            control_path,
            persist: persist.to_string(),
            mux,
        })
    }

    /// Does this machine's ssh multiplex connections (ControlMaster)?
    pub fn muxed(&self) -> bool {
        self.mux
    }

    /// Bundle used for non-interactive commands (probe, sessions, exec).
    ///
    /// With a password held in memory (askpass), ssh must be allowed to try
    /// password auth — `BatchMode=yes` would suppress it entirely. Without
    /// one, the batch flavors stay: a password host fails fast and steers
    /// the user to the password prompt.
    pub fn flavor(&self) -> Flavor {
        let held = crate::askpass::active_for(&self.host);
        match self.mode {
            AuthMode::Key => Flavor::Key,
            AuthMode::Auto if held => Flavor::InteractiveKey,
            AuthMode::Password if held => Flavor::InteractivePassword,
            AuthMode::Auto | AuthMode::Password => Flavor::BatchPassword,
        }
    }

    pub fn args(&self, flavor: Flavor) -> Vec<String> {
        args_for(
            self.mux,
            self.control_path.as_deref().unwrap_or(""),
            &self.persist,
            flavor,
        )
    }

    fn command_flavor(&self, flavor: Flavor) -> Command {
        let mut cmd = Command::new("ssh");
        for arg in self.args(flavor) {
            cmd.arg(arg);
        }
        cmd.arg(&self.host);
        crate::askpass::apply(&mut cmd, &self.host);
        cmd
    }

    /// Copy-pasteable version of what we ran, for error reports.
    pub fn command_line(&self, flavor: Flavor, remote: &str) -> String {
        let mut s = String::from("ssh");
        for arg in self.args(flavor) {
            s.push(' ');
            s.push_str(&shell_single_quote(&arg));
        }
        s.push(' ');
        s.push_str(&shell_single_quote(&self.host));
        s.push_str(" -- ");
        s.push_str(remote);
        s
    }

    /// Run a literal command line with **no** local quoting: the remote's
    /// default shell receives it verbatim. Only for lines already safe in
    /// every shell (e.g. the OS marker); `exec_login` POSIX-quotes and would
    /// feed cmd.exe literal single quotes.
    pub fn exec_raw_line(&self, line: &str) -> Result<Output> {
        self.run_remote_line(line)
    }

    fn run_remote_line(&self, line: &str) -> Result<Output> {
        let flavor = self.flavor();
        let mut cmd = self.command_flavor(flavor);
        cmd.arg("--");
        cmd.arg(line);
        cmd.stdin(Stdio::null());
        let full = self.command_line(flavor, line);
        self.run_cmd(cmd, &full, EXEC_TIMEOUT)
    }

    /// Login-shell so nvm / Homebrew / ~/.local/bin are visible.
    pub fn exec_login(&self, script: &str) -> Result<Output> {
        self.run_remote(&bash_login_command(script))
    }

    pub fn exec_login_stdin(&self, bash_lc: &str, stdin: &[u8]) -> Result<Output> {
        self.exec_stdio(&bash_login_command(bash_lc), stdin)
    }

    /// Run a caller-built remote command line, piping `stdin` into it.
    pub fn exec_stdio(&self, remote: &str, stdin: &[u8]) -> Result<Output> {
        let flavor = self.flavor();
        let mut cmd = self.command_flavor(flavor);
        cmd.arg("--");
        cmd.arg(remote);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let line = self.command_line(flavor, remote);
        let mut child = cmd.spawn().map_err(|e| self.spawn_error(&line, e))?;
        if let Some(mut s) = child.stdin.take() {
            s.write_all(stdin).ok();
        }
        self.wait_child(child, &line, EXEC_TIMEOUT)
    }

    fn run_remote(&self, remote: &str) -> Result<Output> {
        let flavor = self.flavor();
        let mut cmd = self.command_flavor(flavor);
        cmd.arg("--");
        cmd.arg(remote);
        cmd.stdin(Stdio::null());
        let line = self.command_line(flavor, remote);
        self.run_cmd(cmd, &line, EXEC_TIMEOUT)
    }

    fn run_cmd(&self, mut cmd: Command, line: &str, timeout: Duration) -> Result<Output> {
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let child = cmd.spawn().map_err(|e| self.spawn_error(line, e))?;
        self.wait_child(child, line, timeout)
    }

    fn wait_child(&self, child: Child, line: &str, timeout: Duration) -> Result<Output> {
        match wait_child_timeout(child, timeout) {
            Ok(output) => Ok(output),
            Err(WaitError::Timeout) => Err(anyhow::Error::new(SshError {
                host: self.host.clone(),
                mode: self.mode,
                command: line.to_string(),
                raw: format!(
                    "SSH timed out after {}s: no answer from the host, or the remote login shell hung.",
                    timeout.as_secs()
                ),
                status: None,
                timed_out: true,
                needs_auth: false,
                methods: String::new(),
            })),
            Err(WaitError::Io(e)) => Err(e),
        }
    }

    fn spawn_error(&self, line: &str, e: std::io::Error) -> anyhow::Error {
        anyhow::Error::new(SshError {
            host: self.host.clone(),
            mode: self.mode,
            command: line.to_string(),
            raw: format!("could not run the local OpenSSH client: {e}"),
            status: None,
            timed_out: false,
            needs_auth: false,
            methods: String::new(),
        })
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

    /// Structured failure for a non-interactive run.
    pub fn error_for(&self, output: &Output) -> SshError {
        let raw = Self::output_text(output);
        let auth_failure = is_auth_failure(&raw);
        // `PreferredAuthentications=none` makes the server list what it accepts.
        // Only worth an extra round trip when credentials are the problem.
        let methods = if auth_failure && self.mode != AuthMode::Password {
            self.server_auth_methods().unwrap_or_default()
        } else {
            String::new()
        };
        let needs_auth = auth_failure
            && (self.mode == AuthMode::Password
                || offers_password(&methods)
                || raw.to_ascii_lowercase().contains("password"));
        SshError {
            host: self.host.clone(),
            mode: self.mode,
            command: self.command_line(self.flavor(), "-"),
            raw,
            status: output.status.code(),
            timed_out: false,
            needs_auth,
            methods,
        }
    }

    pub fn require_ok(&self, output: &Output) -> Result<()> {
        if output.status.success() {
            return Ok(());
        }
        Err(anyhow::Error::new(self.error_for(output)))
    }

    /// Ask the server which auth methods it accepts. Cheap and harmless: the
    /// `none` method cannot succeed, it only makes sshd reply.
    pub fn server_auth_methods(&self) -> Option<String> {
        let mut cmd = self.command_flavor(Flavor::Enumerate);
        cmd.arg("--");
        cmd.arg("true");
        cmd.stdin(Stdio::null());
        let line = self.command_line(Flavor::Enumerate, "true");
        let out = self.run_cmd(cmd, &line, EXEC_TIMEOUT).ok()?;
        parse_auth_methods(&Self::output_text(&out))
    }

    /// Is a multiplexed ControlMaster already authenticated for this host?
    pub fn master_alive(&self) -> bool {
        if !self.mux {
            return false;
        }
        let mut cmd = Command::new("ssh");
        for arg in self.args(Flavor::MuxCheck) {
            cmd.arg(arg);
        }
        cmd.arg("-O");
        cmd.arg("check");
        cmd.arg(&self.host);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        matches!(cmd.output(), Ok(o) if o.status.success())
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

/// Why a child did not hand us output.
enum WaitError {
    /// Still running after the deadline; we killed it.
    Timeout,
    Io(anyhow::Error),
}

fn wait_child_timeout(
    mut child: Child,
    timeout: Duration,
) -> std::result::Result<Output, WaitError> {
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
        match child
            .try_wait()
            .map_err(|e| WaitError::Io(anyhow!("ssh wait: {e}")))?
        {
            Some(st) => break st,
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(WaitError::Timeout);
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
    IdentityFile ~/.ssh/id_ed25519
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
        assert_eq!(hosts[0].port_or_22(), 22);
        assert_eq!(hosts[0].target(), "10.0.0.2");
        assert!(hosts[0]
            .identity
            .as_deref()
            .unwrap()
            .ends_with("/.ssh/id_ed25519"));
        // `Host work laptop` shares one HostName, and the wildcard block's
        // `User git` must not leak into it.
        assert_eq!(hosts[1].target(), "office.example");
        assert_eq!(hosts[2].target(), "office.example");
        assert_eq!(hosts[1].user, None);
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
    fn key_args_include_batchmode_and_controlmaster() {
        let args = args_for(true, "/tmp/cm/%r@%h:%p", KEY_PERSIST, Flavor::Key);
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
    fn key_args_include_alive_and_pubkey() {
        let args = args_for(true, "/tmp/cm/%r@%h:%p", KEY_PERSIST, Flavor::Key);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-o" && w[1] == "ServerAliveInterval=5"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-o" && w[1] == "GSSAPIAuthentication=no"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-o" && w[1] == "PreferredAuthentications=publickey"));
    }

    fn opt(args: &[String], key: &str) -> bool {
        args.windows(2).any(|w| w[0] == "-o" && w[1] == key)
    }

    #[test]
    fn windows_openssh_is_detected() {
        assert!(openssh_is_windows(
            "OpenSSH_for_Windows_8.6p1, LibreSSL 3.8.2"
        ));
        assert!(openssh_is_windows("OpenSSH_for_Windows_9.5p1"));
        assert!(!openssh_is_windows(
            "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024"
        ));
        assert!(!openssh_is_windows("OpenSSH_9.6p1, LibreSSL 3.8.2"));
    }

    #[test]
    fn no_mux_omits_every_controlmaster_flag() {
        // Win32 OpenSSH fails outright when ControlPath is passed, so the
        // whole bundle must vanish — not just ControlMaster.
        let args = args_for(false, "/tmp/cm/%r@%h:%p", KEY_PERSIST, Flavor::Key);
        assert!(!args.iter().any(|a| a.contains("Control")));
        assert!(opt(&args, "BatchMode=yes"));
        assert!(opt(&args, "ServerAliveInterval=5"));
        assert!(opt(&args, "PreferredAuthentications=publickey"));
    }

    #[test]
    fn batch_password_flavor_never_prompts_but_allows_password() {
        let args = args_for(true, "/tmp/cm", PASSWORD_PERSIST, Flavor::BatchPassword);
        assert!(opt(&args, "BatchMode=yes"));
        assert!(opt(
            &args,
            "PreferredAuthentications=publickey,password,keyboard-interactive"
        ));
        assert!(opt(&args, "ControlPersist=4h"));
    }

    #[test]
    fn interactive_flavors_allow_prompts_and_multiplex() {
        let pw = args_for(
            true,
            "/tmp/cm",
            PASSWORD_PERSIST,
            Flavor::InteractivePassword,
        );
        assert!(opt(&pw, "BatchMode=no"));
        assert!(opt(
            &pw,
            "PreferredAuthentications=password,keyboard-interactive"
        ));
        assert!(opt(&pw, "NumberOfPasswordPrompts=3"));
        assert!(opt(&pw, "ControlMaster=auto"));
        let key = args_for(true, "/tmp/cm", KEY_PERSIST, Flavor::InteractiveKey);
        assert!(opt(&key, "BatchMode=no"));
        assert!(opt(
            &key,
            "PreferredAuthentications=publickey,password,keyboard-interactive"
        ));
    }

    #[test]
    fn enumerate_flavor_asks_without_credentials() {
        let args = args_for(true, "/tmp/cm", KEY_PERSIST, Flavor::Enumerate);
        assert!(opt(&args, "PreferredAuthentications=none"));
        assert!(opt(&args, "BatchMode=yes"));
    }

    #[test]
    fn auth_mode_parsing() {
        assert_eq!(AuthMode::parse("auto"), Some(AuthMode::Auto));
        assert_eq!(AuthMode::parse("Key"), Some(AuthMode::Key));
        assert_eq!(AuthMode::parse(" password "), Some(AuthMode::Password));
        assert_eq!(AuthMode::parse("pubkey"), Some(AuthMode::Key));
        assert_eq!(AuthMode::parse("nope"), None);
        assert_eq!(AuthMode::default(), AuthMode::Auto);
        assert_eq!(AuthMode::code(AuthMode::Password), "password");
    }

    #[test]
    fn parses_server_auth_methods() {
        let text = "you@host: Permission denied (publickey,password).\n";
        assert_eq!(
            parse_auth_methods(text).as_deref(),
            Some("publickey,password")
        );
        assert_eq!(
            parse_auth_methods("Permission denied (publickey).").as_deref(),
            Some("publickey")
        );
        assert!(parse_auth_methods("Connection refused").is_none());
        assert!(offers_password("publickey,password"));
        assert!(offers_password("keyboard-interactive"));
        assert!(!offers_password("publickey"));
        assert!(is_auth_failure("Permission denied (publickey)."));
        assert!(!is_auth_failure("Connection timed out"));
    }

    #[test]
    fn ssh_error_display_keeps_raw_text() {
        let err = SshError {
            host: "devbox".into(),
            mode: AuthMode::Key,
            command: "ssh devbox -- true".into(),
            raw: "you@devbox: Permission denied (publickey).\n".into(),
            status: Some(255),
            timed_out: false,
            needs_auth: false,
            methods: "publickey".into(),
        };
        assert!(err.to_string().contains("Permission denied (publickey)"));
        let boxed: std::sync::Arc<dyn std::error::Error + Send + Sync> = std::sync::Arc::new(err);
        assert!(boxed.to_string().contains("publickey"));
    }
}

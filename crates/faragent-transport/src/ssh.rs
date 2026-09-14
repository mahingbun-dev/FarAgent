//! Drive the system OpenSSH client. Never reimplements the wire protocol.

use crate::{AttachOptions, AttachStream, CommandStream, ExecOutput, Transport, TransportError};
use anyhow::{anyhow, Context, Result};
use faragent_core::paths::faragent_home;
pub use faragent_core::shell::shell_single_quote;
use faragent_core::text::LocalizedText;
use faragent_core::vocab::AuthMode;
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
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

// Auth wording travels with the transport: it takes `AuthMode`/host as input
// and is rendered by the TUI, the CLI and (later) the app alike.

pub fn auth_tag(mode: AuthMode) -> LocalizedText<&'static str> {
    match mode {
        AuthMode::Password => LocalizedText::new("  [密码登录]", "  [password]"),
        AuthMode::Key => LocalizedText::new("  [仅密钥]", "  [key only]"),
        _ => LocalizedText::new("", ""),
    }
}

pub fn auth_mode_label(mode: AuthMode) -> LocalizedText<&'static str> {
    match mode {
        AuthMode::Auto => LocalizedText::new(
            "自动：先试密钥，只有服务端要求密码时才提示",
            "auto: try keys first, offer a password prompt only if the server asks for one",
        ),
        AuthMode::Key => LocalizedText::new(
            "仅密钥：BatchMode，绝不弹密码",
            "key only: BatchMode, never prompts",
        ),
        AuthMode::Password => LocalizedText::new(
            "密码 / 键盘交互：登录一次后复用连接",
            "password / keyboard-interactive: log in once, then reuse the connection",
        ),
    }
}

pub fn auth_saved(host: &str, mode: AuthMode) -> LocalizedText<String> {
    let label = auth_mode_label(mode);
    LocalizedText::new(
        format!("{host} 的登录方式：{}（{}）", mode.code(), label.zh),
        format!("{host} auth mode: {} ({})", mode.code(), label.en),
    )
}

/// Printed on the real terminal right before `ssh -tt` takes it over.
pub fn interactive_banner(host: &str) -> LocalizedText<String> {
    LocalizedText::new(
        format!(
            "正在交互式登录 {host}。如果提示密码，请输入远程账号的密码 —— 密码只交给系统 ssh，FarAgent 不读取也不保存。提示主机指纹时请核对后再回答 yes。成功后会复用这条连接，接下来一段时间不必再输。"
        ),
        format!(
            "interactive login to {host}. Type the remote account password if asked - it goes straight to OpenSSH; FarAgent never reads or stores it. Verify the host key fingerprint before answering yes. A successful login is reused, so you will not be asked again for a while."
        ),
    )
}

pub fn login_ok(host: &str) -> LocalizedText<String> {
    LocalizedText::new(
        format!(
            "已登录 {host}，多路复用连接保持中。接下来 `faragent` 与 `faragent doctor --host {host}` 不必再要密码。"
        ),
        format!(
            "logged in to {host}; the multiplexed connection stays open, so `faragent` and `faragent doctor --host {host}` will not ask again."
        ),
    )
}

/// Shown in the TUI when the interactive attempt came back non-zero.
pub fn auth_failed(code: i32) -> LocalizedText<String> {
    LocalizedText::new(
        format!(
            "交互式登录没有成功（ssh 退出码 {code}）；失败原因就在刚才的终端输出里。按 r 重新探测，或再按 a 试一次。"
        ),
        format!(
            "the interactive login did not succeed (ssh exit {code}); the reason is in the terminal output above. Press r to re-probe, or a to try again."
        ),
    )
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

/// The desktop transport: the system OpenSSH client, driven as a child
/// process. Auth flags, ControlMaster reuse and askpass all live here; the
/// `Transport` impl at the bottom of this file is the seam other layers use.
#[derive(Debug, Clone)]
pub struct OpenSshTransport {
    host: String,
    mode: AuthMode,
    /// None when this machine's ssh cannot multiplex (Win32 OpenSSH).
    control_path: Option<String>,
    persist: String,
    mux: bool,
}

impl OpenSshTransport {
    /// Auth mode comes from `~/.faragent/config.json` (`auto` unless set).
    pub fn connect(host: impl Into<String>) -> Result<Self> {
        let host = host.into();
        let mode = faragent_core::config::auth_for(&host);
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

    /// The `Host` alias this transport talks to.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The auth mode this transport was built with.
    pub fn mode(&self) -> AuthMode {
        self.mode
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
        self.command_flavor_with(flavor, &[])
    }

    /// [`command_flavor`](Self::command_flavor) with extra flags inserted
    /// **before the destination** — OpenSSH stops parsing options at the host
    /// name, so anything after it becomes part of the remote command.
    fn command_flavor_with(&self, flavor: Flavor, extra: &[&str]) -> Command {
        let mut cmd = Command::new("ssh");
        for arg in self.args(flavor) {
            cmd.arg(arg);
        }
        for arg in extra {
            cmd.arg(arg);
        }
        cmd.arg(&self.host);
        crate::askpass::apply(&mut cmd, &self.host);
        cmd
    }

    /// Copy-pasteable version of what we ran, for error reports.
    pub fn command_line(&self, flavor: Flavor, remote: &str) -> String {
        self.command_line_ext(flavor, &[], remote)
    }

    /// [`command_line`](Self::command_line) with extra flags placed between
    /// the auth bundle and the host (`-T` for the stdio stream).
    fn command_line_ext(&self, flavor: Flavor, extra: &[&str], remote: &str) -> String {
        let mut s = String::from("ssh");
        for arg in self.args(flavor) {
            s.push(' ');
            s.push_str(&shell_single_quote(&arg));
        }
        for arg in extra {
            s.push(' ');
            s.push_str(&shell_single_quote(arg));
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
    pub fn exec_raw_line(&self, line: &str) -> Result<ExecOutput> {
        self.run_remote_line(line)
    }

    fn run_remote_line(&self, line: &str) -> Result<ExecOutput> {
        let flavor = self.flavor();
        let mut cmd = self.command_flavor(flavor);
        cmd.arg("--");
        cmd.arg(line);
        cmd.stdin(Stdio::null());
        let full = self.command_line(flavor, line);
        self.run_cmd(cmd, &full, EXEC_TIMEOUT)
    }

    /// Login-shell so nvm / Homebrew / ~/.local/bin are visible.
    pub fn exec_login(&self, script: &str) -> Result<ExecOutput> {
        self.run_remote(&bash_login_command(script))
    }

    pub fn exec_login_stdin(&self, bash_lc: &str, stdin: &[u8]) -> Result<ExecOutput> {
        self.exec_stdio(&bash_login_command(bash_lc), stdin)
    }

    /// Run a caller-built remote command line, piping `stdin` into it.
    pub fn exec_stdio(&self, remote: &str, stdin: &[u8]) -> Result<ExecOutput> {
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

    /// Run a PowerShell script on a Windows remote: the default shell (cmd)
    /// only launches `powershell -File -` and the script rides stdin, so
    /// nothing needs cmd quoting and command-line length limits do not apply.
    /// Dynamic values travel as base64 `$args`.
    pub fn exec_win(&self, script: &str, args_b64: &[&str]) -> Result<ExecOutput> {
        let line = ps_stdin_command(args_b64);
        self.exec_stdio(&line, script.as_bytes())
    }

    fn run_remote(&self, remote: &str) -> Result<ExecOutput> {
        let flavor = self.flavor();
        let mut cmd = self.command_flavor(flavor);
        cmd.arg("--");
        cmd.arg(remote);
        cmd.stdin(Stdio::null());
        let line = self.command_line(flavor, remote);
        self.run_cmd(cmd, &line, EXEC_TIMEOUT)
    }

    fn run_cmd(&self, mut cmd: Command, line: &str, timeout: Duration) -> Result<ExecOutput> {
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let child = cmd.spawn().map_err(|e| self.spawn_error(line, e))?;
        self.wait_child(child, line, timeout)
    }

    fn wait_child(&self, child: Child, line: &str, timeout: Duration) -> Result<ExecOutput> {
        match wait_child_timeout(child, timeout) {
            Ok(output) => Ok(output),
            Err(WaitError::Timeout) => Err(anyhow::Error::new(TransportError {
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
        anyhow::Error::new(TransportError {
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

    /// Structured failure for a non-interactive run.
    pub fn error_for(&self, output: &ExecOutput) -> TransportError {
        let raw = output.text();
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
        TransportError {
            host: self.host.clone(),
            mode: self.mode,
            command: self.command_line(self.flavor(), "-"),
            raw,
            status: output.code,
            timed_out: false,
            needs_auth,
            methods,
        }
    }

    pub fn require_ok(&self, output: &ExecOutput) -> Result<()> {
        if output.success() {
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
        parse_auth_methods(&out.text())
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

impl OpenSshTransport {
    /// Hand the local tty to an interactive `ssh -tt` run of `remote_line`;
    /// blocks until it exits. The **caller** owns raw-mode / alternate-screen
    /// state (restore before, re-init after): this only spawns and waits.
    pub fn attach_stdio(&self, remote_line: &str) -> Result<i32> {
        let flavor = interactive_flavor(self.mode);
        let mut cmd = self.command_flavor(flavor);
        cmd.arg("-tt");
        cmd.arg("--");
        cmd.arg(remote_line);
        cmd.stdin(Stdio::inherit());
        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());
        let status = cmd.status()?;
        Ok(status.code().unwrap_or(1))
    }
}

impl OpenSshTransport {
    /// Open `remote_line` interactively inside a local PTY and hand back its
    /// byte streams: the GUI's way to run tmux attach / an installer / a
    /// first login without owning a terminal. The remote still sees `ssh -tt`.
    pub fn attach_stream(&self, remote_line: &str, opts: &AttachOptions) -> Result<AttachStream> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let flavor = interactive_flavor(self.mode);
        let mut cmd = CommandBuilder::new("ssh");
        for arg in self.args(flavor) {
            cmd.arg(arg);
        }
        cmd.arg("-tt");
        cmd.arg(&self.host);
        cmd.arg("--");
        cmd.arg(remote_line);
        cmd.env("TERM", "xterm-256color");
        if opts.askpass {
            for (k, v) in crate::askpass::env_for(&self.host) {
                cmd.env(k, v);
            }
        }
        let pair = native_pty_system().openpty(PtySize {
            rows: opts.rows,
            cols: opts.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        Ok(AttachStream {
            reader,
            writer,
            master: pair.master,
            child,
        })
    }
}

impl OpenSshTransport {
    /// Open a **non-PTY** byte stream to a long-running remote command: all
    /// three stdio piped, `-T` passed explicitly so no pty is ever allocated,
    /// and no timeout — the stream lives until dropped or the remote exits.
    ///
    /// This is the transport a framed protocol rides (the `faragent-helper`
    /// NDJSON channel). For an interactive terminal use [`attach_stream`]
    /// instead; that path needs `ssh -tt` and must not be confused with this
    /// one. `args()` and askpass are shared with every other run, so
    /// ControlMaster reuse and password hosts behave identically.
    ///
    /// [`attach_stream`]: OpenSshTransport::attach_stream
    pub fn spawn_stdio_stream(&self, remote_line: &str) -> Result<CommandStream> {
        let (mut cmd, line) = self.stdio_stream_command(remote_line);
        let mut child = cmd.spawn().map_err(|e| self.spawn_error(&line, e))?;
        let reader = child.stdout.take().ok_or_else(|| {
            anyhow!("ssh stdout was not piped; cannot open a command stream ({line})")
        })?;
        let writer = child.stdin.take().ok_or_else(|| {
            anyhow!("ssh stdin was not piped; cannot open a command stream ({line})")
        })?;
        let stderr_pipe = child.stderr.take();
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&stderr);
        let stderr_thread = thread::spawn(move || drain_stderr(stderr_pipe, sink));
        Ok(CommandStream {
            reader: Box::new(reader),
            writer: Box::new(writer),
            child,
            stderr,
            stderr_thread: Some(stderr_thread),
        })
    }

    /// [`spawn_stdio_stream`](Self::spawn_stdio_stream) under the login shell
    /// (`bash -lc`), so nvm / Homebrew / `~/.local/bin` stay on PATH for the
    /// remote process — the deployment path for `faragent-helper`.
    pub fn spawn_login_stdio_stream(&self, script: &str) -> Result<CommandStream> {
        self.spawn_stdio_stream(&bash_login_command(script))
    }

    /// The command a stdio stream is built from, plus its copy-pasteable
    /// rendering. Split out so the argv (and, above all, the **absence** of
    /// `-tt`) is testable without a reachable host.
    fn stdio_stream_command(&self, remote_line: &str) -> (Command, String) {
        let flavor = self.flavor();
        // `-T` is the explicit negation of `-t`: never allocate a remote pty.
        // It must sit before the destination or OpenSSH would treat it as part
        // of the remote command.
        let mut cmd = self.command_flavor_with(flavor, &["-T"]);
        cmd.arg("--");
        cmd.arg(remote_line);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let line = self.command_line_ext(flavor, &["-T"], remote_line);
        (cmd, line)
    }
}

/// Keep only the newest [`crate::STDERR_TAIL_LIMIT`] bytes, so a remote that
/// spams stderr cannot grow this process without bound.
fn drain_stderr(pipe: Option<impl Read>, sink: Arc<Mutex<Vec<u8>>>) {
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if let Ok(mut buf) = sink.lock() {
                    buf.extend_from_slice(&chunk[..n]);
                    let overflow = buf.len().saturating_sub(crate::STDERR_TAIL_LIMIT);
                    if overflow > 0 {
                        buf.drain(..overflow);
                    }
                }
            }
        }
    }
}

/// Which interactive bundle fits this host: password hosts should not burn
/// their `MaxAuthTries` budget on keys they do not own.
fn interactive_flavor(mode: AuthMode) -> Flavor {
    match mode {
        AuthMode::Password => Flavor::InteractivePassword,
        AuthMode::Auto | AuthMode::Key => Flavor::InteractiveKey,
    }
}

/// The trait seam: everything FarAgent's logic needs from one connection.
/// Every method lands on the system-OpenSSH child process today; a mobile
/// build adds an in-process implementation (russh) behind `open()`.
impl Transport for OpenSshTransport {
    fn host(&self) -> &str {
        OpenSshTransport::host(self)
    }

    fn mode(&self) -> AuthMode {
        OpenSshTransport::mode(self)
    }

    fn exec_raw_line(&self, line: &str) -> Result<ExecOutput> {
        OpenSshTransport::exec_raw_line(self, line)
    }

    fn exec_login(&self, script: &str) -> Result<ExecOutput> {
        OpenSshTransport::exec_login(self, script)
    }

    fn exec_login_stdin(&self, script: &str, stdin: &[u8]) -> Result<ExecOutput> {
        OpenSshTransport::exec_login_stdin(self, script, stdin)
    }

    fn exec_win(&self, script: &str, args_b64: &[&str]) -> Result<ExecOutput> {
        OpenSshTransport::exec_win(self, script, args_b64)
    }

    fn attach_stdio(&self, remote_line: &str) -> Result<i32> {
        OpenSshTransport::attach_stdio(self, remote_line)
    }

    fn attach_stream(&self, remote_line: &str, opts: &AttachOptions) -> Result<AttachStream> {
        OpenSshTransport::attach_stream(self, remote_line, opts)
    }

    fn error_for(&self, out: &ExecOutput) -> TransportError {
        OpenSshTransport::error_for(self, out)
    }

    fn require_ok(&self, out: &ExecOutput) -> Result<()> {
        OpenSshTransport::require_ok(self, out)
    }

    fn server_auth_methods(&self) -> Option<String> {
        OpenSshTransport::server_auth_methods(self)
    }

    fn muxed(&self) -> bool {
        OpenSshTransport::muxed(self)
    }

    fn master_alive(&self) -> bool {
        OpenSshTransport::master_alive(self)
    }
}

/// Single remote argv. OpenSSH joins extra args with spaces and does **not**
/// re-quote, so `ssh host -- bash -lc 'printf hi'` must be one string
/// or the remote shell runs `bash -lc printf` and drops `hi`.
pub fn bash_login_command(script: &str) -> String {
    format!("bash -lc {}", shell_single_quote(script))
}

/// How a PowerShell script travels to a Windows remote: the script itself on
/// stdin (`-File -`), dynamic values as base64 `$args` on the command line.
/// Lives here (not in the remote-script crate) because it is how this
/// transport delivers a payload, not a remote-side script.
fn ps_stdin_command(args_b64: &[&str]) -> String {
    let mut s = String::from("powershell -NoProfile -ExecutionPolicy Bypass -File -");
    for a in args_b64 {
        s.push(' ');
        s.push_str(a);
    }
    s
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
) -> std::result::Result<ExecOutput, WaitError> {
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
    Ok(ExecOutput {
        code: status.code(),
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
        // `~` expands against the real home; separators follow the platform.
        assert!(hosts[0]
            .identity
            .as_deref()
            .unwrap()
            .replace('\\', "/")
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
    fn ps_stdin_command_carries_args_verbatim() {
        let cmd = ps_stdin_command(&["QUJD", "REVG"]);
        assert!(cmd.starts_with("powershell -NoProfile -ExecutionPolicy Bypass -File - "));
        assert!(cmd.ends_with("QUJD REVG"));
        assert!(
            cmd.is_ascii(),
            "ps_stdin_command must stay ASCII on the ssh command line"
        );
    }

    /// Build a transport with no `~/.faragent` side effects and no `ssh -V`
    /// probe, so a unit test can inspect the argv it would run.
    fn test_transport(host: &str) -> OpenSshTransport {
        OpenSshTransport {
            host: host.into(),
            mode: AuthMode::Key,
            control_path: Some("/tmp/faragent-test-cm/%r@%h:%p".into()),
            persist: KEY_PERSIST.into(),
            mux: true,
        }
    }

    #[test]
    fn stdio_stream_is_non_pty_and_rides_the_login_shell() {
        let t = test_transport("example.invalid");
        let (cmd, line) = t.stdio_stream_command(&bash_login_command("run helper"));
        assert_eq!(cmd.get_program(), "ssh");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|a| a == "-T"), "must disable the pty: {args:?}");
        assert!(
            !args.iter().any(|a| a == "-t" || a == "-tt"),
            "a command stream must never request a pty: {args:?}"
        );
        // Flags come before the destination; `--` ends option parsing.
        let dash_dash = args.iter().position(|a| a == "--").expect("-- separator");
        let host_at = args
            .iter()
            .position(|a| a == "example.invalid")
            .expect("host");
        assert!(host_at < dash_dash, "{args:?}");
        assert!(args.iter().position(|a| a == "-T").unwrap() < host_at);
        assert_eq!(args.last().unwrap(), "bash -lc 'run helper'");
        // The copy-pasteable rendering must show what we really ran.
        assert!(line.contains(" -T "), "{line}");
        assert!(!line.contains(" -tt"), "{line}");
        assert!(line.ends_with(" -- bash -lc 'run helper'"), "{line}");
    }

    /// Puts a directory in front of `PATH` for the duration of a test and
    /// restores it even if the test panics. Only ever used by tests that
    /// shadow `ssh`, and the shadow directory contains nothing else.
    #[cfg(unix)]
    struct PathGuard(Option<std::ffi::OsString>);

    #[cfg(unix)]
    impl PathGuard {
        fn prepend(dir: &Path) -> Self {
            let saved = std::env::var_os("PATH");
            let mut joined = dir.as_os_str().to_os_string();
            if let Some(s) = &saved {
                joined.push(":");
                joined.push(s);
            }
            std::env::set_var("PATH", joined);
            Self(saved)
        }
    }

    #[cfg(unix)]
    impl Drop for PathGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(p) => std::env::set_var("PATH", p),
                None => std::env::remove_var("PATH"),
            }
        }
    }

    /// The real spawn path, end to end, against a stand-in for `ssh`: proves
    /// all three stdio are piped (stdin reaches the child, stdout and stderr
    /// reach us) and that `Drop` really reaps the child.
    #[cfg(unix)]
    #[test]
    fn stdio_stream_pipes_all_three_stdio_and_drop_reaps_the_child() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let argv_file = dir.path().join("argv");
        let pid_file = dir.path().join("pid");
        let script = format!(
            r#"#!/bin/sh
printf '%s\n' "$@" > '{argv}'
printf '%s' "$$" > '{pid}'
case " $* " in
  *" -V "*) exit 0 ;;
esac
printf 'FAKE_STDOUT\n'
printf 'FAKE_STDERR\n' >&2
while IFS= read -r _l; do printf 'echo:%s\n' "$_l"; done
"#,
            argv = argv_file.display(),
            pid = pid_file.display(),
        );
        let fake = dir.path().join("ssh");
        std::fs::write(&fake, script).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let _path = PathGuard::prepend(dir.path());
        let t = test_transport("fake.invalid");
        let mut stream = t.spawn_login_stdio_stream("run helper").unwrap();

        {
            let mut out = BufReader::new(&mut *stream.reader);
            let mut line = String::new();
            out.read_line(&mut line).unwrap();
            assert_eq!(line.trim_end(), "FAKE_STDOUT");
            // Our writer is the remote's stdin.
            stream.writer.write_all(b"ping\n").unwrap();
            stream.writer.flush().unwrap();
            line.clear();
            out.read_line(&mut line).unwrap();
            assert_eq!(line.trim_end(), "echo:ping");
        }

        // stderr was piped into this process and drained: the tail saw it. Had
        // it been inherited it would have gone to the test runner's stderr and
        // the tail would still be empty.
        let mut tail = String::new();
        for _ in 0..100 {
            tail = stream.stderr_tail();
            if tail.contains("FAKE_STDERR") {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(tail.contains("FAKE_STDERR"), "stderr tail was {tail:?}");

        let argv = std::fs::read_to_string(&argv_file).unwrap();
        assert!(argv.lines().any(|l| l == "-T"), "{argv}");
        assert!(!argv.contains("-tt"), "{argv}");
        assert!(argv.lines().any(|l| l == "fake.invalid"), "{argv}");
        assert!(
            argv.lines().any(|l| l == "bash -lc 'run helper'"),
            "remote line must be the login-shell wrapper: {argv}"
        );

        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let alive = |pid: i32| {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        assert!(alive(pid), "the stand-in ssh ({pid}) should be running");
        drop(stream);
        let mut reaped = false;
        for _ in 0..100 {
            if !alive(pid) {
                reaped = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(reaped, "dropping CommandStream left child {pid} running");
    }

    #[test]
    fn stderr_tail_drops_the_oldest_bytes() {
        let sink = Arc::new(Mutex::new(Vec::new()));
        drain_stderr(Some(std::io::Cursor::new(vec![b'x'; 40_000])), Arc::clone(&sink));
        let buf = sink.lock().unwrap();
        assert_eq!(buf.len(), crate::STDERR_TAIL_LIMIT);
        assert!(buf.iter().all(|b| *b == b'x'));
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
        let err = TransportError {
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

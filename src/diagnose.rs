//! Turn a raw OpenSSH failure into something the user can act on.
//!
//! FarAgent never re-implements SSH, so OpenSSH's own output is the ground
//! truth. We keep it verbatim, then name the likely cause and the exact
//! commands that fix it — instead of making the user go read a wiki first.

use crate::remote::HostOs;
use crate::ssh::{self, AuthMode, TransportError};
use crate::text::{Lang, Lines, LocalizedText};

/// Every failure we know how to explain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    /// Local `ssh` binary missing.
    SshMissing,
    /// Server refused the key: not installed, wrong user, no permission.
    PublickeyDenied,
    /// Server only accepts password / keyboard-interactive.
    NeedsPassword,
    /// Password accepted as a method, but the credential is wrong.
    PasswordDenied,
    /// ssh-agent offered too many keys and the server hung up.
    TooManyAuthFailures,
    /// Host key not in `known_hosts` and BatchMode cannot answer "yes".
    HostKeyUnknown,
    /// Host key changed (rebuild, or something in the middle).
    HostKeyChanged,
    /// `~/.ssh` files are too permissive (or wrongly owned).
    PrivateFilePermissions,
    /// Private key exists but OpenSSH cannot read it.
    KeyUnreadable,
    /// `IdentityFile` points at a file that is not there.
    KeyMissing,
    /// Key needs a passphrase that no agent remembers.
    KeyPassphrase,
    /// Hostname does not resolve.
    DnsFailure,
    /// TCP reached the host but nothing listens on that port.
    ConnectionRefused,
    /// No answer at all (firewall, wrong network, hung login shell).
    ConnectionTimeout,
    /// No route to the address from this machine.
    NoRoute,
    /// TCP connect then immediate close (banned, or sshd not really up).
    KexClosed,
    /// Client and server cannot agree on algorithms (old sshd).
    VersionMismatch,
    /// SSH works, but the remote login shell did not run bash / our probe.
    RemoteBash,
    /// The remote's default shell cannot run our commands at all (Win32
    /// OpenSSH wired to a missing shell, POSIX login shell not executable).
    RemoteShellUnsupported,
    /// Unclassified: raw output is still shown.
    Unknown,
}

impl Problem {
    /// Used by the tests to prove every variant has wording in both languages.
    #[allow(dead_code)]
    pub const ALL: [Problem; 20] = [
        Problem::SshMissing,
        Problem::PublickeyDenied,
        Problem::NeedsPassword,
        Problem::PasswordDenied,
        Problem::TooManyAuthFailures,
        Problem::HostKeyUnknown,
        Problem::HostKeyChanged,
        Problem::PrivateFilePermissions,
        Problem::KeyUnreadable,
        Problem::KeyMissing,
        Problem::KeyPassphrase,
        Problem::DnsFailure,
        Problem::ConnectionRefused,
        Problem::ConnectionTimeout,
        Problem::NoRoute,
        Problem::KexClosed,
        Problem::VersionMismatch,
        Problem::RemoteBash,
        Problem::RemoteShellUnsupported,
        Problem::Unknown,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Problem::SshMissing => "ssh_missing",
            Problem::PublickeyDenied => "publickey_denied",
            Problem::NeedsPassword => "needs_password",
            Problem::PasswordDenied => "password_denied",
            Problem::TooManyAuthFailures => "too_many_auth_failures",
            Problem::HostKeyUnknown => "host_key_unknown",
            Problem::HostKeyChanged => "host_key_changed",
            Problem::PrivateFilePermissions => "private_file_permissions",
            Problem::KeyUnreadable => "key_unreadable",
            Problem::KeyMissing => "key_missing",
            Problem::KeyPassphrase => "key_passphrase",
            Problem::DnsFailure => "dns_failure",
            Problem::ConnectionRefused => "connection_refused",
            Problem::ConnectionTimeout => "connection_timeout",
            Problem::NoRoute => "no_route",
            Problem::KexClosed => "kex_closed",
            Problem::VersionMismatch => "version_mismatch",
            Problem::RemoteBash => "remote_bash",
            Problem::RemoteShellUnsupported => "remote_shell_unsupported",
            Problem::Unknown => "unknown",
        }
    }
}

/// What we know about the host we were talking to; used to fill in commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    /// `Host` alias, what the user typed in the picker.
    pub host: String,
    /// `HostName` (or the alias) as OpenSSH resolves it.
    pub target: String,
    pub port: u16,
    /// Auth methods the server reported, if we could ask.
    pub methods: String,
    pub mode: AuthMode,
    pub identity: Option<String>,
    /// The local client's platform. Advice for local problems (missing ssh,
    /// key file permissions) must match the machine the user is sitting at —
    /// kept as data so both wordings are testable on any CI runner.
    pub local: HostOs,
}

impl Facts {
    pub fn for_host(host: &str) -> Self {
        let found = ssh::list_hosts()
            .ok()
            .and_then(|hosts| hosts.into_iter().find(|h| h.alias == host));
        let local = if cfg!(windows) {
            HostOs::Windows
        } else {
            HostOs::Posix
        };
        match found {
            Some(h) => Facts {
                host: h.alias.clone(),
                target: h.target().to_string(),
                port: h.port_or_22(),
                identity: h.identity.clone(),
                methods: String::new(),
                mode: AuthMode::default(),
                local,
            },
            None => Facts {
                host: host.to_string(),
                target: host.to_string(),
                port: 22,
                identity: None,
                methods: String::new(),
                mode: AuthMode::default(),
                local,
            },
        }
    }

    pub fn with(mut self, methods: impl Into<String>, mode: AuthMode) -> Self {
        self.methods = methods.into();
        self.mode = mode;
        self
    }

    /// Port flag for copy-paste commands (`""` on 22).
    pub fn port_flag(&self) -> String {
        if self.port == 22 {
            String::new()
        } else {
            format!(" -p {}", self.port)
        }
    }

    /// `ssh-keygen -R` wants `[host]:port` for non-default ports.
    pub fn known_hosts_key(&self) -> String {
        if self.port == 22 {
            self.target.clone()
        } else {
            format!("[{}]:{}", self.target, self.port)
        }
    }
}

/// A failure with its verbatim output and the steps that fix it.
///
/// `summary`/`steps` are computed in both languages up front; the UI picks
/// one at render time (`pick(lang)`), so constructing a `Diagnosis` never
/// needs to know the user's language.
#[derive(Debug, Clone)]
pub struct Diagnosis {
    pub problem: Problem,
    pub facts: Facts,
    pub summary: LocalizedText<&'static str>,
    pub steps: Lines,
    pub raw: String,
    pub command: String,
    pub needs_auth: bool,
    pub timed_out: bool,
}

impl Diagnosis {
    pub fn of(err: &TransportError) -> Self {
        let facts = Facts::for_host(&err.host).with(err.methods.clone(), err.mode);
        Self::build(
            &err.raw,
            facts,
            err.raw.clone(),
            err.command.clone(),
            err.needs_auth,
            err.timed_out,
        )
    }

    /// For failures that never reached OpenSSH (probe parsing, our own timeout
    /// wording, install errors): classify the message we do have.
    pub fn of_message(host: &str, message: &str) -> Self {
        let facts = Facts::for_host(host);
        Self::build(
            message,
            facts,
            message.to_string(),
            String::new(),
            false,
            false,
        )
    }

    fn build(
        text: &str,
        facts: Facts,
        raw_full: String,
        command: String,
        needs_auth: bool,
        timed_out: bool,
    ) -> Self {
        let problem = classify(text);
        Self {
            problem,
            summary: summary(problem),
            steps: steps(problem, &facts),
            raw: raw_full,
            command,
            facts,
            needs_auth,
            timed_out,
        }
    }

    /// Plain text for the CLI (`doctor`, `probe`, `login`) and the clipboard.
    pub fn plain(&self, lang: Lang) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "{} {}: {}\n",
            label().pick(lang),
            self.facts.host,
            self.summary.pick(lang)
        ));
        if !self.command.is_empty() {
            out.push_str(&format!(
                "{}: {}\n",
                command_label().pick(lang),
                self.command
            ));
        }
        let raw = self.raw.trim();
        if !raw.is_empty() {
            out.push_str(&format!("{}:\n", raw_label().pick(lang)));
            for line in raw.lines() {
                out.push_str("  ");
                out.push_str(line);
                out.push('\n');
            }
        }
        out.push_str(&format!("{}:\n", fixes_label().pick(lang)));
        for (i, step) in self.steps.pick(lang).iter().enumerate() {
            out.push_str(&format!("  {}. {}\n", i + 1, step));
        }
        out.push_str(&format!(
            "{}: {}\n",
            docs_label().pick(lang),
            ssh_doc().pick(lang)
        ));
        out
    }

    /// Re-label the report. Used after an interactive login that the user just
    /// attempted: the raw text is a generic `Permission denied (...)`, but the
    /// useful advice is "that password did not work", not "use password mode".
    pub fn relabel(mut self, problem: Problem) -> Self {
        self.problem = problem;
        self.summary = summary(problem);
        self.steps = steps(problem, &self.facts);
        self
    }
}

// The long-form wording lives here, next to the classification it explains.
// Everything a UI needs is produced as `LocalizedText`; only the CLI-facing
// `plain()` picks a language itself.

pub fn label() -> LocalizedText<&'static str> {
    LocalizedText::new("连接失败", "connection failed")
}

pub fn title(host: &str) -> LocalizedText<String> {
    LocalizedText::new(
        format!("FarAgent · {host} · 连接失败"),
        format!("FarAgent · {host} · connection failed"),
    )
}

/// Panel title; the slug (`publickey_denied`, ...) keeps it greppable.
pub fn list_title(slug: &str) -> LocalizedText<String> {
    LocalizedText::new(
        format!("原始报错与解决方案  [{slug}]"),
        format!("raw error and fix  [{slug}]"),
    )
}

pub fn raw_label() -> LocalizedText<&'static str> {
    LocalizedText::new("ssh 原始输出", "raw ssh output")
}

pub fn command_label() -> LocalizedText<&'static str> {
    LocalizedText::new("FarAgent 实际执行的命令", "command FarAgent ran")
}

pub fn fixes_label() -> LocalizedText<&'static str> {
    LocalizedText::new("处理步骤", "fixes")
}

pub fn docs_label() -> LocalizedText<&'static str> {
    LocalizedText::new("文档", "docs")
}

pub fn ssh_doc() -> LocalizedText<&'static str> {
    LocalizedText::new(
        "docs/zh/ssh-access.md（连不上时：原始报错 → 原因 → 解决）",
        "docs/en/ssh-access.md (when it fails: raw error -> cause -> fix)",
    )
}

pub fn summary(p: Problem) -> LocalizedText<&'static str> {
    use Problem as P;
    match p {
        P::SshMissing => LocalizedText::new(
            "本机找不到 OpenSSH 客户端（ssh）：FarAgent 只负责驱动系统 ssh。",
            "no local OpenSSH client: FarAgent drives the system `ssh`, it does not ship its own.",
        ),
        P::PublickeyDenied => LocalizedText::new(
            "远程拒绝了公钥：公钥没送到那台机器、账号不对，或远程权限不对。FarAgent 用 BatchMode，不会弹密码框。",
            "the server refused the key: the public key is not on that machine, the user is wrong, or remote permissions are off. FarAgent runs BatchMode, so it never shows a password prompt.",
        ),
        P::NeedsPassword => LocalizedText::new(
            "远程只接受密码 / 键盘交互，publickey 不通过；FarAgent 不能替你弹密码框。",
            "this host only accepts password / keyboard-interactive auth. FarAgent cannot type a password by itself.",
        ),
        P::PasswordDenied => LocalizedText::new(
            "密码方式被拒绝：账号或密码不对，或这个账号被 sshd 挡了。",
            "password auth was refused: wrong user or password, or sshd rejects that account.",
        ),
        P::TooManyAuthFailures => LocalizedText::new(
            "本机 ssh-agent 里的钥匙太多，服务端在轮到你真正那把之前就断开了。",
            "too many keys in the local ssh-agent: the server hung up before it reached the right one.",
        ),
        P::HostKeyUnknown => LocalizedText::new(
            "这台主机的指纹还不在本机 known_hosts 里（第一次连接），而 BatchMode 不能替你回答 yes。",
            "this host's key is not in known_hosts yet, and BatchMode cannot answer the yes/no prompt for you.",
        ),
        P::HostKeyChanged => LocalizedText::new(
            "远程主机指纹变了：系统重装、云主机重建，或者有人在中间转发。",
            "the host key changed: reinstall, rebuilt VM, or something is intercepting the connection.",
        ),
        P::PrivateFilePermissions => LocalizedText::new(
            "本机 ~/.ssh 下的文件权限过宽（或属主不对），OpenSSH 为安全起见拒绝使用。",
            "a local ~/.ssh file is too permissive (or owned by someone else), so OpenSSH refuses to use it.",
        ),
        P::KeyUnreadable => LocalizedText::new(
            "OpenSSH 读不了这把私钥：格式不对、文件损坏，或者把 .pub 当成了私钥。",
            "OpenSSH cannot read that private key: bad format, corrupt file, or a .pub was given instead.",
        ),
        P::KeyMissing => LocalizedText::new(
            "~/.ssh/config 里 IdentityFile 指的文件不存在或读不了。",
            "the IdentityFile in ~/.ssh/config does not exist or cannot be read.",
        ),
        P::KeyPassphrase => LocalizedText::new(
            "这把私钥带口令，但本机没有 ssh-agent 记住它，而 BatchMode 不会弹输入框。",
            "the key has a passphrase that no ssh-agent remembers, and BatchMode never prompts.",
        ),
        P::DnsFailure => LocalizedText::new(
            "解析不了这个主机名：HostName 写错、DNS 不通，或这个内网名字要先连上对应的网。",
            "the hostname does not resolve: typo in HostName, DNS trouble, or an internal name that needs VPN/Tailscale first.",
        ),
        P::ConnectionRefused => LocalizedText::new(
            "能到这台机器，但那个端口上没人监听：sshd 没启动、端口改了，或被防火墙拒绝。",
            "the host answers but nothing listens on that port: sshd stopped, wrong port, or a firewall reject.",
        ),
        P::ConnectionTimeout => LocalizedText::new(
            "完全没有响应：地址不可达、防火墙悄悄丢包，或者远程登录壳卡住不返回。",
            "no response at all: unreachable address, silently dropped packets, or a remote login shell that hangs.",
        ),
        P::NoRoute => LocalizedText::new(
            "本机没有到这个地址的路由：不在同一张网，或网卡 / VPN 没起来。",
            "no route to that address from this machine: wrong network, or the VPN/adapter is down.",
        ),
        P::KexClosed => LocalizedText::new(
            "TCP 连上了，但 SSH 握手阶段就被关掉：sshd 没真的在跑、被 fail2ban 类机制拉黑，或 hosts.deny 拒绝。",
            "TCP connected but the SSH handshake was closed: sshd not really running, an IP ban, or a TCP wrapper deny.",
        ),
        P::VersionMismatch => LocalizedText::new(
            "客户端和服务端谈不拢算法：多半是远程 sshd 太老，只提供 ssh-rsa / 老 KEX。",
            "client and server cannot agree on algorithms: usually an old sshd offering only ssh-rsa / legacy KEX.",
        ),
        P::RemoteBash => LocalizedText::new(
            "SSH 通了，但远程登录壳没跑成 bash，或没有打印出 FarAgent 需要的标记。",
            "SSH works, but the remote login shell did not run bash or did not print the marker FarAgent expects.",
        ),
        P::RemoteShellUnsupported => LocalizedText::new(
            "SSH 通了，但远端的默认 shell 根本不认识我们的命令（Windows 上常见于 sshd 默认 shell 配置损坏）。",
            "SSH works, but the remote's default shell does not recognize our commands at all (on Windows this usually means sshd's default-shell setting is broken).",
        ),
        P::Unknown => LocalizedText::new(
            "这个报错 FarAgent 还认不出来，下面是 ssh 的原始输出。",
            "FarAgent does not recognize this failure yet; the raw ssh output is below.",
        ),
    }
}

pub fn steps(p: Problem, f: &Facts) -> Lines {
    LocalizedText::new(steps_for(Lang::Zh, p, f), steps_for(Lang::En, p, f))
}

/// Fix steps for `p` in `lang`, with the facts interpolated into the
/// copy-pasteable commands. Both languages run the same arms.
fn steps_for(lang: Lang, p: Problem, f: &Facts) -> Vec<String> {
    use Problem as P;
    let host = f.host.as_str();
    let target = f.target.as_str();
    let port = f.port_flag();
    let port_n = f.port;
    let kh = f.known_hosts_key();
    let key = f
        .identity
        .clone()
        .unwrap_or_else(|| "~/.ssh/id_ed25519".into());
    let steps: Vec<String> = match (lang, p) {
            (Lang::Zh, P::SshMissing) if f.local == crate::remote::HostOs::Windows => vec![
                "先在 PowerShell 里确认：`ssh -V`；报“无法将 ssh 项识别为 cmdlet”说明没装或不在 PATH。".into(),
                "Windows 11 自带 OpenSSH 客户端，一般在 `C:\\Windows\\System32\\OpenSSH\\ssh.exe`。".into(),
                "没装的话：设置 → 系统 → 可选功能 → 添加功能 → 安装「OpenSSH 客户端」，或在管理员 PowerShell 运行 `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`。".into(),
                "装好后重开终端确认：`ssh -V` 与 `where.exe ssh` 都应成功。".into(),
            ],
            (Lang::En, P::SshMissing) if f.local == crate::remote::HostOs::Windows => vec![
                "Check in PowerShell: `ssh -V`; \"not recognized as the name of a cmdlet\" means it is missing or not on PATH.".into(),
                "Windows 11 ships the OpenSSH client, usually at `C:\\Windows\\System32\\OpenSSH\\ssh.exe`.".into(),
                "If missing: Settings -> System -> Optional features -> Add a feature -> \"OpenSSH Client\", or run `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0` in an admin PowerShell.".into(),
                "Reopen the terminal and confirm: both `ssh -V` and `where.exe ssh` should succeed.".into(),
            ],
            (Lang::Zh, P::SshMissing) => vec![
                "先确认有没有：`ssh -V`。macOS 自带 OpenSSH，报 command not found 说明没装或不在 PATH。".into(),
                "macOS：`xcode-select --install`，或 `brew install openssh`。".into(),
                "Debian / Ubuntu：`sudo apt-get install -y openssh-client`；Fedora：`sudo dnf install -y openssh-clients`；Arch：`sudo pacman -S openssh`。".into(),
                "装好后确认 PATH：`command -v ssh`。".into(),
            ],
            (Lang::En, P::SshMissing) => vec![
                "Check whether it exists: `ssh -V`. macOS ships OpenSSH; `command not found` means it is missing or not on PATH.".into(),
                "macOS: `xcode-select --install`, or `brew install openssh`.".into(),
                "Debian / Ubuntu: `sudo apt-get install -y openssh-client`; Fedora: `sudo dnf install -y openssh-clients`; Arch: `sudo pacman -S openssh`.".into(),
                "Then confirm: `command -v ssh`.".into(),
            ],
            (Lang::Zh, P::PublickeyDenied) => vec![
                format!("先看清客户端送出了哪把钥匙：`ssh -v{port} {host} true`。"),
                "确认本机有钥匙：`ls -l ~/.ssh/*.pub`。没有就生成一把：`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`。".into(),
                format!("把公钥装到远程（这一步远程还得能用密码或别的方式登录）：`ssh-copy-id{port} -i {key}.pub {host}`。"),
                format!("在 ~/.ssh/config 的 `Host {host}` 下钉住这把钥匙：`IdentityFile {key}` 和 `IdentitiesOnly yes`。"),
                format!("远程补权限：`chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`，再看 `{target}` 上这个用户名是否正确。"),
                format!("如果这台机器只让用密码：`faragent auth --host {host} --mode password`，再 `faragent login --host {host}`（TUI 里按 a 同样可以）。"),
            ],
            (Lang::En, P::PublickeyDenied) => vec![
                format!("First see which key the client offered: `ssh -v{port} {host} true`."),
                "Check you have a key: `ls -l ~/.ssh/*.pub`. If not: `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`.".into(),
                format!("Install the public key on the remote (that step still needs a working login): `ssh-copy-id{port} -i {key}.pub {host}`."),
                format!("Pin that key for this host in ~/.ssh/config: `IdentityFile {key}` plus `IdentitiesOnly yes`."),
                format!("Fix remote permissions: `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`, and check that the user exists on {target}."),
                format!("If this machine only allows passwords: `faragent auth --host {host} --mode password`, then `faragent login --host {host}` (or press a in the TUI)."),
            ],
            (Lang::Zh, P::NeedsPassword) if f.local == crate::remote::HostOs::Windows => {
                let mut steps = Vec::new();
                steps.push(
                    "Windows 自带的 ssh 不支持连接复用，FarAgent 改为在内存里记住一次密码（不写盘、退出即清除），后续命令经 SSH_ASKPASS 自动应答。".into(),
                );
                steps.push(format!(
                    "在 TUI 的问题页按 a 输入密码即可；主机指纹等交互提示仍由 `faragent login --host {host}` 处理。"
                ));
                if f.mode != crate::ssh::AuthMode::Password {
                    steps.push(format!(
                        "也可以先把这台机器固定为密码模式：`faragent auth --host {host} --mode password`。"
                    ));
                }
                steps.push(
                    "更稳的做法仍是配密钥 / ssh-agent（见文档「配好密钥」），之后不再需要输入密码。".into(),
                );
                steps
            }
            (Lang::En, P::NeedsPassword) if f.local == crate::remote::HostOs::Windows => {
                let mut steps = Vec::new();
                steps.push(
                    "Windows' built-in ssh cannot multiplex, so FarAgent remembers the password in memory instead (never written to disk, gone on exit) and answers ssh through SSH_ASKPASS.".into(),
                );
                steps.push(format!(
                    "Press a on the TUI problem screen to type it; host-key questions still go through `faragent login --host {host}`."
                ));
                if f.mode != crate::ssh::AuthMode::Password {
                    steps.push(format!(
                        "You can also pin this host to password mode first: `faragent auth --host {host} --mode password`."
                    ));
                }
                steps.push(
                    "Keys / ssh-agent remain the sturdier option (see \"set up keys\" in the docs).".into(),
                );
                steps
            }
            (Lang::Zh, P::NeedsPassword) => {
                let mut steps = Vec::new();
                if f.mode == crate::ssh::AuthMode::Password {
                    steps.push(format!(
                        "这台主机已经是密码模式，直接做一次交互式登录：`faragent login --host {host}`。"
                    ));
                } else {
                    steps.push(format!(
                        "把这台主机切到密码模式：`faragent auth --host {host} --mode password`。"
                    ));
                    steps.push(format!(
                        "再做一次交互式登录（密码只交给系统 ssh，FarAgent 不保存）：`faragent login --host {host}`。"
                    ));
                }
                steps.push(
                    "登录成功后 FarAgent 会复用这条多路复用连接，一段时间内不再问你密码；断开或过期后再 login 一次即可。TUI 的问题页按 a 是同一件事。".into(),
                );
                steps.push(format!(
                    "更稳的做法仍然是配密钥（见文档「配好密钥」），之后用 `faragent auth --host {host} --mode auto` 切回来。"
                ));
                steps
            }
            (Lang::En, P::NeedsPassword) => {
                let mut steps = Vec::new();
                if f.mode == crate::ssh::AuthMode::Password {
                    steps.push(format!(
                        "This host is already in password mode; just do one interactive login: `faragent login --host {host}`."
                    ));
                } else {
                    steps.push(format!(
                        "Switch this host to password mode: `faragent auth --host {host} --mode password`."
                    ));
                    steps.push(format!(
                        "Then do one interactive login (the password goes straight to OpenSSH; FarAgent never stores it): `faragent login --host {host}`."
                    ));
                }
                steps.push(
                    "After that FarAgent reuses the multiplexed connection, so it will not ask again for a while; log in once more when it expires. Pressing a on the TUI problem screen does the same thing.".into(),
                );
                steps.push(format!(
                    "Keys are still the sturdier option (see \"set up keys\" in the docs); then `faragent auth --host {host} --mode auto`."
                ));
                steps
            }
            (Lang::Zh, P::PasswordDenied) => vec![
                format!("手工确认账号密码：`ssh{port} {host}`。"),
                format!("核对用户名：~/.ssh/config 里 `Host {host}` 的 `User` 必须是远程账号（远程 `whoami` 对不上就改）。"),
                "远程看认证日志：Linux `sudo tail -f /var/log/auth.log`（或 `journalctl -u ssh -f`）；macOS `log stream --predicate 'process == \"sshd\"'`。".into(),
                "检查 sshd 是否放行这个用户：AllowUsers / DenyUsers / PasswordAuthentication / KbdInteractiveAuthentication。".into(),
            ],
            (Lang::En, P::PasswordDenied) => vec![
                format!("Verify the credentials by hand: `ssh{port} {host}`."),
                format!("Check the user: `User` under `Host {host}` in ~/.ssh/config must be the remote account (compare with `whoami` on the remote)."),
                "Read the auth log on the remote: Linux `sudo tail -f /var/log/auth.log` (or `journalctl -u ssh -f`); macOS `log stream --predicate 'process == \"sshd\"'`.".into(),
                "Check sshd allows that account: AllowUsers / DenyUsers / PasswordAuthentication / KbdInteractiveAuthentication.".into(),
            ],
            (Lang::Zh, P::TooManyAuthFailures) => vec![
                "看看 agent 里装了几把：`ssh-add -l`。".into(),
                format!("在 ~/.ssh/config 的 `Host {host}` 下钉死一把：`IdentityFile {key}` 和 `IdentitiesOnly yes`。"),
                format!("直接验证效果：`ssh -o IdentitiesOnly=yes -i {key}{port} {host} true`。"),
                "清掉不用的钥匙：`ssh-add -D`，再按需 `ssh-add` 需要的那些。".into(),
            ],
            (Lang::En, P::TooManyAuthFailures) => vec![
                "Count what the agent holds: `ssh-add -l`.".into(),
                format!("Pin one key for this host in ~/.ssh/config: `IdentityFile {key}` plus `IdentitiesOnly yes`."),
                format!("Verify: `ssh -o IdentitiesOnly=yes -i {key}{port} {host} true`."),
                "Drop the rest: `ssh-add -D`, then `ssh-add` only the keys you need.".into(),
            ],
            (Lang::Zh, P::HostKeyUnknown) => vec![
                format!("交互式确认一次指纹（TUI 里按 a 等效）：`faragent login --host {host}`。"),
                format!("或者手工：`ssh{port} {host} true`，核对指纹后回答 yes。"),
                format!("想直接写入（务必通过可信渠道核对指纹）：`ssh-keyscan -t ed25519{port} {target} >> ~/.ssh/known_hosts`。"),
                "确认之后回到 FarAgent 重试即可。".into(),
            ],
            (Lang::En, P::HostKeyUnknown) => vec![
                format!("Confirm the fingerprint once, interactively (pressing a in the TUI is the same): `faragent login --host {host}`."),
                format!("Or by hand: `ssh{port} {host} true` and answer yes after checking the fingerprint."),
                format!("To write it non-interactively (verify the fingerprint through a trusted channel first): `ssh-keyscan -t ed25519{port} {target} >> ~/.ssh/known_hosts`."),
                "Then retry in FarAgent.".into(),
            ],
            (Lang::Zh, P::HostKeyChanged) => vec![
                "先判断原因：这台机器最近重装过系统、重建过云主机吗？说不清就先别继续。".into(),
                "在远程核对现在的指纹：`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`。".into(),
                format!("确认无误后删掉本机旧记录：`ssh-keygen -R {kh}`。"),
                format!("再连一次确认新指纹：`faragent login --host {host}`。"),
                "指纹变化来路不明时先查网络（DNS / 代理 / 跳板机），不要直接接受。".into(),
            ],
            (Lang::En, P::HostKeyChanged) => vec![
                "First work out why: was the machine rebuilt or reinstalled recently? If not, stop here.".into(),
                "On the remote, print the current fingerprint: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.".into(),
                format!("If it matches what you expect, drop the stale entry here: `ssh-keygen -R {kh}`."),
                format!("Connect once to confirm the new key: `faragent login --host {host}`."),
                "If the change is unexplained, check the network path (DNS / proxy / bastion) instead of accepting it.".into(),
            ],
            (Lang::Zh, P::PrivateFilePermissions)
                if f.local == crate::remote::HostOs::Windows =>
            {
                vec![
                    "Windows 的 OpenSSH 检查的是 ACL（不是 Unix 权限位）：先看 `icacls $env:USERPROFILE\\.ssh`。".into(),
                    "收窄到仅当前用户（管理员 PowerShell）：`icacls $env:USERPROFILE\\.ssh /inheritance:r`，再 `icacls $env:USERPROFILE\\.ssh /grant:r \"$env:USERNAME:(OI)(CI)F\"`。".into(),
                    "确认属主：`Get-Acl $env:USERPROFILE\\.ssh\\id_ed25519 | Format-List Owner`，应为当前用户，而不是 Administrators / SYSTEM。".into(),
                    format!("再试一次：`ssh -o BatchMode=yes{port} {host} echo ok`。"),
                ]
            }
            (Lang::En, P::PrivateFilePermissions)
                if f.local == crate::remote::HostOs::Windows =>
            {
                vec![
                    "Windows OpenSSH checks ACLs (not Unix mode bits): start with `icacls $env:USERPROFILE\\.ssh`.".into(),
                    "Narrow it to your user only (admin PowerShell): `icacls $env:USERPROFILE\\.ssh /inheritance:r`, then `icacls $env:USERPROFILE\\.ssh /grant:r \"$env:USERNAME:(OI)(CI)F\"`.".into(),
                    "Check the owner: `Get-Acl $env:USERPROFILE\\.ssh\\id_ed25519 | Format-List Owner` should be your user, not Administrators / SYSTEM.".into(),
                    format!("Retry: `ssh -o BatchMode=yes{port} {host} echo ok`."),
                ]
            }
            (Lang::Zh, P::PrivateFilePermissions) => vec![
                "`chmod 700 ~/.ssh`".into(),
                "`chmod 600 ~/.ssh/config ~/.ssh/id_ed25519 ~/.ssh/known_hosts`（换成你实际用到的文件名）".into(),
                "`chmod 644 ~/.ssh/id_ed25519.pub`".into(),
                "属主必须是当前用户：`ls -l ~/.ssh`，必要时 `sudo chown $(whoami) ~/.ssh/*`。".into(),
                format!("再试一次：`ssh -o BatchMode=yes{port} {host} true`。"),
            ],
            (Lang::En, P::PrivateFilePermissions) => vec![
                "`chmod 700 ~/.ssh`".into(),
                "`chmod 600 ~/.ssh/config ~/.ssh/id_ed25519 ~/.ssh/known_hosts` (use your real filenames)".into(),
                "`chmod 644 ~/.ssh/id_ed25519.pub`".into(),
                "Ownership must be your user: `ls -l ~/.ssh`, then `sudo chown $(whoami) ~/.ssh/*` if needed.".into(),
                format!("Retry: `ssh -o BatchMode=yes{port} {host} true`."),
            ],
            (Lang::Zh, P::KeyUnreadable) => vec![
                "看文件开头：`head -1 ~/.ssh/id_ed25519`，应该是 `-----BEGIN OPENSSH PRIVATE KEY-----`。".into(),
                "`IdentityFile` 只能指向私钥，不要写成 `.pub`。".into(),
                "文件确实是坏的或不是私钥：重新生成 `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`。".into(),
                format!("重新上传公钥：`ssh-copy-id{port} -i ~/.ssh/id_ed25519.pub {host}`。"),
            ],
            (Lang::En, P::KeyUnreadable) => vec![
                "Look at the header: `head -1 ~/.ssh/id_ed25519` should say `-----BEGIN OPENSSH PRIVATE KEY-----`.".into(),
                "`IdentityFile` must point at the private key, never a `.pub`.".into(),
                "If the file really is broken or not a key, regenerate: `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`.".into(),
                format!("Re-upload the public key: `ssh-copy-id{port} -i ~/.ssh/id_ed25519.pub {host}`."),
            ],
            (Lang::Zh, P::KeyMissing) => vec![
                "看现在的配置：`grep -n -i identityfile ~/.ssh/config`。".into(),
                "确认路径真实存在：`ls -l ~/.ssh`（`~` 只在 ssh 配置里会被展开）。".into(),
                "确实缺这把钥匙就生成：`ssh-keygen -t ed25519 -f {key}`。".into(),
                "或把 `IdentityFile` 改成你本机已有的私钥，然后重试。".into(),
            ],
            (Lang::En, P::KeyMissing) => vec![
                "Inspect the config: `grep -n -i identityfile ~/.ssh/config`.".into(),
                "Check the path really exists: `ls -l ~/.ssh` (only ssh config expands `~`).".into(),
                "Generate the missing key: `ssh-keygen -t ed25519 -f {key}`.".into(),
                "Or point `IdentityFile` at a key you already have, then retry.".into(),
            ],
            (Lang::Zh, P::KeyPassphrase) => vec![
                "放进 agent（macOS 可存钥匙串）：`ssh-add --apple-use-keychain ~/.ssh/id_ed25519`；Linux：`ssh-add ~/.ssh/id_ed25519`。".into(),
                "确认已加载：`ssh-add -l`。".into(),
                "macOS 想持久化：在 ~/.ssh/config 顶部加 `AddKeysToAgent yes` 与 `UseKeychain yes`。".into(),
                "不想每次输入口令：为这台机器单独生成一把无口令密钥。".into(),
            ],
            (Lang::En, P::KeyPassphrase) => vec![
                "Add it to the agent (macOS can use the keychain): `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`; Linux: `ssh-add ~/.ssh/id_ed25519`.".into(),
                "Confirm it loaded: `ssh-add -l`.".into(),
                "On macOS, make it stick: add `AddKeysToAgent yes` and `UseKeychain yes` at the top of ~/.ssh/config.".into(),
                "Or make a passphrase-free key used only for this machine.".into(),
            ],
            (Lang::Zh, P::DnsFailure) => vec![
                format!("看配置里现在写了什么：`grep -n -A3 -i 'host {host}' ~/.ssh/config`。"),
                format!("单独试解析：`dig +short {target}`（或 `nslookup {target}`）。"),
                "Tailscale / VPN / 公司内网名字必须先连上那张网：`tailscale status`。".into(),
                "临时办法：把可达的 IP 直接写进 `HostName`。".into(),
            ],
            (Lang::En, P::DnsFailure) => vec![
                format!("See what the config says now: `grep -n -A3 -i 'host {host}' ~/.ssh/config`."),
                format!("Resolve it on its own: `dig +short {target}` (or `nslookup {target}`)."),
                "Tailscale / VPN / internal names need that network first: `tailscale status`.".into(),
                "Workaround: put a reachable IP straight into `HostName`.".into(),
            ],
            (Lang::Zh, P::ConnectionRefused) => vec![
                format!("确认端口：`grep -n -A3 -i 'host {host}' ~/.ssh/config`（默认 22，改过就要写 `Port`）。"),
                format!("从本机探端口：`nc -vz {target} {port_n}`。"),
                "远程确认服务在跑：Linux `sudo systemctl status ssh`；macOS「系统设置 → 通用 → 共享 → 远程登录」。".into(),
                format!("云安全组 / 本机防火墙要放行 TCP {port_n}。"),
            ],
            (Lang::En, P::ConnectionRefused) => vec![
                format!("Check the port: `grep -n -A3 -i 'host {host}' ~/.ssh/config` (default 22; a custom port needs `Port`)."),
                format!("Probe the port from here: `nc -vz {target} {port_n}`."),
                "Confirm the service runs on the remote: Linux `sudo systemctl status ssh`; macOS System Settings -> General -> Sharing -> Remote Login.".into(),
                format!("Allow TCP {port_n} in the cloud security group / local firewall."),
            ],
            (Lang::Zh, P::ConnectionTimeout) => vec![
                format!("先看能不能到：`ping -c 2 {target}` 与 `nc -vz {target} {port_n}`。"),
                "局域网地址出了那张网就不通：出门要改用 Tailscale 或公网 IP / 域名。".into(),
                format!("云安全组 / 路由器端口转发是否放行 {port_n}（家宽在 NAT / CGNAT 后面时端口转发无效）。"),
                format!("端口能通但一直卡住，多半是远程登录壳里有等待输入的命令：`ssh{port} {host} -- bash -lc 'echo ok'`，检查 ~/.bashrc 与 ~/.bash_profile。"),
                format!("手工复现看细节：`ssh -v{port} {host} true`。"),
            ],
            (Lang::En, P::ConnectionTimeout) => vec![
                format!("See whether the host answers at all: `ping -c 2 {target}` and `nc -vz {target} {port_n}`."),
                "A LAN address stops working off that network: use Tailscale or a public IP / domain instead.".into(),
                format!("Allow {port_n} in the cloud security group / router port forwarding (forwarding does nothing behind NAT or CGNAT)."),
                format!("If the port answers but ssh hangs, the remote login shell is probably waiting for input: `ssh{port} {host} -- bash -lc 'echo ok'`, then check ~/.bashrc and ~/.bash_profile."),
                format!("Reproduce with detail: `ssh -v{port} {host} true`."),
            ],
            (Lang::Zh, P::NoRoute) => vec![
                format!("`ping -c 2 {target}`"),
                "确认你在对的网里：局域网地址只在家里 / 办公室那张网有效。".into(),
                "用 Tailscale / VPN 时先看状态：`tailscale status`。".into(),
                "换个入口：改用公网 IP / 域名，或把 `HostName` 换成可达地址。".into(),
            ],
            (Lang::En, P::NoRoute) => vec![
                format!("`ping -c 2 {target}`"),
                "Confirm you are on the right network: a LAN address only works on that LAN.".into(),
                "With Tailscale / VPN, check state first: `tailscale status`.".into(),
                "Try another path: a public IP / domain, or set `HostName` to a reachable address.".into(),
            ],
            (Lang::Zh, P::KexClosed) => vec![
                "刚连续失败过很多次？等几分钟再试（fail2ban 类封禁会自己解封）。".into(),
                "远程确认 sshd 真的在跑：`sudo systemctl status ssh` 或 `sudo /usr/sbin/sshd -T | head`。".into(),
                "云厂商安全组、TCP wrapper（/etc/hosts.allow、/etc/hosts.deny）是否拦了本机 IP。".into(),
                format!("看完整握手过程：`ssh -vvv{port} {host} true`。"),
            ],
            (Lang::En, P::KexClosed) => vec![
                "Many failures in a row just now? Wait a few minutes (fail2ban-style bans expire).".into(),
                "Confirm sshd really runs: `sudo systemctl status ssh` or `sudo /usr/sbin/sshd -T | head`.".into(),
                "Check cloud security groups and TCP wrappers (/etc/hosts.allow, /etc/hosts.deny) for your IP.".into(),
                format!("Watch the full handshake: `ssh -vvv{port} {host} true`."),
            ],
            (Lang::Zh, P::VersionMismatch) => vec![
                format!("看服务端到底提供什么：`ssh -v{port} {host} true`，注意 `Their offer:` 那一行。"),
                format!("临时放开一次：`ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa{port} {host} true`。"),
                format!("能用就把同样的选项写进 ~/.ssh/config 的 `Host {host}` 段，FarAgent 会自动沿用。"),
                "根治办法是升级远程的 OpenSSH。".into(),
            ],
            (Lang::En, P::VersionMismatch) => vec![
                format!("See what the server offers: `ssh -v{port} {host} true`, look at the `Their offer:` line."),
                format!("Loosen it once: `ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa{port} {host} true`."),
                format!("If that works, put the same options under `Host {host}` in ~/.ssh/config and FarAgent will pick them up."),
                "The real fix is upgrading OpenSSH on the remote.".into(),
            ],
            (Lang::Zh, P::RemoteBash) => vec![
                format!("确认远程有 bash：`ssh{port} {host} -- bash -lc 'echo ok'`。"),
                "确认登录壳不卡：~/.bashrc、~/.bash_profile 里不要有等待输入的命令（read、ssh-add、sudo 等）。".into(),
                "远程只有 sh / zsh 时先装 bash：Debian / Ubuntu `sudo apt-get install -y bash`；Fedora `sudo dnf install -y bash`。".into(),
                format!("看登录壳细节：`ssh{port} {host} -- bash -lc 'echo $SHELL; command -v bash; echo $PATH'`。"),
            ],
            (Lang::En, P::RemoteBash) => vec![
                format!("Confirm bash exists remotely: `ssh{port} {host} -- bash -lc 'echo ok'`."),
                "Make sure the login shell does not block: no commands that wait for input in ~/.bashrc or ~/.bash_profile (read, ssh-add, sudo, ...).".into(),
                "If only sh / zsh exists, install bash: Debian / Ubuntu `sudo apt-get install -y bash`; Fedora `sudo dnf install -y bash`.".into(),
                format!("Inspect the login shell: `ssh{port} {host} -- bash -lc 'echo $SHELL; command -v bash; echo $PATH'`."),
            ],
            (Lang::Zh, P::RemoteShellUnsupported) => vec![
                format!("先看原样输出：`ssh{port} {host} echo FARAGENT_OS_V1`。"),
                "Windows 远端：sshd 的默认 shell 必须可用（默认是 cmd.exe；改坏过就改回来：`New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value 'C:\\Windows\\System32\\cmd.exe' -PropertyType String -Force`，然后 `Restart-Service sshd`）。".into(),
                "Linux/macOS 远端：登录 shell 必须存在且可执行（`echo $SHELL`；不对就 `chsh -s /bin/bash <user>`），/etc/passwd 里的 shell 也不能指向已删除的程序。".into(),
                format!("确认最基本的命令能跑通：`ssh{port} {host} echo ok`。"),
            ],
            (Lang::En, P::RemoteShellUnsupported) => vec![
                format!("See the raw output first: `ssh{port} {host} echo FARAGENT_OS_V1`."),
                "Windows remote: sshd's default shell must work (cmd.exe by default; if it broke, restore it: `New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value 'C:\\Windows\\System32\\cmd.exe' -PropertyType String -Force`, then `Restart-Service sshd`).".into(),
                "Linux/macOS remote: the login shell must exist and be executable (`echo $SHELL`; fix with `chsh -s /bin/bash <user>`), and /etc/passwd must not point at a deleted program.".into(),
                format!("Confirm the most basic command runs: `ssh{port} {host} echo ok`."),
            ],
            (Lang::Zh, P::Unknown) => vec![
                format!("详细模式复现：`ssh -vvv{port} {host} true`。"),
                format!("`faragent doctor --host {host}` 会一起打印本机 ssh、主机列表和远程探测结果。"),
                "把原始输出贴到 https://github.com/mahingbun-dev/FarAgent/issues。".into(),
                "通用排查步骤见文档 docs/zh/ssh-access.md。".into(),
            ],
            (Lang::En, P::Unknown) => vec![
                format!("Reproduce with detail: `ssh -vvv{port} {host} true`."),
                format!("`faragent doctor --host {host}` prints the local ssh, the host list and the remote probe together."),
                "Paste the raw output into https://github.com/mahingbun-dev/FarAgent/issues.".into(),
                "General walkthrough: docs/en/ssh-access.md.".into(),
            ],
        };
    steps
}

/// Ordered, specific-before-generic matching over OpenSSH's own wording.
pub fn classify(raw: &str) -> Problem {
    let r = raw.to_ascii_lowercase();
    let has = |needle: &str| r.contains(needle);

    if has("could not run the local openssh client") || has("failed to spawn ssh") {
        return Problem::SshMissing;
    }
    if has("remote host identification has changed") || has("host key has changed") {
        return Problem::HostKeyChanged;
    }
    if has("no matching key exchange method")
        || has("no matching host key type")
        || has("no matching cipher")
        || has("no matching mac")
        || has("no matching signature algorithm")
        || has("their offer:")
    {
        return Problem::VersionMismatch;
    }
    if has("host key verification failed") || has("no rsa host key") || has("no ed25519 host key") {
        return Problem::HostKeyUnknown;
    }
    if has("unprotected private key file")
        || has("bad permissions")
        || has("bad owner or permissions")
        || has("permissions 0")
    {
        return Problem::PrivateFilePermissions;
    }
    if has("enter passphrase") || has("incorrect passphrase") {
        return Problem::KeyPassphrase;
    }
    if has("invalid format") || has("error in libcrypto") || has("not a private key") {
        return Problem::KeyUnreadable;
    }
    if has("not accessible")
        || has("no such identity")
        || (has("identity file") && has("no such file"))
    {
        return Problem::KeyMissing;
    }
    if has("too many authentication failures") {
        return Problem::TooManyAuthFailures;
    }
    if has("kex_exchange_identification")
        || has("connection closed by")
        || has("connection reset by peer")
        || has("packet_write_wait")
    {
        return Problem::KexClosed;
    }
    if has("timed out") || has("timeout") || has("operation would block") {
        return Problem::ConnectionTimeout;
    }
    if has("connection refused") || (has("connect to host") && has("refused")) {
        return Problem::ConnectionRefused;
    }
    if has("no route to host")
        || has("network is unreachable")
        || has("host is down")
        || has("destination unreachable")
    {
        return Problem::NoRoute;
    }
    if has("could not resolve hostname")
        || has("name or service not known")
        || has("nodename nor servname")
        || has("temporary failure in name resolution")
    {
        return Problem::DnsFailure;
    }
    if has("faragent_probe_v1")
        || has("faragent_list_v1")
        || has("faragent_start_v1")
        || has("faragent_preflight_v1")
        || has("bash:")
        || has("bash: command not found")
    {
        return Problem::RemoteBash;
    }
    // The remote's default shell could not run our command line at all:
    // cmd/powershell "not recognized" wording, or sshd refusing to start a
    // broken login shell. Chinese Windows consoles phrase these differently.
    if has("shell request failed on channel 0")
        || has("is not recognized as an internal or external command")
        || has("not recognized as the name of a cmdlet")
        || has("不是内部或外部命令")
        || (has("无法将") && has("cmdlet"))
    {
        return Problem::RemoteShellUnsupported;
    }
    if has("authentication failed") {
        return Problem::PasswordDenied;
    }
    if has("permission denied") {
        if has("password") || has("keyboard-interactive") {
            return Problem::NeedsPassword;
        }
        return Problem::PublickeyDenied;
    }
    Problem::Unknown
}

/// Structured report for CLI callers (`doctor`, `probe`, `login`, `sessions`).
pub fn render_error(err: &anyhow::Error, host: &str, lang: Lang) -> String {
    match err.downcast_ref::<TransportError>() {
        Some(se) => Diagnosis::of(se).plain(lang),
        None => Diagnosis::of_message(host, &format!("{err:#}")).plain(lang),
    }
}

/// What the TUI shows: `None` means "not a connection problem, keep the short
/// footer line" (missing tmux, missing cwd, install-plan failures, ...).
/// The returned report carries both languages; the UI picks at render time.
pub fn diagnosis_of(err: &anyhow::Error, host: &str) -> Option<Diagnosis> {
    if let Some(se) = err.downcast_ref::<TransportError>() {
        return Some(Diagnosis::of(se));
    }
    let text = format!("{err:#}");
    match classify(&text) {
        // For text that never came from OpenSSH, only these are
        // unambiguous. Anything else (say `mkdir: ...: Permission denied` from
        // the remote start script) must not be dressed up as a credential
        // problem; the short footer line is the honest answer.
        Problem::RemoteBash | Problem::RemoteShellUnsupported | Problem::SshMissing => {
            Some(Diagnosis::of_message(host, &text))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn p(raw: &str) -> Problem {
        classify(raw)
    }

    #[test]
    fn classifies_windows_shell_errors() {
        assert_eq!(
            p("'bash' is not recognized as an internal or external command,\r\noperable program or batch file."),
            Problem::RemoteShellUnsupported
        );
        assert_eq!(
            p("bash : 无法将“bash”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。"),
            Problem::RemoteShellUnsupported
        );
        assert_eq!(
            p("'bash' 不是内部或外部命令，也不是可运行的程序或批处理文件。"),
            Problem::RemoteShellUnsupported
        );
        assert_eq!(
            p("powershell is not recognized as the name of a cmdlet"),
            Problem::RemoteShellUnsupported
        );
        assert_eq!(
            p("shell request failed on channel 0"),
            Problem::RemoteShellUnsupported
        );
    }

    #[test]
    fn windows_local_advice_mentions_windows_tools() {
        let facts = Facts {
            host: "devbox".into(),
            target: "10.0.0.2".into(),
            port: 22,
            methods: String::new(),
            mode: AuthMode::Auto,
            identity: None,
            local: HostOs::Windows,
        };
        let ssh_missing = steps(Problem::SshMissing, &facts).zh.join("\n");
        assert!(
            ssh_missing.contains("Add-WindowsCapability"),
            "{ssh_missing}"
        );
        assert!(
            !ssh_missing.contains("brew"),
            "no macOS advice: {ssh_missing}"
        );

        let perms = steps(Problem::PrivateFilePermissions, &facts).en.join("\n");
        assert!(perms.contains("icacls"), "{perms}");
        assert!(
            !perms.contains("chmod"),
            "no chmod advice on Windows: {perms}"
        );

        let password = steps(Problem::NeedsPassword, &facts).en.join("\n");
        assert!(password.contains("SSH_ASKPASS"), "{password}");

        // POSIX clients keep the POSIX wording.
        let posix = Facts {
            local: HostOs::Posix,
            ..facts.clone()
        };
        let posix_steps = steps(Problem::PrivateFilePermissions, &posix).zh.join("\n");
        assert!(posix_steps.contains("chmod"), "{posix_steps}");
        assert!(!posix_steps.contains("icacls"), "{posix_steps}");
    }

    #[test]
    fn classifies_real_openssh_output() {
        assert_eq!(
            p("you@devbox: Permission denied (publickey)."),
            Problem::PublickeyDenied
        );
        assert_eq!(
            p("you@devbox: Permission denied (publickey,password)."),
            Problem::NeedsPassword
        );
        assert_eq!(
            p("Permission denied (keyboard-interactive)."),
            Problem::NeedsPassword
        );
        assert_eq!(
            p("Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures"),
            Problem::TooManyAuthFailures
        );
        assert_eq!(p("Host key verification failed."), Problem::HostKeyUnknown);
        assert_eq!(
            p("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed."),
            Problem::HostKeyChanged
        );
        assert_eq!(
            p("ssh: connect to host 10.0.0.9 port 22: Connection refused"),
            Problem::ConnectionRefused
        );
        assert_eq!(
            p("ssh: connect to host box port 22: Operation timed out"),
            Problem::ConnectionTimeout
        );
        assert_eq!(
            p("SSH timed out after 25s: no answer from the host, or the remote login shell hung."),
            Problem::ConnectionTimeout
        );
        assert_eq!(
            p("ssh: Could not resolve hostname home-mac: nodename nor servname provided"),
            Problem::DnsFailure
        );
        assert_eq!(
            p("kex_exchange_identification: Connection closed by remote host"),
            Problem::KexClosed
        );
        assert_eq!(
            p("Unable to negotiate with 1.2.3.4 port 22: no matching key exchange method found. Their offer: diffie-hellman-group14-sha1"),
            Problem::VersionMismatch
        );
        assert_eq!(
            p("@@@@ WARNING: UNPROTECTED PRIVATE KEY FILE! @@@@\nPermissions 0644 for '/Users/a/.ssh/id_ed25519' are too open."),
            Problem::PrivateFilePermissions
        );
        assert_eq!(
            p("Enter passphrase for key '/Users/a/.ssh/id_rsa':"),
            Problem::KeyPassphrase
        );
        assert_eq!(
            p("Warning: Identity file /Users/a/.ssh/nope not accessible: No such file or directory."),
            Problem::KeyMissing
        );
        assert_eq!(
            p("Load key \"/x/id_rsa\": invalid format"),
            Problem::KeyUnreadable
        );
        assert_eq!(
            p("could not run the local OpenSSH client: No such file or directory (os error 2)"),
            Problem::SshMissing
        );
        assert_eq!(
            p("remote output missing FARAGENT_PROBE_V1: bash: line 1: foo"),
            Problem::RemoteBash
        );
        assert_eq!(p("something nobody predicted"), Problem::Unknown);
    }

    #[test]
    fn every_problem_has_a_summary_and_steps_in_both_languages() {
        let facts = Facts {
            host: "devbox".into(),
            target: "10.0.0.2".into(),
            port: 2222,
            methods: "publickey,password".into(),
            mode: AuthMode::Auto,
            identity: Some("/Users/a/.ssh/id_ed25519".into()),
            local: HostOs::Posix,
        };
        for lang in Lang::ALL {
            for problem in Problem::ALL {
                let text = summary(problem).pick(lang);
                assert!(!text.trim().is_empty(), "{} summary", problem.slug());
                let fixes = steps(problem, &facts).pick(lang);
                assert!(
                    fixes.len() >= 3,
                    "{} has only {} steps",
                    problem.slug(),
                    fixes.len()
                );
                for step in &fixes {
                    assert!(!step.trim().is_empty(), "{} empty step", problem.slug());
                    assert!(
                        !step.contains("{host}") && !step.contains("{}"),
                        "{} left a placeholder: {step}",
                        problem.slug()
                    );
                }
            }
        }
    }

    #[test]
    fn steps_use_the_real_host_and_port() {
        let facts = Facts {
            host: "devbox".into(),
            target: "10.0.0.2".into(),
            port: 2222,
            methods: String::new(),
            mode: AuthMode::Auto,
            identity: None,
            local: HostOs::Posix,
        };
        let zh_steps = steps(Problem::HostKeyChanged, &facts).zh;
        let joined = zh_steps.join("\n");
        assert!(joined.contains("10.0.0.2"), "{joined}");
        assert!(joined.contains("[10.0.0.2]:2222"), "{joined}");
        let en_steps22 = steps(
            Problem::HostKeyChanged,
            &Facts {
                port: 22,
                ..facts.clone()
            },
        )
        .en;
        let joined22 = en_steps22.join("\n");
        assert!(joined22.contains("-R 10.0.0.2"), "{joined22}");
        assert!(!joined22.contains("]:22"), "{joined22}");
    }

    #[test]
    fn remote_script_errors_are_not_dressed_up_as_ssh_problems() {
        // `mkdir` failing on the remote mentions "Permission denied", which
        // must not be reported as "the server refused your key".
        let mkdir = anyhow::anyhow!("mkdir_failed: mkdir: /srv/app: Permission denied");
        assert!(diagnosis_of(&mkdir, "home-mac").is_none());
        let cwd = anyhow::anyhow!("cwd_missing: Not a directory.");
        assert!(diagnosis_of(&cwd, "home-mac").is_none());
        let tmux = anyhow::anyhow!("tmux_missing: tmux is not on PATH; install it from FarAgent.");
        assert!(diagnosis_of(&tmux, "home-mac").is_none());
        // A real probe failure still gets the full report.
        let probe =
            anyhow::anyhow!("remote output missing FARAGENT_PROBE_V1: bash: foo: not found");
        let d = diagnosis_of(&probe, "home-mac").unwrap();
        assert_eq!(d.problem, Problem::RemoteBash);
    }

    #[test]
    fn password_host_steps_do_not_tell_you_to_switch_again() {
        let auto = Facts {
            host: "devbox".into(),
            target: "10.0.0.2".into(),
            port: 22,
            methods: "publickey,password".into(),
            mode: AuthMode::Auto,
            identity: None,
            local: HostOs::Posix,
        };
        let pw = Facts {
            mode: AuthMode::Password,
            ..auto.clone()
        };
        let auto_steps = steps(Problem::NeedsPassword, &auto).zh.join("\n");
        let pw_steps = steps(Problem::NeedsPassword, &pw).zh.join("\n");
        assert!(auto_steps.contains("auth --host devbox --mode password"));
        assert!(!pw_steps.contains("auth --host devbox --mode password"));
        assert!(pw_steps.contains("已经是密码模式"));

        let pw_en = steps(Problem::NeedsPassword, &pw).en.join("\n");
        assert!(!pw_en.contains("Switch this host to password mode"));
        assert!(pw_en.contains("already in password mode"));
    }

    #[test]
    fn diagnosis_keeps_raw_output_and_renders_plain_text() {
        let err = TransportError {
            host: "devbox".into(),
            mode: AuthMode::Auto,
            command: "ssh -o BatchMode=yes devbox -- true".into(),
            raw: "you@devbox: Permission denied (publickey,password).\n".into(),
            status: Some(255),
            timed_out: false,
            needs_auth: true,
            methods: "publickey,password".into(),
        };
        let d = Diagnosis::of(&err);
        assert_eq!(d.problem, Problem::NeedsPassword);
        assert!(d.needs_auth);
        let text = d.plain(Lang::Zh);
        assert!(text.contains("Permission denied (publickey,password)."));
        assert!(text.contains("devbox"));
        assert!(text.contains("ssh-access.md"));
        let text_en = d.plain(Lang::En);
        assert!(text_en.contains("Permission denied (publickey,password)."));
    }
}

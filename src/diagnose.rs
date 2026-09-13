//! Turn a raw OpenSSH failure into something the user can act on.
//!
//! FarAgent never re-implements SSH, so OpenSSH's own output is the ground
//! truth. We keep it verbatim, then name the likely cause and the exact
//! commands that fix it — instead of making the user go read a wiki first.

use crate::i18n::Lang;
use crate::ssh::{self, AuthMode, SshError};

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
    /// Unclassified: raw output is still shown.
    Unknown,
}

impl Problem {
    /// Used by the tests to prove every variant has wording in both languages.
    #[allow(dead_code)]
    pub const ALL: [Problem; 19] = [
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
}

impl Facts {
    pub fn for_host(host: &str) -> Self {
        let found = ssh::list_hosts()
            .ok()
            .and_then(|hosts| hosts.into_iter().find(|h| h.alias == host));
        match found {
            Some(h) => Facts {
                host: h.alias.clone(),
                target: h.target().to_string(),
                port: h.port_or_22(),
                identity: h.identity.clone(),
                methods: String::new(),
                mode: AuthMode::default(),
            },
            None => Facts {
                host: host.to_string(),
                target: host.to_string(),
                port: 22,
                identity: None,
                methods: String::new(),
                mode: AuthMode::default(),
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
#[derive(Debug, Clone)]
pub struct Diagnosis {
    pub problem: Problem,
    pub facts: Facts,
    pub summary: String,
    pub steps: Vec<String>,
    pub raw: String,
    pub command: String,
    pub needs_auth: bool,
    pub timed_out: bool,
}

impl Diagnosis {
    pub fn of(err: &SshError, lang: Lang) -> Self {
        let facts = Facts::for_host(&err.host).with(err.methods.clone(), err.mode);
        Self::build(
            &err.raw,
            facts,
            err.raw.clone(),
            err.command.clone(),
            lang,
            err.needs_auth,
            err.timed_out,
        )
    }

    /// For failures that never reached OpenSSH (probe parsing, our own timeout
    /// wording, install errors): classify the message we do have.
    pub fn of_message(host: &str, message: &str, lang: Lang) -> Self {
        let facts = Facts::for_host(host);
        Self::build(
            message,
            facts,
            message.to_string(),
            String::new(),
            lang,
            false,
            false,
        )
    }

    fn build(
        text: &str,
        facts: Facts,
        raw_full: String,
        command: String,
        lang: Lang,
        needs_auth: bool,
        timed_out: bool,
    ) -> Self {
        let problem = classify(text);
        Self {
            problem,
            summary: lang.problem_summary(problem).to_string(),
            steps: lang.problem_steps(problem, &facts),
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
            lang.problem_label(),
            self.facts.host,
            self.summary
        ));
        if !self.command.is_empty() {
            out.push_str(&format!("{}: {}\n", lang.problem_command(), self.command));
        }
        let raw = self.raw.trim();
        if !raw.is_empty() {
            out.push_str(&format!("{}:\n", lang.problem_raw()));
            for line in raw.lines() {
                out.push_str("  ");
                out.push_str(line);
                out.push('\n');
            }
        }
        out.push_str(&format!("{}:\n", lang.problem_fixes()));
        for (i, step) in self.steps.iter().enumerate() {
            out.push_str(&format!("  {}. {}\n", i + 1, step));
        }
        out.push_str(&format!("{}: {}\n", lang.problem_docs(), lang.ssh_doc()));
        out
    }

    /// Re-label the report. Used after an interactive login that the user just
    /// attempted: the raw text is a generic `Permission denied (...)`, but the
    /// useful advice is "that password did not work", not "use password mode".
    pub fn relabel(mut self, problem: Problem, lang: Lang) -> Self {
        self.problem = problem;
        self.summary = lang.problem_summary(problem).to_string();
        self.steps = lang.problem_steps(problem, &self.facts);
        self
    }
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
    match err.downcast_ref::<SshError>() {
        Some(se) => Diagnosis::of(se, lang).plain(lang),
        None => Diagnosis::of_message(host, &format!("{err:#}"), lang).plain(lang),
    }
}

/// What the TUI shows: `None` means "not a connection problem, keep the short
/// footer line" (missing tmux, missing cwd, install-plan failures, ...).
pub fn diagnosis_of(err: &anyhow::Error, host: &str, lang: Lang) -> Option<Diagnosis> {
    if let Some(se) = err.downcast_ref::<SshError>() {
        return Some(Diagnosis::of(se, lang));
    }
    let text = format!("{err:#}");
    match classify(&text) {
        // For text that never came from OpenSSH, only these two are
        // unambiguous. Anything else (say `mkdir: ...: Permission denied` from
        // the remote start script) must not be dressed up as a credential
        // problem; the short footer line is the honest answer.
        Problem::RemoteBash | Problem::SshMissing => Some(Diagnosis::of_message(host, &text, lang)),
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
        };
        for lang in Lang::ALL {
            for problem in Problem::ALL {
                let summary = lang.problem_summary(problem);
                assert!(!summary.trim().is_empty(), "{} summary", problem.slug());
                let steps = lang.problem_steps(problem, &facts);
                assert!(
                    steps.len() >= 3,
                    "{} has only {} steps",
                    problem.slug(),
                    steps.len()
                );
                for step in &steps {
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
        };
        let steps = Lang::Zh.problem_steps(Problem::HostKeyChanged, &facts);
        let joined = steps.join("\n");
        assert!(joined.contains("10.0.0.2"), "{joined}");
        assert!(joined.contains("[10.0.0.2]:2222"), "{joined}");
        let steps22 = Lang::En.problem_steps(
            Problem::HostKeyChanged,
            &Facts {
                port: 22,
                ..facts.clone()
            },
        );
        let joined22 = steps22.join("\n");
        assert!(joined22.contains("-R 10.0.0.2"), "{joined22}");
        assert!(!joined22.contains("]:22"), "{joined22}");
    }

    #[test]
    fn remote_script_errors_are_not_dressed_up_as_ssh_problems() {
        // `mkdir` failing on the remote mentions "Permission denied", which
        // must not be reported as "the server refused your key".
        let mkdir = anyhow::anyhow!("mkdir_failed: mkdir: /srv/app: Permission denied");
        assert!(diagnosis_of(&mkdir, "home-mac", Lang::Zh).is_none());
        let cwd = anyhow::anyhow!("cwd_missing: Not a directory.");
        assert!(diagnosis_of(&cwd, "home-mac", Lang::Zh).is_none());
        let tmux = anyhow::anyhow!("tmux_missing: tmux is not on PATH; install it from FarAgent.");
        assert!(diagnosis_of(&tmux, "home-mac", Lang::Zh).is_none());
        // A real probe failure still gets the full report.
        let probe =
            anyhow::anyhow!("remote output missing FARAGENT_PROBE_V1: bash: foo: not found");
        let d = diagnosis_of(&probe, "home-mac", Lang::Zh).unwrap();
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
        };
        let pw = Facts {
            mode: AuthMode::Password,
            ..auto.clone()
        };
        let auto_steps = Lang::Zh
            .problem_steps(Problem::NeedsPassword, &auto)
            .join("\n");
        let pw_steps = Lang::Zh
            .problem_steps(Problem::NeedsPassword, &pw)
            .join("\n");
        assert!(auto_steps.contains("auth --host devbox --mode password"));
        assert!(!pw_steps.contains("auth --host devbox --mode password"));
        assert!(pw_steps.contains("已经是密码模式"));

        let pw_en = Lang::En
            .problem_steps(Problem::NeedsPassword, &pw)
            .join("\n");
        assert!(!pw_en.contains("Switch this host to password mode"));
        assert!(pw_en.contains("already in password mode"));
    }

    #[test]
    fn diagnosis_keeps_raw_output_and_renders_plain_text() {
        let err = SshError {
            host: "devbox".into(),
            mode: AuthMode::Auto,
            command: "ssh -o BatchMode=yes devbox -- true".into(),
            raw: "you@devbox: Permission denied (publickey,password).\n".into(),
            status: Some(255),
            timed_out: false,
            needs_auth: true,
            methods: "publickey,password".into(),
        };
        let d = Diagnosis::of(&err, Lang::Zh);
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

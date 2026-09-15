use anyhow::Result;
use faragent_core::agents::AgentKind;
use faragent_core::config;
use faragent_core::text::{Lang, LocalizedText};
use faragent_core::vocab::HostOs;
use faragent_remote::{remote, win};
use faragent_transport::{host_os, run_login, run_win_login, OpenSshTransport, TransportError};

pub use faragent_remote::remote::Probe;

pub fn probe_host(host: &str) -> Result<Probe> {
    let client = OpenSshTransport::connect(host)?;
    let expected = host_os(host).unwrap_or_default();
    let probe = match try_probe(&client, expected) {
        Ok(p) => p,
        Err(e) => {
            // A hung SSH will not succeed on the other dialect either; retrying
            // just doubles the 25s wait. Fast failures (wrong shell, parse)
            // still try once more — the cached OS may be stale.
            if !should_retry_other_os(&e) {
                return Err(e);
            }
            let other = match expected {
                HostOs::Posix => HostOs::Windows,
                HostOs::Windows => HostOs::Posix,
            };
            match try_probe(&client, other) {
                Ok(p) => p,
                Err(_) => return Err(e),
            }
        }
    };
    // Trust the probe script's own `os` line over any cache.
    if probe.os != expected {
        let _ = config::set_host_os(host, probe.os);
    }
    Ok(probe)
}

fn try_probe(client: &OpenSshTransport, os: HostOs) -> Result<Probe> {
    let text = match os {
        HostOs::Posix => run_login(client, remote::probe_script())?,
        HostOs::Windows => run_win_login(client, &win::probe_script())?,
    };
    remote::parse_probe(&text)
}

// Agent-line wording: rendered by the TUI and by `doctor`.

pub const UNKNOWN_VERSION: LocalizedText<&'static str> =
    LocalizedText::new("版本未知", "unknown version");
pub const AUTH_OK: LocalizedText<&'static str> = LocalizedText::new("已登录", "auth ok");
pub const AUTH_UNKNOWN: LocalizedText<&'static str> =
    LocalizedText::new("登录状态未知", "auth unknown");
pub const NOT_INSTALLED_HINT: LocalizedText<&'static str> =
    LocalizedText::new("未安装 · 回车安装", "not installed · enter to install");

pub fn format_agent_line(kind: AgentKind, probe: &Probe) -> LocalizedText<String> {
    LocalizedText::new(
        format_agent_line_lang(kind, probe, Lang::Zh),
        format_agent_line_lang(kind, probe, Lang::En),
    )
}

fn format_agent_line_lang(kind: AgentKind, probe: &Probe, lang: Lang) -> String {
    match probe.agent(kind) {
        Some(a) if a.found => {
            let ver = a
                .version
                .clone()
                .unwrap_or_else(|| UNKNOWN_VERSION.pick(lang).to_string());
            let auth = if a.auth_hint == "ok" {
                AUTH_OK.pick(lang)
            } else {
                AUTH_UNKNOWN.pick(lang)
            };
            format!("{}  {}  ({})", kind.title(), ver, auth)
        }
        _ => format!("{}  {}", kind.title(), NOT_INSTALLED_HINT.pick(lang)),
    }
}

fn should_retry_other_os(err: &anyhow::Error) -> bool {
    !matches!(err.downcast_ref::<TransportError>(), Some(t) if t.timed_out)
}

#[cfg(test)]
mod tests {
    use super::should_retry_other_os;
    use faragent_core::vocab::AuthMode;
    use faragent_transport::TransportError;

    fn timeout_err() -> anyhow::Error {
        anyhow::Error::new(TransportError {
            host: "h".into(),
            mode: AuthMode::Auto,
            command: "ssh".into(),
            raw: "timed out".into(),
            status: None,
            timed_out: true,
            needs_auth: false,
            methods: String::new(),
        })
    }

    #[test]
    fn timeout_does_not_retry_the_other_os() {
        assert!(!should_retry_other_os(&timeout_err()));
    }

    #[test]
    fn parse_failure_still_retries_the_other_os() {
        assert!(should_retry_other_os(&anyhow::anyhow!("bad probe text")));
    }
}

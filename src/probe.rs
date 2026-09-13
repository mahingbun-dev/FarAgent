use crate::agents::AgentKind;
use crate::config;
use crate::remote::{self, HostOs};
use crate::runtime;
use crate::ssh::Client;
use crate::text::{Lang, LocalizedText};
use crate::win;
use anyhow::Result;

pub use crate::remote::Probe;

/// Which dialect does this host speak? Cached in `~/.faragent/config.json`;
/// on a miss, ask the remote with a marker every candidate shell answers.
/// Inconclusive answers (connection failed, exotic shell) are not cached.
pub fn host_os(host: &str) -> Result<HostOs> {
    if let Some(os) = config::host_os(host) {
        return Ok(os);
    }
    let client = Client::new(host)?;
    let out = client.exec_raw_line(remote::os_marker_command())?;
    let text = Client::output_text(&out);
    let Some(os) = remote::parse_os_marker(&text) else {
        return Ok(HostOs::Posix);
    };
    let _ = config::set_host_os(host, os);
    Ok(os)
}

pub fn probe_host(host: &str) -> Result<Probe> {
    let client = Client::new(host)?;
    let expected = host_os(host).unwrap_or_default();
    let probe = match try_probe(&client, expected) {
        Ok(p) => p,
        Err(e) => {
            // The cached dialect may be stale (reprovisioned host) or the
            // marker inconclusive: one retry with the other dialect.
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

fn try_probe(client: &Client, os: HostOs) -> Result<Probe> {
    let text = match os {
        HostOs::Posix => runtime::run_login(client, remote::probe_script())?,
        HostOs::Windows => runtime::run_win_login(client, &win::probe_script())?,
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

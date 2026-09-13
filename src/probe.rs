use crate::agents::AgentKind;
use crate::config;
use crate::i18n::Lang;
use crate::remote::{self, HostOs};
use crate::runtime;
use crate::ssh::Client;
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

pub fn format_agent_line(kind: AgentKind, probe: &Probe) -> String {
    format_agent_line_lang(kind, probe, Lang::En)
}

pub fn format_agent_line_lang(kind: AgentKind, probe: &Probe, lang: Lang) -> String {
    match probe.agent(kind) {
        Some(a) if a.found => {
            let ver = a.version.as_deref().unwrap_or(lang.unknown_version());
            let auth = if a.auth_hint == "ok" {
                lang.auth_ok()
            } else {
                lang.auth_unknown()
            };
            format!("{}  {}  ({})", kind.title(), ver, auth)
        }
        _ => format!("{}  {}", kind.title(), lang.not_installed_hint()),
    }
}

use crate::agents::AgentKind;
use crate::i18n::Lang;
use crate::remote;
use crate::runtime;
use crate::ssh::Client;
use anyhow::Result;

pub use crate::remote::Probe;

pub fn probe_host(host: &str) -> Result<Probe> {
    let client = Client::new(host)?;
    let text = runtime::run_login(&client, remote::probe_script())?;
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

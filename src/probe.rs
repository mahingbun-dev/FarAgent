use crate::agents::AgentKind;
use crate::runtime;
use crate::ssh::Client;
use anyhow::{anyhow, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Probe {
    pub ok: bool,
    pub home: String,
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
    pub path: String,
    pub tmux: TmuxProbe,
    pub agents: Vec<AgentProbe>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TmuxProbe {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentProbe {
    pub id: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    #[serde(default)]
    pub auth_hint: String,
}

impl Probe {
    pub fn agent(&self, kind: AgentKind) -> Option<&AgentProbe> {
        self.agents.iter().find(|a| a.id == kind.slug())
    }
}

pub fn probe_host(host: &str) -> Result<Probe> {
    let client = Client::new(host)?;
    runtime::ensure_helper(&client)?;
    let value = runtime::remote_json(&client, &["probe"])?;
    let probe: Probe = serde_json::from_value(value).map_err(|e| anyhow!("probe json: {e}"))?;
    if !probe.ok {
        return Err(anyhow!("remote probe returned ok=false"));
    }
    Ok(probe)
}

pub fn format_agent_line(kind: AgentKind, probe: &Probe) -> String {
    match probe.agent(kind) {
        Some(a) if a.found => {
            let ver = a.version.as_deref().unwrap_or("unknown version");
            let auth = if a.auth_hint == "ok" {
                "auth ok"
            } else {
                "auth unknown"
            };
            format!("{}  {}  ({})", kind.title(), ver, auth)
        }
        _ => format!("{}  not installed", kind.title()),
    }
}

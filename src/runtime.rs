use crate::agents::{self, AgentKind};
use crate::remote::{self, DiskFile, ListDump, StartOutcome};
use crate::ssh::Client;
use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub agent: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub mtime: f64,
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub tmux: Option<String>,
}

impl SessionSummary {
    #[allow(dead_code)]
    pub fn label(&self) -> String {
        let mark = if self.live { "live" } else { "idle" };
        let title = self
            .title
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.id);
        let cwd = self.cwd.as_deref().unwrap_or("?");
        format!("[{mark}]  {title}  ({cwd})")
    }
}

pub fn run_login(client: &Client, script: &str) -> Result<String> {
    let output = client.exec_login(script)?;
    if !output.status.success() {
        Client::require_ok(&output)?;
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn ensure_tmux_conf(client: &Client) -> Result<()> {
    let write = client.exec_login_stdin(
        remote::write_tmux_conf_script(),
        remote::TMUX_CONF.as_bytes(),
    )?;
    Client::require_ok(&write)?;
    Ok(())
}

pub fn list_sessions(host: &str, agent: AgentKind) -> Result<Vec<SessionSummary>> {
    let client = Client::new(host)?;
    let _ = ensure_tmux_conf(&client);
    let text = run_login(&client, &remote::list_script(agent))?;
    let dump = remote::parse_list(&text)?;
    Ok(merge_sessions(agent, dump))
}

/// Create a detached tmux session if needed. If it already exists, only attach later.
pub fn ensure_tmux_session(
    host: &str,
    agent: AgentKind,
    cwd: &Path,
    session_id: Option<&str>,
) -> Result<String> {
    let client = Client::new(host)?;
    ensure_tmux_conf(&client)?;
    let sid = session_id
        .map(|s| s.to_string())
        .unwrap_or_else(agents::new_session_id);
    let name = agents::tmux_name(agent, &sid);
    let cwd_s = cwd.to_string_lossy();
    let script = remote::start_script(agent, cwd_s.as_ref(), session_id, &name);
    let text = run_login(&client, &script)?;
    match remote::parse_start(&text)? {
        StartOutcome::Ok { tmux } => Ok(tmux),
        StartOutcome::Err { error, hint } => Err(anyhow!("{error}: {hint}")),
    }
}

fn merge_sessions(agent: AgentKind, dump: ListDump) -> Vec<SessionSummary> {
    let prefix = format!("farssh-{}-", agent.slug());
    let live_tmux: HashSet<String> = dump
        .tmux
        .iter()
        .map(|(n, _)| n.clone())
        .filter(|n| n.starts_with(&prefix))
        .collect();
    let tmux_cwd: std::collections::HashMap<String, String> = dump
        .tmux
        .into_iter()
        .filter(|(n, _)| n.starts_with(&prefix))
        .collect();

    let mut rows: Vec<SessionSummary> = dump
        .files
        .iter()
        .filter(|f| f.agent == agent.slug())
        .map(|f| row_from_file(agent, f))
        .collect();

    let mut seen: HashSet<String> = HashSet::new();
    for row in &mut rows {
        if let Some(name) = &row.tmux {
            row.live = live_tmux.contains(name);
            seen.insert(name.clone());
        }
    }

    for (name, cwd) in &tmux_cwd {
        if seen.contains(name) {
            continue;
        }
        let id = name[prefix.len()..].to_string();
        rows.push(SessionSummary {
            id,
            agent: agent.slug().into(),
            title: Some("(live)".into()),
            cwd: (!cwd.is_empty()).then(|| cwd.clone()),
            mtime: 0.0,
            live: true,
            tmux: Some(name.clone()),
        });
    }

    rows.sort_by(|a, b| {
        b.live.cmp(&a.live).then(
            b.mtime
                .partial_cmp(&a.mtime)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    rows
}

fn row_from_file(agent: AgentKind, f: &DiskFile) -> SessionSummary {
    let sid = match agent {
        AgentKind::Codex => remote::find_uuid(&f.id).unwrap_or_else(|| f.id.clone()),
        _ => f.id.clone(),
    };
    let (title, cwd) = match agent {
        AgentKind::Grok => {
            let (t, c) = remote::grok_summary_meta(&f.body, &f.cwd_hint);
            (t.or_else(|| Some(sid.clone())), c)
        }
        AgentKind::Claude => {
            let m = remote::jsonl_meta(&f.body, 80);
            (
                m.title.or_else(|| Some(sid.clone())),
                m.cwd.or_else(|| remote::claude_guess_cwd(&f.cwd_hint)),
            )
        }
        AgentKind::Codex => {
            let m = remote::jsonl_meta(&f.body, 120);
            (m.title.or_else(|| Some(sid.clone())), m.cwd)
        }
        AgentKind::Pi => {
            let m = remote::jsonl_meta(&f.body, 80);
            let hint = if f.cwd_hint == sid {
                None
            } else {
                Some(remote::percent_decode(&f.cwd_hint)).filter(|s| !s.is_empty())
            };
            (m.title.or_else(|| Some(sid.clone())), m.cwd.or(hint))
        }
    };
    SessionSummary {
        id: sid.clone(),
        agent: agent.slug().into(),
        title,
        cwd,
        mtime: f.mtime,
        live: false,
        tmux: Some(agents::tmux_name(agent, &sid)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::DiskFile;

    #[test]
    fn merge_marks_live_tmux_and_disk() {
        let dump = ListDump {
            tmux: vec![
                ("farssh-grok-abc123abc123".into(), "/tmp/p".into()),
                ("other".into(), "/x".into()),
            ],
            files: vec![DiskFile {
                agent: "grok".into(),
                id: "abc123abc123".into(),
                mtime: 10.0,
                cwd_hint: "%2Ftmp%2Fp".into(),
                body: br#"{"generated_title":"hello","git_root_dir":"/tmp/p"}"#.to_vec(),
            }],
        };
        let rows = merge_sessions(AgentKind::Grok, dump);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].live);
        assert_eq!(rows[0].title.as_deref(), Some("hello"));
        assert_eq!(rows[0].cwd.as_deref(), Some("/tmp/p"));
    }

    #[test]
    fn live_only_tmux_becomes_row() {
        let dump = ListDump {
            tmux: vec![("farssh-pi-newsession01".into(), "/work".into())],
            files: vec![],
        };
        let rows = merge_sessions(AgentKind::Pi, dump);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].live);
        assert_eq!(rows[0].cwd.as_deref(), Some("/work"));
        assert_eq!(rows[0].title.as_deref(), Some("(live)"));
    }
}

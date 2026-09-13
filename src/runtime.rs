use crate::agents::{self, AgentKind};
use crate::remote::{self, DiskFile, HostOs, ListDump, StartOutcome};
use crate::ssh::{run_login, run_win_login, run_win_login_args, OpenSshTransport};
use crate::text::LocalizedText;
use crate::win;
use anyhow::Result;
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
    /// A process that may still hold this session (Windows remotes, where
    /// there is no tmux to tell `live` apart). Drives a confirm dialog.
    #[serde(default)]
    pub running: bool,
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

/// Row marks in the session list. `live` = a tmux session is still running
/// (attach only, never resume); `running` = a Windows process may still hold
/// the session (a confirmation asks first).
pub const MARK_LIVE: &str = "live";
pub const MARK_IDLE: &str = "idle";
pub const MARK_RUNNING: &str = "running";

// Guards and wording around starting a session; both languages at once.

#[allow(dead_code)]
pub const TMUX_MISSING: LocalizedText<&'static str> = LocalizedText::new(
    "远程未安装 tmux。回车可按官方/系统包管理器安装。",
    "tmux is not installed on the remote. Enter to install it.",
);

pub const TMUX_MISSING_SHORT: LocalizedText<&'static str> = LocalizedText::new(
    "远程未安装 tmux",
    "tmux is not installed on the remote host",
);

pub fn agent_missing(name: &str) -> LocalizedText<String> {
    LocalizedText::new(
        format!("远程未安装 {name}"),
        format!("{name} is not installed on the remote host"),
    )
}

#[allow(dead_code)]
pub fn agent_not_installed(name: &str) -> LocalizedText<String> {
    LocalizedText::new(format!("{name} 未安装"), format!("{name} is not installed"))
}

#[allow(dead_code)]
pub const NOT_INSTALLED: LocalizedText<&'static str> =
    LocalizedText::new("未安装", "not installed");

pub fn ensure_tmux_conf(client: &OpenSshTransport) -> Result<()> {
    let write = client.exec_login_stdin(
        remote::write_tmux_conf_script(),
        remote::TMUX_CONF.as_bytes(),
    )?;
    client.require_ok(&write)?;
    Ok(())
}

pub fn list_sessions(host: &str, agent: AgentKind, os: HostOs) -> Result<Vec<SessionSummary>> {
    let client = OpenSshTransport::connect(host)?;
    match os {
        HostOs::Posix => {
            let _ = ensure_tmux_conf(&client);
            let text = run_login(&client, &remote::list_script(agent))?;
            Ok(merge_sessions(agent, os, remote::parse_list(&text)?))
        }
        HostOs::Windows => {
            let text = run_win_login(&client, &win::list_script(agent))?;
            Ok(merge_sessions(agent, os, remote::parse_list(&text)?))
        }
    }
}

/// Create a detached tmux session if needed. If it already exists, only attach later.
///
/// `create_cwd = true` runs `mkdir -p` for the working directory on the remote.
/// Only the TUI's confirmation screen passes `true`; every other path just
/// reports [`SessionError::CwdMissing`] so nothing is written behind the user.
pub fn ensure_tmux_session(
    host: &str,
    agent: AgentKind,
    cwd: &Path,
    session_id: Option<&str>,
    create_cwd: bool,
) -> Result<String> {
    let client = OpenSshTransport::connect(host)?;
    ensure_tmux_conf(&client)?;
    let sid = session_id
        .map(|s| s.to_string())
        .unwrap_or_else(agents::new_session_id);
    let name = agents::tmux_name(agent, &sid);
    let cwd_s = cwd.to_string_lossy();
    let script = remote::start_script(agent, cwd_s.as_ref(), session_id, &name, create_cwd);
    let text = run_login(&client, &script)?;
    match remote::parse_start(&text)? {
        StartOutcome::Ok { name } => Ok(name),
        StartOutcome::Err { error, hint } => Err(anyhow::Error::new(SessionError::from_remote(
            &error, &hint, &cwd_s,
        ))),
    }
}

/// Validate (and optionally create) the working directory on a Windows
/// remote, then return the display name for the foreground launch that
/// follows. There is no persistent session to create — `pty::attach_win`
/// runs the agent right after, and quitting it ends the session.
pub fn ensure_win_session(
    host: &str,
    agent: AgentKind,
    cwd: &Path,
    session_id: Option<&str>,
    create_cwd: bool,
) -> Result<String> {
    let client = OpenSshTransport::connect(host)?;
    let sid = session_id
        .map(|s| s.to_string())
        .unwrap_or_else(agents::new_session_id);
    let name = agents::tmux_name(agent, &sid);
    let cwd_s = cwd.to_string_lossy();
    let cwd_b64 = win::b64(&cwd_s);
    let name_b64 = win::b64(&name);
    let create = if create_cwd { "1" } else { "0" };
    let text = run_win_login_args(
        &client,
        &win::start_script(agent),
        &[&cwd_b64, create, &name_b64],
    )?;
    match remote::parse_start(&text)? {
        StartOutcome::Ok { .. } => Ok(name),
        StartOutcome::Err { error, hint } => Err(anyhow::Error::new(SessionError::from_remote(
            &error, &hint, &cwd_s,
        ))),
    }
}

/// Why a new session could not be started.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionError {
    /// The working directory is not there yet. The TUI turns this into a
    /// "create it?" confirmation instead of a dead end.
    #[error("remote directory does not exist: {dir}")]
    CwdMissing { dir: String },
    /// Anything else the remote start script reported (`tmux_missing`, ...).
    #[error("{code}: {hint}")]
    Remote { code: String, hint: String },
}

impl SessionError {
    fn from_remote(code: &str, hint: &str, dir: &str) -> Self {
        match code {
            "cwd_missing" => Self::CwdMissing {
                dir: dir.to_string(),
            },
            _ => Self::Remote {
                code: code.to_string(),
                hint: hint.to_string(),
            },
        }
    }
}

/// One merge for both dialects. POSIX: disk transcripts + tmux session names
/// decide `live`. Windows: disk transcripts + a process scan, which can only
/// suggest `running` (drives a confirmation, never a hard block).
fn merge_sessions(agent: AgentKind, os: HostOs, dump: ListDump) -> Vec<SessionSummary> {
    let live_tmux: HashSet<String> = dump
        .tmux
        .iter()
        .map(|(n, _)| n.clone())
        .filter(|n| agents::tmux_id_from_name(agent, n).is_some())
        .collect();
    let tmux_cwd: std::collections::HashMap<String, String> = dump
        .tmux
        .into_iter()
        .filter(|(n, _)| agents::tmux_id_from_name(agent, n).is_some())
        .collect();

    let mut rows: Vec<SessionSummary> = dump
        .files
        .iter()
        .filter(|f| f.agent == agent.slug())
        .map(|f| row_from_file(agent, f, os))
        .collect();

    let mut seen: HashSet<String> = HashSet::new();
    for row in &mut rows {
        let new_name = agents::tmux_name(agent, &row.id);
        let old_name = agents::legacy_tmux_name(agent, &row.id);
        if live_tmux.contains(&new_name) {
            row.live = true;
            row.tmux = Some(new_name.clone());
            seen.insert(new_name);
        } else if live_tmux.contains(&old_name) {
            row.live = true;
            row.tmux = Some(old_name.clone());
            seen.insert(old_name);
        }
    }

    for (name, cwd) in &tmux_cwd {
        if seen.contains(name) {
            continue;
        }
        let id = agents::tmux_id_from_name(agent, name)
            .unwrap_or(name)
            .to_string();
        rows.push(SessionSummary {
            id,
            agent: agent.slug().into(),
            title: Some("(live)".into()),
            cwd: (!cwd.is_empty()).then(|| cwd.clone()),
            mtime: 0.0,
            live: true,
            running: false,
            tmux: Some(name.clone()),
        });
    }

    let mut proc_seen: HashSet<String> = HashSet::new();
    for (pagent, pid) in &dump.procs {
        if pagent != agent.slug() || !proc_seen.insert(pid.clone()) {
            continue;
        }
        if !pid.is_empty() {
            let sid = match agent {
                AgentKind::Codex => remote::find_uuid(pid).unwrap_or_else(|| pid.clone()),
                _ => pid.clone(),
            };
            if let Some(row) = rows.iter_mut().find(|r| r.id == sid) {
                row.running = true;
                continue;
            }
        }
        // A process without a matchable id: surface it so the user knows
        // something for this agent may still hold a session.
        rows.push(SessionSummary {
            id: if pid.is_empty() {
                "(running)".into()
            } else {
                pid.clone()
            },
            agent: agent.slug().into(),
            title: Some("(running)".into()),
            cwd: None,
            mtime: 0.0,
            live: false,
            running: true,
            tmux: None,
        });
    }

    rows.sort_by(|a, b| {
        b.live.cmp(&a.live).then(b.running.cmp(&a.running)).then(
            b.mtime
                .partial_cmp(&a.mtime)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    rows
}

fn row_from_file(agent: AgentKind, f: &DiskFile, os: HostOs) -> SessionSummary {
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
                m.cwd.or_else(|| remote::claude_guess_cwd(&f.cwd_hint, os)),
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
        running: false,
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
                ("faragent-grok-abc123abc123".into(), "/tmp/p".into()),
                ("other".into(), "/x".into()),
            ],
            files: vec![DiskFile {
                agent: "grok".into(),
                id: "abc123abc123".into(),
                mtime: 10.0,
                cwd_hint: "%2Ftmp%2Fp".into(),
                body: br#"{"generated_title":"hello","git_root_dir":"/tmp/p"}"#.to_vec(),
            }],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Grok, HostOs::Posix, dump);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].live);
        assert_eq!(rows[0].title.as_deref(), Some("hello"));
        assert_eq!(rows[0].cwd.as_deref(), Some("/tmp/p"));
    }

    #[test]
    fn live_only_tmux_becomes_row() {
        let dump = ListDump {
            tmux: vec![("faragent-pi-newsession01".into(), "/work".into())],
            files: vec![],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Pi, HostOs::Posix, dump);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].live);
        assert_eq!(rows[0].cwd.as_deref(), Some("/work"));
        assert_eq!(rows[0].title.as_deref(), Some("(live)"));
    }

    #[test]
    fn merge_marks_legacy_live_tmux() {
        let dump = ListDump {
            tmux: vec![("farssh-grok-abc123abc123".into(), "/tmp/p".into())],
            files: vec![DiskFile {
                agent: "grok".into(),
                id: "abc123abc123".into(),
                mtime: 10.0,
                cwd_hint: "%2Ftmp%2Fp".into(),
                body: br#"{"generated_title":"hello","git_root_dir":"/tmp/p"}"#.to_vec(),
            }],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Grok, HostOs::Posix, dump);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].live);
        assert_eq!(rows[0].tmux.as_deref(), Some("farssh-grok-abc123abc123"));
    }

    #[test]
    fn merge_lists_both_prefixes() {
        let dump = ListDump {
            tmux: vec![
                ("farssh-grok-abc123abc123".into(), "/tmp/old".into()),
                ("faragent-grok-def456def456".into(), "/tmp/new".into()),
            ],
            files: vec![],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Grok, HostOs::Posix, dump);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.live));
        let names: HashSet<_> = rows.iter().filter_map(|r| r.tmux.as_deref()).collect();
        assert!(names.contains("farssh-grok-abc123abc123"));
        assert!(names.contains("faragent-grok-def456def456"));
    }

    #[test]
    fn windows_proc_marks_running_and_adds_proc_only_rows() {
        let dump = ListDump {
            tmux: vec![],
            files: vec![DiskFile {
                agent: "claude".into(),
                id: "abc123abc123".into(),
                mtime: 10.0,
                cwd_hint: "C--Users-me-app".into(),
                body: br#"{"cwd":"C:\\Users\\me\\app","message":"hello"}"#.to_vec(),
            }],
            procs: vec![
                ("claude".into(), "abc123abc123".into()),
                ("claude".into(), "def456def456".into()),
                ("codex".into(), "other".into()),
            ],
        };
        let rows = merge_sessions(AgentKind::Claude, HostOs::Windows, dump);
        assert_eq!(rows.len(), 2);
        let marked = rows.iter().find(|r| r.id == "abc123abc123").unwrap();
        assert!(marked.running);
        assert!(!marked.live);
        let proc_only = rows.iter().find(|r| r.id == "def456def456").unwrap();
        assert!(proc_only.running);
        assert_eq!(proc_only.title.as_deref(), Some("(running)"));
        // Other agents' processes are ignored.
        assert!(rows.iter().all(|r| r.agent == "claude"));
    }

    #[test]
    fn windows_proc_without_id_becomes_one_generic_running_row() {
        let dump = ListDump {
            tmux: vec![],
            files: vec![],
            procs: vec![("claude".into(), "".into()), ("claude".into(), "".into())],
        };
        let rows = merge_sessions(AgentKind::Claude, HostOs::Windows, dump);
        assert_eq!(rows.len(), 1, "duplicate empty ids collapse");
        assert!(rows[0].running);
        assert_eq!(rows[0].title.as_deref(), Some("(running)"));
    }

    #[test]
    fn old_session_json_without_running_still_loads() {
        let s: SessionSummary = serde_json::from_str(r#"{"id":"x","agent":"claude"}"#).unwrap();
        assert!(!s.running);
        assert!(!s.live);
    }
}

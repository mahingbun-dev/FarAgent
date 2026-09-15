use anyhow::Result;
use faragent_core::agents::{self, AgentKind, Launch};
use faragent_core::config;
use faragent_core::text::LocalizedText;
use faragent_core::vocab::HostOs;
use faragent_remote::remote::{self, DiskFile, ListDump, StartOutcome};
use faragent_remote::win;
use faragent_transport::{run_login, run_win_login, run_win_login_args, OpenSshTransport};
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
    /// Codex `codex exec` / launchd rollouts, listed separately in the app.
    #[serde(default)]
    pub scheduled: bool,
    /// The remote path of this session's conversation transcript, when the row
    /// came from a transcript file. `None` for a row the list only inferred
    /// from tmux or a process scan — the normal case for a session started
    /// moments ago, whose file may not exist yet. `#[serde(default)]` because
    /// this struct serialises straight to the TUI and the app: a reader built
    /// after this field existed must still deserialise a body written before
    /// it. (A reader that predates the field needs nothing — serde ignores
    /// unknown fields by default.)
    #[serde(default)]
    pub transcript: Option<String>,
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
pub const MARK_SCHEDULED: &str = "sched";

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

/// What a start produced — the value the app attaches to the session with.
///
/// `name` is what today's callers already used: the tmux session to attach
/// (POSIX) or the display name (Windows). `session_id` is the id the remote
/// CLI was *pinned* to, when it was pinned — the app turns it into
/// `~/.claude/projects/<slug>/<id>.jsonl`, so `None` means "this launch no
/// chat can be read for yet": the CLI chose its own id and we will only learn
/// it from a later listing, if at all.
///
/// Serialises straight across the Tauri boundary (`ensure_session`), hence
/// `Serialize`; field names stay snake_case like [`SessionSummary`]'s.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StartedSession {
    pub name: String,
    pub session_id: Option<String>,
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
) -> Result<StartedSession> {
    let client = OpenSshTransport::connect(host)?;
    ensure_tmux_conf(&client)?;
    let sid = session_id
        .map(|s| s.to_string())
        .unwrap_or_else(agents::new_session_id);
    let name = agents::tmux_name(agent, &sid);
    // A *new* session launches pinned to `sid` — the id we just generated.
    // Passing the caller's `None` through to the argv here was the bug: the id
    // named the tmux session but never reached Claude Code, so the transcript
    // file could not be located. `Launch` makes the two cases distinct.
    //
    // Whether the CLI is actually told is not ours to decide: the start script
    // asks the remote CLI's own `--help` and reports back. So the id we hand
    // the caller is the one the *remote* says it pinned, never the one we
    // hoped it would — an older CLI that has never heard of `--session-id`
    // launches unpinned and reports `None`, which is the app's existing
    // "transcript unknown, show the terminal" path, not an error.
    let launch = match session_id {
        Some(id) => Launch::Resume(id),
        None => Launch::New(&sid),
    };
    let cwd_s = cwd.to_string_lossy();
    let script = remote::start_script(
        agent,
        cwd_s.as_ref(),
        launch,
        &name,
        create_cwd,
        config::full_permissions(),
    );
    let text = run_login(&client, &script)?;
    match remote::parse_start(&text)? {
        StartOutcome::Ok { name, pinned } => Ok(StartedSession {
            name,
            session_id: pinned,
        }),
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
) -> Result<StartedSession> {
    let client = OpenSshTransport::connect(host)?;
    let sid = session_id
        .map(|s| s.to_string())
        .unwrap_or_else(agents::new_session_id);
    let name = agents::tmux_name(agent, &sid);
    // The interactive Windows launch pins no id ([`Launch::NewUnpinned`]): the
    // foreground `ssh -tt` gets no `--session-id`, and the shared helper — the
    // only thing that could read a transcript — is POSIX-only, so a Windows
    // conversation view is unreachable either way. A resume still reports the
    // caller's own id, which the agent is told. There is therefore nothing for
    // the `--session-id` gate to decide here: it only ever narrows a *new*
    // POSIX launch. A resume is safe on any version for the same reason it
    // always worked — `--resume` is the flag every release knows.
    let launch = match session_id {
        Some(id) => Launch::Resume(id),
        None => Launch::NewUnpinned,
    };
    let pinned = agent.launched_session_id(launch).map(str::to_string);
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
        StartOutcome::Ok { .. } => Ok(StartedSession {
            name,
            session_id: pinned,
        }),
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
            scheduled: false,
            transcript: None,
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
            scheduled: false,
            transcript: None,
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
    let (title, cwd, scheduled) = match agent {
        AgentKind::Grok => {
            let (t, c) = remote::grok_summary_meta(&f.body, &f.cwd_hint);
            (t.or_else(|| Some(sid.clone())), c, false)
        }
        AgentKind::Claude => {
            let m = remote::jsonl_meta(&f.body, 80);
            (
                m.title.or_else(|| Some(sid.clone())),
                m.cwd.or_else(|| remote::claude_guess_cwd(&f.cwd_hint, os)),
                m.scheduled,
            )
        }
        AgentKind::Codex => {
            let m = remote::jsonl_meta(&f.body, 120);
            (m.title.or_else(|| Some(sid.clone())), m.cwd, m.scheduled)
        }
        AgentKind::Pi => {
            // Pi's header carries the cwd verbatim and `jsonl_meta` reads it, so
            // there is nothing to reconstruct. The listing's `cwd_hint` is the
            // session directory's own name — the cwd rendered as
            // `--<path with / turned into ->--` — which cannot be turned back
            // into a path unambiguously: a `-` inside a directory name is
            // indistinguishable from a separator. It used to be handed to
            // `percent_decode`, Grok's rule, which returns it unchanged, so a Pi
            // row whose header could not be read reported a cwd of
            // `--Users-me-code-app--`. A wrong path on the rail is worse than no
            // path, so the hint is not consulted at all.
            let m = remote::jsonl_meta(&f.body, 80);
            (m.title.or_else(|| Some(sid.clone())), m.cwd, m.scheduled)
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
        scheduled,
        transcript: f.path.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faragent_remote::remote::DiskFile;

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
                path: None,
            }],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Grok, HostOs::Posix, dump);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].live);
        assert_eq!(rows[0].title.as_deref(), Some("hello"));
        assert_eq!(rows[0].cwd.as_deref(), Some("/tmp/p"));
    }

    /// Pi's session header names the cwd outright, and that is what the row
    /// shows — the directory name under `sessions/` is a `--`-wrapped, `-`-joined
    /// rendering of it that cannot be turned back into a path unambiguously (a
    /// cwd holding a literal `-` is indistinguishable from a separator), and for
    /// a while it was handed to `percent_decode` — Grok's rule — which leaves it
    /// untouched and produced a cwd of `--Users-me-code-app--`.
    #[test]
    fn a_pi_row_reads_its_cwd_from_the_session_header() {
        let dump = ListDump {
            tmux: vec![],
            files: vec![DiskFile {
                agent: "pi".into(),
                id: "2026-09-15T10-00-00-000Z_01a09d76-2125-7ab1-881e-9a258ab09c6e".into(),
                mtime: 10.0,
                cwd_hint: "--Users-me-code-app--".into(),
                body: br#"{"type":"session","version":3,"id":"01a09d76-2125-7ab1-881e-9a258ab09c6e","timestamp":"2026-09-15T10:00:00.000Z","cwd":"/Users/me/code/app"}"#.to_vec(),
                path: None,
            }],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Pi, HostOs::Posix, dump);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].cwd.as_deref(), Some("/Users/me/code/app"));
    }

    /// The same row built the way the remote's listing script reads it today:
    /// `cwdenc` is the first segment under `sessions/`, wrapper dashes included.
    /// This is the shape a real Pi file has, so it is the one that decides what
    /// the hint must not be mistaken for.
    #[test]
    fn a_pi_row_without_a_header_does_not_report_the_wrapper_as_a_path() {
        let dump = ListDump {
            tmux: vec![],
            files: vec![DiskFile {
                agent: "pi".into(),
                id: "2026-09-15T10-00-00-000Z_01a09d76-2125-7ab1-881e-9a258ab09c6e".into(),
                mtime: 10.0,
                cwd_hint: "--Users-me-code-app--".into(),
                body: br#"{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-09-15T10:00:01.000Z","message":{"role":"user","content":"hi"}}"#.to_vec(),
                path: None,
            }],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Pi, HostOs::Posix, dump);
        assert_eq!(rows.len(), 1);
        // Not `--Users-me-code-app--`, and not a guess with the separator dashes
        // turned back into slashes: when the header is missing there is no cwd
        // to report, and `None` is the honest answer.
        assert_eq!(rows[0].cwd, None);
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
        // A row inferred from tmux alone has no transcript file to point at.
        assert_eq!(rows[0].transcript, None);
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
                path: None,
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
    fn merge_marks_codex_exec_rollouts_as_scheduled() {
        let dump = ListDump {
            tmux: vec![],
            files: vec![
                DiskFile {
                    agent: "codex".into(),
                    id: "rollout-01aaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                    mtime: 20.0,
                    cwd_hint: "".into(),
                    path: Some(
                        "/home/me/.codex/sessions/2026/09/14/rollout-01aaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl"
                            .into(),
                    ),
                    body: br#"{"type":"session_meta","payload":{"cwd":"/work","source":"vscode","originator":"Codex Desktop"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the build"}]}}
"#
                    .to_vec(),
                },
                DiskFile {
                    agent: "codex".into(),
                    id: "rollout-01bbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                    mtime: 10.0,
                    cwd_hint: "".into(),
                    path: None,
                    body: br#"{"type":"session_meta","payload":{"cwd":"/work","source":"exec","originator":"codex_exec"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hourly sync"}]}}
"#
                    .to_vec(),
                },
            ],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Codex, HostOs::Posix, dump);
        assert_eq!(rows.len(), 2);
        let interactive = rows.iter().find(|r| !r.scheduled).unwrap();
        let scheduled = rows.iter().find(|r| r.scheduled).unwrap();
        assert_eq!(interactive.title.as_deref(), Some("fix the build"));
        assert_eq!(scheduled.title.as_deref(), Some("hourly sync"));
        // The transcript path rides through from the DiskFile untouched; a
        // file-backed row that carried none stays `None`.
        assert_eq!(
            interactive.transcript.as_deref(),
            Some("/home/me/.codex/sessions/2026/09/14/rollout-01aaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl")
        );
        assert_eq!(scheduled.transcript, None);
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
                path: None,
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
    fn merge_reads_codex_payload_title_and_cwd() {
        let dump = ListDump {
            tmux: vec![],
            files: vec![DiskFile {
                agent: "codex".into(),
                id: "rollout-2026-09-14T09-59-23-01a09da3-f4c3-7f73-8a10-752981cdc3d3.jsonl"
                    .into(),
                mtime: 10.0,
                cwd_hint: "".into(),
                body: r##"{"type":"session_meta","payload":{"session_id":"01a09da3-f4c3-7f73-8a10-752981cdc3d3","cwd":"/tmp/wo"}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<app-context>\nskip"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\nnope"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"how to monetize?\n"}]}}
"##
                .as_bytes()
                .to_vec(),
                path: None,
            }],
            procs: vec![],
        };
        let rows = merge_sessions(AgentKind::Codex, HostOs::Posix, dump);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "01a09da3-f4c3-7f73-8a10-752981cdc3d3");
        assert_eq!(rows[0].title.as_deref(), Some("how to monetize?"));
        assert_eq!(rows[0].cwd.as_deref(), Some("/tmp/wo"));
    }

    #[test]
    fn old_session_json_without_running_still_loads() {
        let s: SessionSummary = serde_json::from_str(r#"{"id":"x","agent":"claude"}"#).unwrap();
        assert!(!s.running);
        assert!(!s.live);
        // A payload written before this field existed deserialises with it
        // absent, not with an error: the app and the TUI both read this shape.
        assert_eq!(s.transcript, None);
    }

    #[test]
    fn transcript_survives_a_serde_round_trip() {
        let s = SessionSummary {
            id: "x".into(),
            agent: "claude".into(),
            title: None,
            cwd: None,
            mtime: 0.0,
            live: false,
            running: false,
            tmux: None,
            scheduled: false,
            transcript: Some("/home/me/.claude/projects/-Users-me/x.jsonl".into()),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("/home/me/.claude/projects/-Users-me/x.jsonl"));
        let back: SessionSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(back.transcript, s.transcript);
    }

    /// The shape the app receives from `ensure_session`. It crosses the Tauri
    /// boundary, so the field names are part of the contract: snake_case, and
    /// `session_id` is `null` (not absent) when the launch pinned no id.
    #[test]
    fn started_session_serialises_for_the_app() {
        // The name is *derived* from the id, never chosen: `ensure_tmux_session`
        // settles the id first and names the session after its last twelve
        // alphanumerics (`agents::short_id`). Deriving it here is what makes this
        // a claim about that contract rather than a second spelling of the same
        // string — the fixture used to read `faragent-claude-15c76662-240`, which
        // no code path can produce for this uuid, and the assertion could not
        // tell, because all it checked was that the struct serialises.
        let id = "15c76662-2409-4f37-bd81-fd4f1b3053dd";
        let name = agents::tmux_name(AgentKind::Claude, id);
        assert_eq!(name, "faragent-claude-fd4f1b3053dd");
        let started = StartedSession {
            name,
            session_id: Some(id.into()),
        };
        assert_eq!(
            serde_json::to_string(&started).unwrap(),
            r#"{"name":"faragent-claude-fd4f1b3053dd","session_id":"15c76662-2409-4f37-bd81-fd4f1b3053dd"}"#
        );

        // A launch the remote declined to pin reports `null`; its name still
        // derives from the id the backend generated for the tmux session.
        let unpinned = StartedSession {
            name: agents::tmux_name(AgentKind::Codex, "01a09da3f4c3"),
            session_id: None,
        };
        assert_eq!(
            serde_json::to_string(&unpinned).unwrap(),
            r#"{"name":"faragent-codex-01a09da3f4c3","session_id":null}"#
        );
    }

    /// Where the `--session-id` gate lands for the caller: `session_id` is the
    /// id the *remote* reported pinning, so a CLI that does not know the flag
    /// yields `null` — the app's existing "no conversation view" path — rather
    /// than an id we hoped for and a transcript path that does not exist.
    #[test]
    fn the_reported_session_id_is_the_one_the_remote_pinned() {
        let id = "15c76662-2409-4f37-bd81-fd4f1b3053dd";
        let build = |text: String| match remote::parse_start(&text).unwrap() {
            StartOutcome::Ok { name, pinned } => StartedSession {
                name,
                session_id: pinned,
            },
            other => panic!("expected a started session, got {other:?}"),
        };

        let pinned = build(format!(
            "FARAGENT_START_V1\nok\tcreated\tfaragent-claude-x\npin\t{id}\n"
        ));
        assert_eq!(pinned.session_id.as_deref(), Some(id));

        let declined = build("FARAGENT_START_V1\nok\tcreated\tfaragent-claude-x\npin\t\n".into());
        assert_eq!(declined.session_id, None);
        // An older remote that never prints the line at all degenerates the
        // same way, which is why the degradation needs no version check.
        let older = build("FARAGENT_START_V1\nok\texists\tfaragent-claude-x\n".into());
        assert_eq!(older.session_id, None);
    }
}

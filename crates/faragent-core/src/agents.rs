use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Grok,
    Pi,
}

impl AgentKind {
    pub const ALL: [AgentKind; 4] = [
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Grok,
        AgentKind::Pi,
    ];

    pub fn parse(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "grok" => Ok(Self::Grok),
            "pi" => Ok(Self::Pi),
            other => Err(anyhow!("unknown agent: {other}")),
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
            Self::Pi => "pi",
        }
    }

    pub fn bin(self) -> &'static str {
        self.slug()
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Grok => "Grok Build",
            Self::Pi => "Pi",
        }
    }

    /// Native CLI argv to start a new conversation.
    pub fn new_argv(self) -> Vec<String> {
        vec![self.bin().to_string()]
    }

    /// Native CLI argv to resume a disk session. Never used when tmux is live.
    pub fn resume_argv(self, session_id: &str) -> Vec<String> {
        match self {
            Self::Claude => vec!["claude".into(), "--resume".into(), session_id.into()],
            Self::Codex => vec!["codex".into(), "resume".into(), session_id.into()],
            Self::Grok => vec!["grok".into(), "--resume".into(), session_id.into()],
            Self::Pi => vec!["pi".into(), "--session".into(), session_id.into()],
        }
    }

    /// Whether the CLI accepts `--session-id <uuid>` to pin a *new* session's
    /// id. Measured against the CLIs themselves, not assumed:
    ///
    /// * Claude Code (2.1.83) accepts it — `--session-id <uuid>` is documented
    ///   as "Use a specific session ID for the conversation (must be a valid
    ///   UUID)". Rejected beside `--resume` unless `--fork-session` is also
    ///   given, which is why only a *new* launch emits it.
    /// * Grok Build (1.0.25 on the target remote: `-s, --session-id` — "Use a
    ///   specific session UUID for a **new** conversation (must be a valid
    ///   UUID)"; measured rejecting `notauuid`). Same constraint with
    ///   `--resume`, so again only a new launch emits it.
    /// * Codex does not — `codex --help` documents no such flag, here or on
    ///   the remote; the only place it takes an id is `codex resume [ID]`.
    /// * Pi was not installed on the remote (or here) to measure, so it stays
    ///   `false`: emitting a flag a CLI does not know is a hard launch failure,
    ///   while omitting one only costs the new-session conversation view.
    pub fn accepts_session_id(self) -> bool {
        matches!(self, Self::Claude | Self::Grok)
    }

    /// The session id the launched CLI will actually use, when the launch
    /// determines it. A resume always names it; a new session names it only
    /// for a CLI that accepts `--session-id`. `None` otherwise — the CLI picks
    /// its own id and the caller must learn it later, if at all.
    pub fn launched_session_id<'a>(self, launch: Launch<'a>) -> Option<&'a str> {
        match launch {
            Launch::Resume(id) => Some(id),
            Launch::New(id) if self.accepts_session_id() => Some(id),
            Launch::New(_) | Launch::NewUnpinned => None,
        }
    }

    /// Argv for a new or idle-resume launch. When `full_permissions` is true,
    /// appends that agent's bypass flag (Codex inserts it before `resume`).
    pub fn launch_argv(self, launch: Launch<'_>, full_permissions: bool) -> Vec<String> {
        let mut argv = match launch {
            Launch::New(id) if self.accepts_session_id() => {
                let mut argv = self.new_argv();
                argv.extend(["--session-id".into(), id.into()]);
                argv
            }
            Launch::New(_) | Launch::NewUnpinned => self.new_argv(),
            Launch::Resume(id) => self.resume_argv(id),
        };
        if !full_permissions {
            return argv;
        }
        match self {
            Self::Claude => {
                argv.extend(["--permission-mode".into(), "bypassPermissions".into()]);
            }
            Self::Codex => {
                argv.insert(1, "--dangerously-bypass-approvals-and-sandbox".into());
            }
            Self::Grok => {
                argv.push("--always-approve".into());
            }
            Self::Pi => {}
        }
        argv
    }
}

/// What a launch is for.
///
/// The old `launch_argv(Option<&str>, bool)` overloaded `None` as "start
/// fresh": one value meant both "this is a new session" *and* "we know nothing
/// about its id". That is exactly how a session the app started could never
/// show its conversation — the branch that names the tmux session generated an
/// id, but the argv was built from the caller's `None`, so Claude Code was
/// never told it and the transcript path was unrecoverable. The intent is now
/// the type's job: `Launch::New` must name an id, and the one launch that
/// genuinely cannot carry one says so by name rather than by omission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch<'a> {
    /// A fresh conversation, pinned to `id`. The CLI is told
    /// `--session-id <id>` when it accepts one; otherwise the id only names
    /// the tmux session and the CLI ids itself.
    New(&'a str),
    /// A fresh conversation the CLI ids itself — the interactive Windows
    /// launch. faragent cannot pin an id there (the foreground `ssh -tt`
    /// session is not this script's job, and no chat view could read a Windows
    /// transcript anyway: the helper channel is POSIX-only), so no id is
    /// invented for it.
    NewUnpinned,
    /// Continue the existing conversation `id`.
    Resume(&'a str),
}

impl fmt::Display for AgentKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.title())
    }
}

pub fn short_id(session_id: &str) -> String {
    let alnum: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if alnum.is_empty() {
        return "new".into();
    }
    if alnum.len() <= 12 {
        alnum
    } else {
        alnum[alnum.len() - 12..].to_string()
    }
}

pub const TMUX_PREFIX: &str = "faragent";
/// Pre-rename tmux session prefix; list/attach still recognize these.
pub const LEGACY_TMUX_PREFIX: &str = "farssh";

pub fn tmux_name(agent: AgentKind, session_id: &str) -> String {
    format!("{}-{}-{}", TMUX_PREFIX, agent.slug(), short_id(session_id))
}

pub fn legacy_tmux_name(agent: AgentKind, session_id: &str) -> String {
    format!(
        "{}-{}-{}",
        LEGACY_TMUX_PREFIX,
        agent.slug(),
        short_id(session_id)
    )
}

/// Session id suffix if `name` is a current or legacy tmux name for `agent`.
pub fn tmux_id_from_name(agent: AgentKind, name: &str) -> Option<&str> {
    let slug = agent.slug();
    for prefix in [TMUX_PREFIX, LEGACY_TMUX_PREFIX] {
        let p = format!("{prefix}-{slug}-");
        if let Some(rest) = name.strip_prefix(&p) {
            if !rest.is_empty() {
                return Some(rest);
            }
        }
    }
    None
}

/// A full v4 UUID for a session the app starts itself.
///
/// It must be the whole UUID, not the old 12-character id: Claude Code rejects
/// anything that is not a valid UUID (`--session-id notauuid` → "Invalid
/// session ID. Must be a valid UUID."), so a short id could never be handed to
/// the CLI. The tmux name still takes only its last 12 alphanumerics (see
/// [`short_id`]), so the name shape is unchanged and the two stay derivable
/// from each other.
pub fn new_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_commands() {
        assert_eq!(
            AgentKind::Claude.resume_argv("abc"),
            vec!["claude", "--resume", "abc"]
        );
        assert_eq!(
            AgentKind::Codex.resume_argv("abc"),
            vec!["codex", "resume", "abc"]
        );
        assert_eq!(
            AgentKind::Grok.resume_argv("abc"),
            vec!["grok", "--resume", "abc"]
        );
        assert_eq!(
            AgentKind::Pi.resume_argv("abc"),
            vec!["pi", "--session", "abc"]
        );
    }

    #[test]
    fn tmux_name_uses_last_12_alnum() {
        let id = "01a093cd-ec3c-74e3-9d43-cdb915ddb244";
        let name = tmux_name(AgentKind::Grok, id);
        assert!(name.starts_with("faragent-grok-"));
        let suffix = name.strip_prefix("faragent-grok-").unwrap();
        assert!(suffix.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(suffix.len(), 12);
        assert_eq!(short_id(id), suffix);
        assert_eq!(tmux_id_from_name(AgentKind::Grok, &name), Some(suffix));
        let legacy = legacy_tmux_name(AgentKind::Grok, id);
        assert_eq!(tmux_id_from_name(AgentKind::Grok, &legacy), Some(suffix));
        assert!(tmux_id_from_name(AgentKind::Claude, &name).is_none());
    }

    #[test]
    fn new_argv_is_bare_binary() {
        for agent in AgentKind::ALL {
            assert_eq!(agent.new_argv(), vec![agent.bin()]);
        }
    }

    #[test]
    fn launch_argv_bare_matches_new_and_resume() {
        for agent in AgentKind::ALL {
            assert_eq!(
                agent.launch_argv(Launch::NewUnpinned, false),
                agent.new_argv()
            );
            assert_eq!(
                agent.launch_argv(Launch::Resume("abc"), false),
                agent.resume_argv("abc")
            );
        }
    }

    #[test]
    fn launch_argv_full_permissions_per_agent() {
        assert_eq!(
            AgentKind::Claude.launch_argv(Launch::NewUnpinned, true),
            vec!["claude", "--permission-mode", "bypassPermissions"]
        );
        assert_eq!(
            AgentKind::Claude.launch_argv(Launch::Resume("abc"), true),
            vec![
                "claude",
                "--resume",
                "abc",
                "--permission-mode",
                "bypassPermissions"
            ]
        );
        assert_eq!(
            AgentKind::Codex.launch_argv(Launch::NewUnpinned, true),
            vec!["codex", "--dangerously-bypass-approvals-and-sandbox"]
        );
        assert_eq!(
            AgentKind::Codex.launch_argv(Launch::Resume("abc"), true),
            vec![
                "codex",
                "--dangerously-bypass-approvals-and-sandbox",
                "resume",
                "abc"
            ]
        );
        assert_eq!(
            AgentKind::Grok.launch_argv(Launch::NewUnpinned, true),
            vec!["grok", "--always-approve"]
        );
        assert_eq!(
            AgentKind::Grok.launch_argv(Launch::Resume("abc"), true),
            vec!["grok", "--resume", "abc", "--always-approve"]
        );
        assert_eq!(
            AgentKind::Pi.launch_argv(Launch::NewUnpinned, true),
            vec!["pi"]
        );
        assert_eq!(
            AgentKind::Pi.launch_argv(Launch::Resume("abc"), true),
            vec!["pi", "--session", "abc"]
        );
    }

    #[test]
    fn new_session_id_is_a_uuid_the_cli_would_accept() {
        let id = new_session_id();
        // `--session-id` insists on a valid UUID, so the round trip through the
        // parser is the shape check: 36 chars, 8-4-4-4-12, lowercase hex.
        let parsed = uuid::Uuid::parse_str(&id).expect("new_session_id must be a valid UUID");
        assert_eq!(parsed.to_string(), id);
        assert_eq!(id.len(), 36);
        for (i, c) in id.char_indices() {
            if matches!(i, 8 | 13 | 18 | 23) {
                assert_eq!(c, '-', "hyphen at {i} in {id}");
            } else {
                assert!(
                    c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
                    "hex digit at {i} in {id}"
                );
            }
        }
        // Two calls never collide, and neither repeats the old short form.
        assert_ne!(id, new_session_id());
    }

    #[test]
    fn tmux_name_is_unchanged_by_the_full_uuid() {
        let id = new_session_id();
        let name = tmux_name(AgentKind::Claude, &id);
        assert!(name.starts_with("faragent-claude-"));
        let suffix = name.strip_prefix("faragent-claude-").unwrap();
        assert!(suffix.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(suffix.len(), 12);
        assert_eq!(short_id(&id), suffix);
        // The name is still recoverable, and still shares its last 12
        // alphanumerics with the transcript file's uuid.
        assert_eq!(tmux_id_from_name(AgentKind::Claude, &name), Some(suffix));
        assert!(id.ends_with(suffix));
    }

    #[test]
    fn a_new_claude_session_carries_the_session_id() {
        let id = "15c76662-2409-4f37-bd81-fd4f1b3053dd";
        assert_eq!(
            AgentKind::Claude.launch_argv(Launch::New(id), false),
            vec!["claude", "--session-id", id]
        );
        // With full permissions the id is still there, and the pin comes first.
        assert_eq!(
            AgentKind::Claude.launch_argv(Launch::New(id), true),
            vec![
                "claude",
                "--session-id",
                id,
                "--permission-mode",
                "bypassPermissions"
            ]
        );
        assert!(AgentKind::Claude.accepts_session_id());
    }

    /// Grok Build's `-s, --session-id` was measured on the target remote
    /// (1.0.25) accepting a new-session id and rejecting a non-UUID.
    #[test]
    fn a_new_grok_session_carries_the_session_id() {
        let id = "01a093cc-1e76-7213-84c0-93b702f47386";
        assert_eq!(
            AgentKind::Grok.launch_argv(Launch::New(id), false),
            vec!["grok", "--session-id", id]
        );
        assert_eq!(
            AgentKind::Grok.launch_argv(Launch::New(id), true),
            vec!["grok", "--session-id", id, "--always-approve"]
        );
        assert!(AgentKind::Grok.accepts_session_id());
    }

    #[test]
    fn codex_and_pi_are_not_told_a_new_session_id() {
        let id = "15c76662-2409-4f37-bd81-fd4f1b3053dd";
        for agent in [AgentKind::Codex, AgentKind::Pi] {
            assert_eq!(
                agent.launch_argv(Launch::New(id), false),
                agent.new_argv(),
                "{agent} must keep its bare argv: it does not accept --session-id"
            );
            assert!(!agent.accepts_session_id());
        }
    }

    #[test]
    fn a_resume_never_carries_a_session_id_flag() {
        // Measured: `--session-id` beside `--resume` is an error unless
        // `--fork-session` is given, and forking is not what we want.
        let id = "15c76662-2409-4f37-bd81-fd4f1b3053dd";
        for agent in AgentKind::ALL {
            for full in [false, true] {
                let argv = agent.launch_argv(Launch::Resume(id), full);
                assert!(
                    !argv.iter().any(|a| a == "--session-id"),
                    "{agent} resume (full={full}) must not carry --session-id: {argv:?}"
                );
            }
        }
    }

    #[test]
    fn an_unpinned_new_session_carries_no_id() {
        // The Windows interactive launch: bare argv, exactly as before.
        for agent in AgentKind::ALL {
            assert_eq!(
                agent.launch_argv(Launch::NewUnpinned, false),
                agent.new_argv()
            );
            assert!(!agent
                .launch_argv(Launch::NewUnpinned, false)
                .iter()
                .any(|a| a == "--session-id"));
        }
    }

    #[test]
    fn launched_session_id_reports_only_a_pinned_id() {
        let id = "15c76662-2409-4f37-bd81-fd4f1b3053dd";
        // A resume always pins.
        for agent in AgentKind::ALL {
            assert_eq!(agent.launched_session_id(Launch::Resume(id)), Some(id));
        }
        // A new session pins only where the CLI takes the flag.
        for agent in [AgentKind::Claude, AgentKind::Grok] {
            assert_eq!(agent.launched_session_id(Launch::New(id)), Some(id));
        }
        for agent in [AgentKind::Codex, AgentKind::Pi] {
            assert_eq!(agent.launched_session_id(Launch::New(id)), None);
        }
        assert_eq!(
            AgentKind::Claude.launched_session_id(Launch::NewUnpinned),
            None
        );
    }
}

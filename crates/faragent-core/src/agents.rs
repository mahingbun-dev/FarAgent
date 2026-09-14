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

    /// Argv for a new or idle-resume launch. When `full_permissions` is true,
    /// appends that agent's bypass flag (Codex inserts it before `resume`).
    pub fn launch_argv(self, session_id: Option<&str>, full_permissions: bool) -> Vec<String> {
        let mut argv = match session_id {
            None => self.new_argv(),
            Some(id) => self.resume_argv(id),
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

pub fn new_session_id() -> String {
    let raw = uuid::Uuid::new_v4().simple().to_string();
    raw[..12].to_string()
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
            assert_eq!(agent.launch_argv(None, false), agent.new_argv());
            assert_eq!(agent.launch_argv(Some("abc"), false), agent.resume_argv("abc"));
        }
    }

    #[test]
    fn launch_argv_full_permissions_per_agent() {
        assert_eq!(
            AgentKind::Claude.launch_argv(None, true),
            vec!["claude", "--permission-mode", "bypassPermissions"]
        );
        assert_eq!(
            AgentKind::Claude.launch_argv(Some("abc"), true),
            vec!["claude", "--resume", "abc", "--permission-mode", "bypassPermissions"]
        );
        assert_eq!(
            AgentKind::Codex.launch_argv(None, true),
            vec!["codex", "--dangerously-bypass-approvals-and-sandbox"]
        );
        assert_eq!(
            AgentKind::Codex.launch_argv(Some("abc"), true),
            vec![
                "codex",
                "--dangerously-bypass-approvals-and-sandbox",
                "resume",
                "abc"
            ]
        );
        assert_eq!(
            AgentKind::Grok.launch_argv(None, true),
            vec!["grok", "--always-approve"]
        );
        assert_eq!(
            AgentKind::Grok.launch_argv(Some("abc"), true),
            vec!["grok", "--resume", "abc", "--always-approve"]
        );
        assert_eq!(AgentKind::Pi.launch_argv(None, true), vec!["pi"]);
        assert_eq!(
            AgentKind::Pi.launch_argv(Some("abc"), true),
            vec!["pi", "--session", "abc"]
        );
    }
}

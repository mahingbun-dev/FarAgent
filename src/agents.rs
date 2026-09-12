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

    #[allow(dead_code)]
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

    /// Native CLI argv to start a new conversation (kept in sync with remote.py).
    #[allow(dead_code)]
    pub fn new_argv(self) -> Vec<String> {
        vec![self.bin().to_string()]
    }

    /// Native CLI argv to resume a disk session. Never used when tmux is live.
    #[allow(dead_code)]
    pub fn resume_argv(self, session_id: &str) -> Vec<String> {
        match self {
            Self::Claude => vec!["claude".into(), "--resume".into(), session_id.into()],
            Self::Codex => vec!["codex".into(), "resume".into(), session_id.into()],
            Self::Grok => vec!["grok".into(), "--resume".into(), session_id.into()],
            Self::Pi => vec!["pi".into(), "--session".into(), session_id.into()],
        }
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

pub fn tmux_name(agent: AgentKind, session_id: &str) -> String {
    format!("farssh-{}-{}", agent.slug(), short_id(session_id))
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
        assert!(name.starts_with("farssh-grok-"));
        let suffix = name.strip_prefix("farssh-grok-").unwrap();
        assert!(suffix.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(suffix.len(), 12);
        assert_eq!(short_id(id), suffix);
    }

    #[test]
    fn new_argv_is_bare_binary() {
        for agent in AgentKind::ALL {
            assert_eq!(agent.new_argv(), vec![agent.bin()]);
        }
    }
}

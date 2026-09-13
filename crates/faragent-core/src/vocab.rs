//! The small enums every layer speaks: how FarAgent authenticates to a host,
//! and which dialect a remote speaks.

use serde::{Deserialize, Serialize};

/// How FarAgent is allowed to authenticate to a host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// Key first (BatchMode). If the server only offers password, say so and
    /// offer an interactive login instead of guessing.
    #[default]
    Auto,
    /// Key / ssh-agent only. Never prompts, fails fast.
    Key,
    /// Password / keyboard-interactive. Prompts once through OpenSSH, then
    /// multiplexes every later command over the ControlMaster socket.
    Password,
}

impl AuthMode {
    pub const ALL: [AuthMode; 3] = [Self::Auto, Self::Key, Self::Password];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "key" | "keys" | "publickey" | "pubkey" => Some(Self::Key),
            "password" | "passwd" | "pw" | "interactive" | "keyboard-interactive" => {
                Some(Self::Password)
            }
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Key => "key",
            Self::Password => "password",
        }
    }
}

/// Which dialect the remote speaks. Posix = bash + tmux (Linux, macOS, WSL);
/// Windows = cmd.exe default shell + PowerShell payloads, no tmux.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostOs {
    #[default]
    Posix,
    Windows,
}

impl HostOs {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "posix" | "linux" | "darwin" | "macos" | "unix" | "wsl" => Some(Self::Posix),
            "windows" | "win" | "win32" => Some(Self::Windows),
            _ => None,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Self::Posix => "posix",
            Self::Windows => "windows",
        }
    }
}

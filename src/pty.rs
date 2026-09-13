//! Hand the local tty to `ssh -tt` and restore the manager TUI afterwards.

use crate::ssh::{self, Client};
use anyhow::Result;
use crossterm::{
    execute,
    terminal::{disable_raw_mode, LeaveAlternateScreen},
};
use std::io::{self, Write};
use std::process::{Command, Stdio};

/// Drop ratatui/crossterm, attach to a remote tmux session, then return.
pub fn attach_tmux(host: &str, tmux_name: &str) -> Result<i32> {
    run_remote_script(host, &attach_script(tmux_name))
}

/// Socket + conf follow the session name so pre-rename live panes still attach.
pub fn attach_script(tmux_name: &str) -> String {
    let name_q = ssh::shell_single_quote(tmux_name);
    let (sock, conf) = if tmux_name.starts_with("farssh-") {
        ("farssh", "$HOME/.farssh/tmux.conf")
    } else {
        ("faragent", "$HOME/.faragent/tmux.conf")
    };
    format!("exec tmux -L {sock} -f \"{conf}\" attach -t {name_q}")
}

/// Hand the local tty to `ssh -tt` running a login-shell script. No exec timeout:
/// installers and sudo password prompts can take minutes.
pub fn run_remote_script(host: &str, script: &str) -> Result<i32> {
    restore_tty()?;
    let client = Client::new(host)?;
    let mut cmd = Command::new("ssh");
    for arg in ssh::base_args(&ssh::control_path()?) {
        cmd.arg(arg);
    }
    cmd.arg("-tt");
    cmd.arg(&client.host);
    cmd.arg("--");
    cmd.arg(ssh::bash_login_command(script));
    cmd.stdin(Stdio::inherit());
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());
    let status = cmd.status()?;
    Ok(status.code().unwrap_or(1))
}

pub fn restore_tty() -> Result<()> {
    let _ = disable_raw_mode();
    let mut out = io::stdout();
    execute!(out, LeaveAlternateScreen)?;
    let _ = execute!(out, crossterm::cursor::Show);
    out.flush().ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::attach_script;

    #[test]
    fn attach_script_uses_new_socket() {
        let s = attach_script("faragent-grok-abc123abc123");
        assert!(s.contains("tmux -L faragent"));
        assert!(s.contains("$HOME/.faragent/tmux.conf"));
        assert!(!s.contains("-L farssh"));
    }

    #[test]
    fn attach_script_uses_legacy_socket() {
        let s = attach_script("farssh-grok-abc123abc123");
        assert!(s.contains("tmux -L farssh"));
        assert!(s.contains("$HOME/.farssh/tmux.conf"));
        assert!(!s.contains("-L faragent"));
    }
}

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
    restore_tty()?;
    let client = Client::new(host)?;
    let name_q = ssh::shell_single_quote(tmux_name);
    let script = format!("exec tmux -L farssh -f \"$HOME/.farssh/tmux.conf\" attach -t {name_q}");
    let mut cmd = Command::new("ssh");
    for arg in ssh::base_args(&ssh::control_path()?) {
        cmd.arg(arg);
    }
    cmd.arg("-tt");
    cmd.arg(&client.host);
    cmd.arg("--");
    cmd.arg(ssh::bash_login_command(&script));
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

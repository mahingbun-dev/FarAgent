//! Hand the local tty to `ssh -tt` and restore the manager TUI afterwards.

use crate::ssh::{self, AuthMode, Client, Flavor};
use crate::text::Lang;
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

/// Foreground agent launch on a Windows remote (no tmux): quitting the agent
/// — or losing ssh — ends the session; resume brings the conversation back.
pub fn attach_win(host: &str, cwd: &str, argv: &[String]) -> Result<i32> {
    run_remote_line(host, &crate::win::attach_launcher(cwd, argv))
}

/// Hands the tty to a PowerShell script (install/upgrade/uninstall plans).
/// No stdin payload: the script rides an EncodedCommand and plans are short
/// by construction, so the command-line stays well under cmd.exe's limit.
pub fn run_remote_ps(host: &str, script: &str) -> Result<i32> {
    run_remote_line(host, &crate::win::encoded_command(script))
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
    run_remote_line(host, &ssh::bash_login_command(script))
}

/// Same handoff, with a caller-built remote command line: POSIX callers pass
/// `bash -lc '…'`, Windows callers a `powershell -EncodedCommand …` launcher.
pub fn run_remote_line(host: &str, remote: &str) -> Result<i32> {
    restore_tty()?;
    let client = Client::new(host)?;
    let flavor = interactive_flavor(client.mode);
    let mut cmd = Command::new("ssh");
    for arg in client.args(flavor) {
        cmd.arg(arg);
    }
    cmd.arg("-tt");
    cmd.arg(&client.host);
    cmd.arg("--");
    cmd.arg(remote);
    crate::askpass::apply(&mut cmd, host);
    cmd.stdin(Stdio::inherit());
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());
    let status = cmd.status()?;
    Ok(status.code().unwrap_or(1))
}

/// Which interactive bundle fits this host: password hosts should not burn
/// their `MaxAuthTries` budget on keys they do not own.
pub fn interactive_flavor(mode: AuthMode) -> Flavor {
    match mode {
        AuthMode::Password => Flavor::InteractivePassword,
        AuthMode::Auto | AuthMode::Key => Flavor::InteractiveKey,
    }
}

/// One interactive `ssh <host> <no-op>` that lets OpenSSH ask for whatever it
/// needs: the host key fingerprint, the account password, or a key passphrase.
///
/// With `ControlMaster=auto`, a successful run leaves a multiplexed master
/// behind, so every later non-interactive probe/exec rides it without asking
/// again. FarAgent itself never reads or stores the password.
pub fn interactive_connect(host: &str, mode: AuthMode, lang: Lang) -> Result<i32> {
    restore_tty()?;
    println!("faragent: {}", ssh::interactive_banner(host).pick(lang));
    let client = Client::with_mode(host, mode)?;
    let flavor = interactive_flavor(mode);
    let mut cmd = Command::new("ssh");
    for arg in client.args(flavor) {
        cmd.arg(arg);
    }
    cmd.arg("-tt");
    cmd.arg(&client.host);
    cmd.arg("--");
    cmd.arg(ssh::REMOTE_PING);
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
    use super::*;

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

    #[test]
    fn password_hosts_prompt_for_a_password_instead_of_keys() {
        assert_eq!(
            interactive_flavor(AuthMode::Password),
            Flavor::InteractivePassword
        );
        assert_eq!(interactive_flavor(AuthMode::Auto), Flavor::InteractiveKey);
        assert_eq!(interactive_flavor(AuthMode::Key), Flavor::InteractiveKey);
    }
}

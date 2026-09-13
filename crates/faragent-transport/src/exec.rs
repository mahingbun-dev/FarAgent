//! Batch-execution helpers over any [`Transport`]: run a login-shell (or
//! PowerShell) script and hand back its stdout as text.

use crate::Transport;
use anyhow::Result;

pub fn run_login(client: &dyn Transport, script: &str) -> Result<String> {
    let output = client.exec_login(script)?;
    if !output.success() {
        client.require_ok(&output)?;
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// PowerShell twin of [`run_login`] for Windows remotes.
pub fn run_win_login(client: &dyn Transport, script: &str) -> Result<String> {
    run_win_login_args(client, script, &[])
}

/// [`run_win_login`] with base64 `$args` for the script.
pub fn run_win_login_args(
    client: &dyn Transport,
    script: &str,
    args_b64: &[&str],
) -> Result<String> {
    let output = client.exec_win(script, args_b64)?;
    if !output.success() {
        client.require_ok(&output)?;
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

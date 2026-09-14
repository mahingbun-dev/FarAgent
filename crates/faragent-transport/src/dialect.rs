//! Remote dialect detection: which shell family answers on the other side.
//! Lives in the transport because the dialect is a property of the
//! connection; the per-host cache lives in `faragent-core`'s config.

use crate::OpenSshTransport;
use anyhow::Result;
use faragent_core::config;
use faragent_core::vocab::HostOs;

/// One round trip every candidate remote shell answers: cmd.exe expands
/// `%OS%`, PowerShell expands `"$env:OS"`, POSIX shells leave both literal.
pub fn os_marker_command() -> &'static str {
    r#"echo FARAGENT_OS_V1 %OS% "$env:OS""#
}

/// `Some(Windows)` when the marker reported `Windows_NT`, `Some(Posix)` when
/// the marker ran but stayed literal. `None` means the marker never appeared
/// (connection failure, exotic shell) — the caller must not cache that.
pub fn parse_os_marker(text: &str) -> Option<HostOs> {
    let lower = text.to_ascii_lowercase();
    if !lower.contains("faragent_os_v1") {
        return None;
    }
    if lower.contains("windows_nt") {
        Some(HostOs::Windows)
    } else {
        Some(HostOs::Posix)
    }
}

/// Which dialect does this host speak? Cached in `~/.faragent/config.json`;
/// on a miss, ask the remote with a marker every candidate shell answers.
/// Inconclusive answers (connection failed, exotic shell) are not cached.
pub fn host_os(host: &str) -> Result<HostOs> {
    if let Some(os) = config::host_os(host) {
        return Ok(os);
    }
    let client = OpenSshTransport::connect(host)?;
    let out = client.exec_raw_line(os_marker_command())?;
    let text = out.text();
    let Some(os) = parse_os_marker(&text) else {
        return Ok(HostOs::Posix);
    };
    let _ = config::set_host_os(host, os);
    Ok(os)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_marker_three_shells() {
        // cmd.exe expands %OS%.
        assert_eq!(
            parse_os_marker("FARAGENT_OS_V1 Windows_NT \"$env:OS\""),
            Some(HostOs::Windows)
        );
        // A PowerShell default shell expands $env:OS.
        assert_eq!(
            parse_os_marker("FARAGENT_OS_V1 %OS% Windows_NT"),
            Some(HostOs::Windows)
        );
        // POSIX shells leave both forms literal.
        assert_eq!(
            parse_os_marker("FARAGENT_OS_V1 %OS% :OS"),
            Some(HostOs::Posix)
        );
        // The marker never ran (connection failure): nothing to cache.
        assert_eq!(
            parse_os_marker("ssh: connect to host port 22: timed out"),
            None
        );
    }

    #[test]
    fn os_marker_command_is_safe_in_every_shell() {
        let cmd = os_marker_command();
        assert!(cmd.contains("FARAGENT_OS_V1"));
        assert!(cmd.contains("%OS%"));
        assert!(cmd.contains("$env:OS"));
        // No single quotes: cmd.exe would print them verbatim.
        assert!(!cmd.contains('\''));
    }
}

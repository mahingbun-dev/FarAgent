//! The connection layer: the `Transport` trait FarAgent's logic drives, and
//! the desktop implementation that wraps the system OpenSSH client. A future
//! in-process transport (russh, for mobile) implements the same trait and is
//! selected in [`open`].

pub mod askpass;
pub mod dialect;
pub mod exec;
pub mod ssh;

pub use dialect::{host_os, os_marker_command, parse_os_marker};
pub use exec::{run_login, run_win_login, run_win_login_args};
pub use ssh::*;

use anyhow::Result;
pub use faragent_core::vocab::AuthMode;
use std::fmt;
use std::io::{Read, Write};

/// Result of one finished remote run, decoupled from `std::process::Output`
/// so a non-OpenSSH transport can fill it too.
#[derive(Debug, Clone)]
pub struct ExecOutput {
    /// Exit code; `None` when the child was killed by a signal.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// stdout on success; stdout + stderr concatenated on failure — the way
    /// the error classifiers read OpenSSH's output.
    pub fn text(&self) -> String {
        let stdout = String::from_utf8_lossy(&self.stdout);
        let stderr = String::from_utf8_lossy(&self.stderr);
        if self.success() {
            stdout.into_owned()
        } else {
            format!("{stdout}{stderr}")
        }
    }
}

/// How to open an interactive stream.
#[derive(Debug, Clone, Copy)]
pub struct AttachOptions {
    pub cols: u16,
    pub rows: u16,
    /// Hand a held password to ssh via askpass. The interactive *login* flow
    /// turns this off on purpose: the user must see OpenSSH's own prompts.
    pub askpass: bool,
}

/// A live interactive session for frontends without a local tty: bytes from
/// the remote agent, bytes to it, and a window size the remote pty can be
/// told about. The desktop implementation is a local PTY running `ssh -tt`;
/// an in-process (russh) transport produces the same shape from a channel.
pub struct AttachStream {
    /// The agent's output.
    pub reader: Box<dyn Read + Send>,
    /// The user's keystrokes.
    pub writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl AttachStream {
    /// Tell the remote pty the new window size (SIGWINCH over there).
    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Wait for the interactive command to exit; returns its code.
    pub fn wait(&mut self) -> anyhow::Result<i32> {
        let status = self.child.wait()?;
        Ok(status.exit_code() as i32)
    }

    /// Kill the child (tab close, app exit).
    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }

    /// Move the read half out (into the GUI's pump thread). Reading is done
    /// once per stream; the placeholder never yields bytes.
    pub fn take_reader(&mut self) -> Box<dyn Read + Send> {
        std::mem::replace(&mut self.reader, Box::new(std::io::empty()))
    }
}

impl Drop for AttachStream {
    /// A dropped stream must not leave an ssh child running.
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// A failed run, kept structured so the UI can show the verbatim error
/// **and** the matching fix instead of a paraphrased one-liner. These are the
/// fields `diagnose` classifies; for a non-OpenSSH transport `command`/`raw`
/// carry that transport's own wording instead of an `ssh` command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    pub host: String,
    pub mode: AuthMode,
    /// Local command line we actually executed (copy-pasteable).
    pub command: String,
    /// Verbatim output (stdout + stderr). Never truncated.
    pub raw: String,
    pub status: Option<i32>,
    pub timed_out: bool,
    /// The server wants an interactive login (password / host key confirm).
    pub needs_auth: bool,
    /// Auth methods the server reported, e.g. `publickey,password`.
    pub methods: String,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let raw = self.raw.trim();
        if raw.is_empty() {
            write!(f, "ssh to {} failed (status {:?})", self.host, self.status)
        } else {
            write!(f, "{raw}")
        }
    }
}

impl std::error::Error for TransportError {}

/// What the rest of FarAgent needs from one connection. Signatures keep
/// `anyhow::Result` (exactly what today's call sites consume and downcast);
/// structured failures travel as [`TransportError`] inside.
pub trait Transport: Send + Sync {
    /// The `Host` alias this connection was made to.
    fn host(&self) -> &str;

    /// The auth mode this connection was built with.
    fn mode(&self) -> AuthMode;

    /// Run a literal command line with **no** local quoting: the remote's
    /// default shell receives it verbatim. Only for lines already safe in
    /// every shell (e.g. the OS marker).
    fn exec_raw_line(&self, line: &str) -> Result<ExecOutput>;

    /// POSIX login shell (`bash -lc`), so nvm / Homebrew PATH is visible.
    fn exec_login(&self, script: &str) -> Result<ExecOutput>;

    /// [`Transport::exec_login`] with a stdin payload (tmux.conf upload).
    fn exec_login_stdin(&self, script: &str, stdin: &[u8]) -> Result<ExecOutput>;

    /// Windows remote: a PowerShell script on stdin, dynamic values as
    /// base64 `$args`.
    fn exec_win(&self, script: &str, args_b64: &[&str]) -> Result<ExecOutput>;

    /// Hand the local tty to an interactive run of `remote_line`; blocks.
    /// The **caller** owns raw-mode / alternate-screen state (restore
    /// before, re-init after).
    fn attach_stdio(&self, remote_line: &str) -> Result<i32>;

    /// Open an interactive run of `remote_line` as byte streams inside a
    /// local PTY — how a GUI attaches without owning a terminal.
    fn attach_stream(&self, remote_line: &str, opts: &AttachOptions) -> Result<AttachStream>;

    /// Structured failure for a finished non-zero run.
    fn error_for(&self, out: &ExecOutput) -> TransportError;

    /// [`Transport::error_for`] as an `Err`, for `?` at call sites.
    fn require_ok(&self, out: &ExecOutput) -> Result<()>;

    /// Ask the server which auth methods it accepts, if cheap to do.
    fn server_auth_methods(&self) -> Option<String>;

    /// Does this connection multiplex (OpenSSH ControlMaster)? Other
    /// transports return false.
    fn muxed(&self) -> bool;

    /// Is a multiplexed master already authenticated for this host?
    fn master_alive(&self) -> bool;
}

/// Build the transport for a host: today always the system-OpenSSH child
/// process with the config-cached auth mode. A mobile build swaps in an
/// in-process transport here.
pub fn open(host: &str) -> Result<OpenSshTransport> {
    OpenSshTransport::connect(host)
}

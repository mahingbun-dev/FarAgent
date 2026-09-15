//! Live interactive sessions: one `ssh -tt` inside a local PTY per attach,
//! streamed to the webview over a Tauri channel. The manager is keyed by
//! session id — the multi-tab foundation; v1 opens one tab at a time.

use crate::dto::{shape_error, CommandError};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use faragent_core::agents::{AgentKind, Launch};
use faragent_core::vocab::HostOs;
use faragent_remote::{remote as remote_proto, win};
use faragent_transport::{
    bash_login_command, AttachOptions, AttachStream, OpenSshTransport, REMOTE_PING,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;

/// What to run interactively. The backend builds the remote command line —
/// the frontend never composes shell text.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachSpec {
    /// Attach a remote tmux session (POSIX live or idle).
    Tmux { tmux_name: String },
    /// Foreground agent launch on a Windows remote. The backend derives the
    /// argv from the agent tables (resume vs new), so the frontend never
    /// duplicates them.
    WinAgent {
        agent: AgentKind,
        cwd: String,
        session_id: Option<String>,
    },
    /// Run a confirmed install/upgrade/uninstall script.
    Install { script: String, os: HostOs },
    /// First interactive login: host-key and password prompts belong to
    /// OpenSSH itself, so askpass stays off and the user answers in the tab.
    /// The auth mode comes from the host's config, same as every other call.
    Login,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachEvent {
    /// Base64 bytes from the remote (decode to Uint8Array, write to xterm).
    Data { b64: String },
    /// The interactive command finished.
    Exit { code: i32 },
    /// The stream died before/without a clean exit.
    Error { message: String },
}

#[derive(Default)]
pub struct SessionManager {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, AttachStream>>,
}

impl SessionManager {
    /// Spawn the interactive command and start pumping its output into
    /// `on_event`. Returns the session id used by write/resize/close.
    pub fn open(
        &self,
        app: &tauri::AppHandle,
        host: &str,
        spec: &AttachSpec,
        cols: u16,
        rows: u16,
        on_event: Channel<AttachEvent>,
    ) -> Result<u64, CommandError> {
        let (remote_line, askpass) = match spec {
            AttachSpec::Tmux { tmux_name } => (
                bash_login_command(&remote_proto::attach_script(tmux_name)),
                true,
            ),
            AttachSpec::WinAgent {
                agent,
                cwd,
                session_id,
            } => {
                // A Windows foreground launch pins no id (`Launch::NewUnpinned`);
                // a resume is told the caller's own id, unchanged.
                let launch = match session_id.as_deref() {
                    Some(id) => Launch::Resume(id),
                    None => Launch::NewUnpinned,
                };
                let argv = agent.launch_argv(launch, faragent_core::config::full_permissions());
                (win::attach_launcher(cwd, &argv), true)
            }
            AttachSpec::Install { script, os } => match os {
                HostOs::Posix => (bash_login_command(script), true),
                HostOs::Windows => (win::encoded_command(script), true),
            },
            AttachSpec::Login => (REMOTE_PING.to_string(), false),
        };

        let transport = OpenSshTransport::connect(host).map_err(|e| shape_error(&e, host))?;
        let opts = AttachOptions {
            cols,
            rows,
            askpass,
        };
        let mut stream = transport
            .attach_stream(&remote_line, &opts)
            .map_err(|e| shape_error(&e, host))?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut reader = stream.take_reader();
        self.sessions.lock().unwrap().insert(id, stream);

        let app = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let event = AttachEvent::Data {
                            b64: STANDARD.encode(&buf[..n]),
                        };
                        if on_event.send(event).is_err() {
                            break; // the webview went away
                        }
                    }
                    Err(e) => {
                        let _ = on_event.send(AttachEvent::Error {
                            message: e.to_string(),
                        });
                        break;
                    }
                }
            }
            // Reap: remove the session (dropping it kills any straggler) and
            // report the exit code the way the TUI does.
            let state = app.state::<SessionManager>();
            let mut map = state.sessions.lock().unwrap();
            if let Some(mut s) = map.remove(&id) {
                let code = s.wait().unwrap_or(-1);
                let _ = on_event.send(AttachEvent::Exit { code });
            }
        });

        Ok(id)
    }

    pub fn write(&self, id: u64, bytes: &[u8]) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let Some(s) = map.get_mut(&id) else {
            return Err("session is closed".into());
        };
        s.writer.write_all(bytes).map_err(|e| e.to_string())?;
        s.writer.flush().ok();
        Ok(())
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.sessions.lock().unwrap();
        let Some(s) = map.get(&id) else {
            return Ok(()); // already closed: nothing to resize
        };
        s.resize(cols, rows).map_err(|e| e.to_string())
    }

    pub fn close(&self, id: u64) {
        // Dropping the stream kills its child (see AttachStream's Drop).
        self.sessions.lock().unwrap().remove(&id);
    }
}

#[tauri::command]
pub async fn attach_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, SessionManager>,
    host: String,
    spec: AttachSpec,
    cols: u16,
    rows: u16,
    on_event: Channel<AttachEvent>,
) -> Result<u64, CommandError> {
    state.open(&app, &host, &spec, cols, rows, on_event)
}

#[tauri::command]
pub async fn attach_write(
    state: tauri::State<'_, SessionManager>,
    id: u64,
    data: String,
) -> Result<(), CommandError> {
    let bytes = STANDARD.decode(&data).map_err(|e| CommandError::Plain {
        message: format!("bad base64: {e}"),
    })?;
    state
        .write(id, &bytes)
        .map_err(|message| CommandError::Plain { message })
}

#[tauri::command]
pub async fn attach_resize(
    state: tauri::State<'_, SessionManager>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    state
        .resize(id, cols, rows)
        .map_err(|message| CommandError::Plain { message })
}

#[tauri::command]
pub async fn attach_close(
    state: tauri::State<'_, SessionManager>,
    id: u64,
) -> Result<(), CommandError> {
    state.close(id);
    Ok(())
}

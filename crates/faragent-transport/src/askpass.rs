//! Password memory for machines whose ssh cannot multiplex (Win32 OpenSSH).
//!
//! The user types a password once into faragent; it is held in this process
//! only (zeroized on exit, never written to disk) and handed to OpenSSH
//! through `SSH_ASKPASS`: ssh launches this same binary with the prompt as
//! argv[1], and the child fetches the secret over a loopback socket guarded
//! by a single-use token. OpenSSH 8.4+ needs `SSH_ASKPASS_REQUIRE=force` to
//! consult askpass even when a terminal exists; Win11 ships a newer ssh.
//! macOS/Linux keep the ControlMaster flow and never install a session here.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use zeroize::Zeroizing;

const ENV_CHILD: &str = "FARAGENT_INTERNAL";
const ENV_PORT: &str = "FARAGENT_ASKPASS_PORT";
const ENV_TOKEN: &str = "FARAGENT_ASKPASS_TOKEN";
/// One ssh connection may ask more than once (auth retries); stop answering
/// far beyond that so a stale listener cannot serve the password forever.
const MAX_SERVES: usize = 8;

struct Session {
    password: Zeroizing<String>,
    token: String,
    port: u16,
    generation: u64,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Keep `password` for `host` in this process and start answering askpass
/// requests for it. Returns `(port, token)` — used by tests and diagnostics.
pub fn install_session(host: &str, password: String) -> Option<(u16, String)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    sessions().lock().unwrap().insert(
        host.to_string(),
        Session {
            password: Zeroizing::new(password),
            token: token.clone(),
            port,
            generation,
        },
    );
    std::thread::spawn(move || serve(listener, generation));
    Some((port, token))
}

/// Is a password held for this host (and usable for new ssh commands)?
pub fn active_for(host: &str) -> bool {
    sessions().lock().unwrap().contains_key(host)
}

/// Forget every held password (zeroized) and stop answering. Called when the
/// TUI exits; askpass children started earlier simply fail from now on.
pub fn clear() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    sessions().lock().unwrap().clear();
}

/// The askpass environment for this host's ssh child, when a password is
/// held: variables point back at this binary; the token/port identify the
/// session's loopback socket. Empty when nothing is held (or the executable
/// path cannot be resolved).
pub fn env_for(host: &str) -> Vec<(String, String)> {
    let guard = sessions().lock().unwrap();
    let Some(session) = guard.get(host) else {
        return Vec::new();
    };
    let Ok(exe) = std::env::current_exe() else {
        return Vec::new();
    };
    vec![
        (ENV_CHILD.into(), "askpass".into()),
        ("SSH_ASKPASS".into(), exe.to_string_lossy().into_owned()),
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        (ENV_PORT.into(), session.port.to_string()),
        (ENV_TOKEN.into(), session.token.clone()),
    ]
}

/// Give this ssh command access to the held password.
pub fn apply(cmd: &mut Command, host: &str) {
    for (k, v) in env_for(host) {
        cmd.env(k, v);
    }
}

fn serve(listener: TcpListener, generation: u64) {
    let mut served = 0usize;
    for stream in listener.incoming() {
        if served >= MAX_SERVES || !generation_alive(generation) {
            return;
        }
        let Ok(mut stream) = stream else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let Ok(reader_side) = stream.try_clone() else {
            continue;
        };
        let mut token = String::new();
        if BufReader::new(reader_side).read_line(&mut token).is_err() {
            continue;
        }
        let guard = sessions().lock().unwrap();
        let Some(session) = guard.values().find(|s| s.generation == generation) else {
            continue;
        };
        if token.trim_end() != session.token {
            continue;
        }
        if stream.write_all(session.password.as_bytes()).is_ok() && stream.write_all(b"\n").is_ok()
        {
            served += 1;
        }
    }
}

/// Is the session this listener belongs to still installed? Replacing one
/// host's password or clearing everything retires exactly those listeners;
/// other hosts keep serving.
fn generation_alive(generation: u64) -> bool {
    sessions()
        .lock()
        .unwrap()
        .values()
        .any(|s| s.generation == generation)
}

/// Is this process an OpenSSH askpass child rather than the CLI?
pub fn is_child() -> bool {
    std::env::var_os(ENV_CHILD).is_some()
}

/// Answer only literal password prompts. Host-key confirmations, key
/// passphrases, and verification codes must fail (exit 1, no output) so
/// OpenSSH's own guarded flows and `faragent login` keep handling them.
pub fn should_answer(prompt: &str) -> bool {
    let p = prompt.to_ascii_lowercase();
    p.contains("password") && !p.contains("passphrase")
}

/// Child entry point: OpenSSH calls `faragent "<prompt>"`.
pub fn run_child(args: &[String]) -> i32 {
    let prompt = args.first().map(String::as_str).unwrap_or("");
    if !should_answer(prompt) {
        return 1;
    }
    let (Ok(port), Ok(token)) = (
        std::env::var(ENV_PORT)
            .and_then(|p| p.parse::<u16>().map_err(|_| std::env::VarError::NotPresent)),
        std::env::var(ENV_TOKEN),
    ) else {
        return 1;
    };
    let Some(password) = fetch(port, &token) else {
        return 1;
    };
    let mut out = std::io::stdout();
    if writeln!(out, "{password}").is_err() || out.flush().is_err() {
        return 1;
    }
    0
}

fn fetch(port: u16, token: &str) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream.write_all(token.as_bytes()).ok()?;
    stream.write_all(b"\n").ok()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).ok()?;
    let line = line.trim_end_matches(['\r', '\n']).to_string();
    (!line.is_empty()).then_some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_only_password_prompts() {
        assert!(should_answer("user@host's password: "));
        assert!(should_answer("Password:"));
        assert!(!should_answer(
            "Enter passphrase for key '/home/me/.ssh/id_ed25519': "
        ));
        assert!(!should_answer(
            "Are you sure you want to continue connecting (yes/no/[fingerprint])?"
        ));
        assert!(!should_answer("Verification code: "));
        assert!(!should_answer(""));
    }

    #[test]
    fn loopback_serves_valid_tokens_and_clear_stops_it() {
        // The sessions are process-global; keep every probe in one test so
        // parallel tests cannot race on them.
        let (port, token) = install_session("devbox", "hunter2".into()).unwrap();
        assert!(active_for("devbox"));
        assert!(!active_for("other"));
        assert_eq!(fetch(port, &token).as_deref(), Some("hunter2"));
        // A wrong token gets nothing.
        assert_eq!(fetch(port, "wrong"), None);
        // A second host holds its own password.
        let (port2, token2) = install_session("nas", "swordfish".into()).unwrap();
        assert_eq!(fetch(port, &token).as_deref(), Some("hunter2"));
        assert_eq!(fetch(port2, &token2).as_deref(), Some("swordfish"));

        clear();
        assert!(!active_for("devbox"));
        assert_eq!(fetch(port2, &token2), None);
    }

    #[test]
    fn child_refuses_non_password_prompts_without_a_session() {
        assert_eq!(
            run_child(&["Are you sure you want to continue (yes/no)?".into()]),
            1
        );
        // Password prompt but no session env: still a silent failure.
        assert_eq!(run_child(&["Password:".into()]), 1);
    }
}

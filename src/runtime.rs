use crate::agents::{self, AgentKind};
use crate::ssh::Client;
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const REMOTE_PY: &str = include_str!("remote.py");

const WRITE_HELPER: &str = r#"python3 -c "import pathlib,sys; d=pathlib.Path.home()/'.farssh'; d.mkdir(parents=True, exist_ok=True); (d/'remote.py').write_bytes(sys.stdin.buffer.read())""#;

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub agent: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub mtime: f64,
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub tmux: Option<String>,
}

impl SessionSummary {
    pub fn label(&self) -> String {
        let mark = if self.live { "live" } else { "idle" };
        let title = self
            .title
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.id);
        let cwd = self.cwd.as_deref().unwrap_or("?");
        format!("[{mark}]  {title}  ({cwd})")
    }
}

pub fn helper_hash() -> String {
    let mut h = Sha256::new();
    h.update(REMOTE_PY.as_bytes());
    hex::encode(h.finalize())
}

fn hash_check_script() -> &'static str {
    r#"python3 - <<'PY'
import pathlib, hashlib
p = pathlib.Path.home() / ".farssh" / "remote.py"
print("missing" if not p.exists() else hashlib.sha256(p.read_bytes()).hexdigest())
PY"#
}

pub fn ensure_helper(client: &Client) -> Result<()> {
    let hash = helper_hash();
    let out = client.exec_login(hash_check_script())?;
    let remote_hash = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if remote_hash == hash {
        let _ = remote_json(client, &["ensure"]);
        return Ok(());
    }
    let write = client.exec_login_stdin(WRITE_HELPER, REMOTE_PY.as_bytes())?;
    if !write.status.success() {
        let msg = Client::output_text(&write);
        if msg.contains("python3") && (msg.contains("not found") || msg.contains("No such")) {
            return Err(anyhow!(
                "python3 is required on the remote host to probe agents and sessions"
            ));
        }
        Client::require_ok(&write)?;
    }
    let verify = client.exec_login(hash_check_script())?;
    Client::require_ok(&verify)?;
    let got = String::from_utf8_lossy(&verify.stdout).trim().to_string();
    if got != hash {
        return Err(anyhow!(
            "failed to install ~/.farssh/remote.py (got {got})"
        ));
    }
    let _ = remote_json(client, &["ensure"])?;
    Ok(())
}

pub fn remote_json(client: &Client, args: &[&str]) -> Result<Value> {
    let mut script = String::from("python3 \"$HOME/.farssh/remote.py\"");
    for a in args {
        script.push(' ');
        script.push_str(&crate::ssh::shell_single_quote(a));
    }
    let output = client.exec_login(&script)?;
    if !output.status.success() {
        Client::require_ok(&output)?;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with('{'))
        .ok_or_else(|| {
            anyhow!(
                "remote helper did not print JSON: {}",
                stdout.trim().chars().take(400).collect::<String>()
            )
        })?;
    serde_json::from_str(line).context("parse remote JSON")
}

pub fn list_sessions(host: &str, agent: AgentKind) -> Result<Vec<SessionSummary>> {
    let client = Client::new(host)?;
    ensure_helper(&client)?;
    let value = remote_json(&client, &["list", "--agent", agent.slug()])?;
    if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        return Err(anyhow!("list failed: {value}"));
    }
    let sessions = value
        .get("sessions")
        .cloned()
        .unwrap_or(Value::Array(vec![]));
    serde_json::from_value(sessions).context("session list shape")
}

#[derive(Debug, Deserialize)]
struct StartResult {
    pub ok: bool,
    #[serde(default)]
    pub tmux: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub hint: Option<String>,
}

/// Create a detached tmux session if needed. If it already exists, only attach later.
pub fn ensure_tmux_session(
    host: &str,
    agent: AgentKind,
    cwd: &Path,
    session_id: Option<&str>,
) -> Result<String> {
    let client = Client::new(host)?;
    ensure_helper(&client)?;
    let sid = session_id
        .map(|s| s.to_string())
        .unwrap_or_else(agents::new_session_id);
    let name = agents::tmux_name(agent, &sid);
    let cwd_s = cwd.to_string_lossy().into_owned();
    let mut args = vec![
        "start".to_string(),
        "--agent".into(),
        agent.slug().into(),
        "--cwd".into(),
        cwd_s,
        "--tmux".into(),
        name.clone(),
    ];
    if let Some(id) = session_id {
        args.push("--session-id".into());
        args.push(id.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = remote_json(&client, &arg_refs)?;
    let result: StartResult = serde_json::from_value(value).context("start result")?;
    if !result.ok {
        let err = result.error.unwrap_or_else(|| "start_failed".into());
        let hint = result.hint.unwrap_or_default();
        return Err(anyhow!("{err}: {hint}"));
    }
    Ok(result.tmux.unwrap_or(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_hash_is_stable_sha256() {
        let h = helper_hash();
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn remote_py_is_embedded() {
        assert!(REMOTE_PY.contains("TMUX_SOCKET = \"farssh\""));
        assert!(REMOTE_PY.contains("def probe"));
        assert!(REMOTE_PY.contains("\"codex\", \"resume\""));
    }

    #[test]
    fn remote_py_syntax() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/remote.py");
        let status = std::process::Command::new("python3")
            .args(["-m", "py_compile"])
            .arg(&path)
            .status()
            .expect("python3");
        assert!(status.success());
    }
}

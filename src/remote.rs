//! Remote side is POSIX `bash` + `tmux` only. All JSON / session logic runs here.

use crate::agents::AgentKind;
use crate::ssh;
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TMUX_SOCKET: &str = "faragent";
/// Pre-rename isolated tmux server; list/attach still query it.
pub const LEGACY_TMUX_SOCKET: &str = "farssh";

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

/// The one command the "create the missing directory" confirmation runs on
/// the remote, per dialect.
pub fn new_dir_command(dir: &str, os: HostOs) -> String {
    match os {
        HostOs::Posix => format!("mkdir -p {dir}"),
        HostOs::Windows => format!("New-Item -ItemType Directory -Force -LiteralPath '{dir}'"),
    }
}

pub const TMUX_CONF: &str = r#"# Managed by faragent. Applies only to sessions started with -f this file.
set -g prefix C-g
unbind C-b
bind C-g send-prefix
bind g detach-client
bind d detach-client
set -g mouse on
set -g default-terminal "tmux-256color"
set -as terminal-features ",*:RGB"
set -g status-position top
set -g status-left-length 64
set -g status-left " #[bold]faragent#[default]  prefix C-g · C-g d detach "
set -g status-right " #{session_name} "
set -g history-limit 50000
set -g set-clipboard on
set -wg allow-passthrough on
set -g extended-keys on
set -g update-environment "TERM COLORTERM"
"#;

#[derive(Debug, Clone, Deserialize)]
pub struct Probe {
    pub home: String,
    #[serde(default)]
    pub os: HostOs,
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
    pub path: String,
    pub tmux: TmuxProbe,
    pub agents: Vec<AgentProbe>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TmuxProbe {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentProbe {
    pub id: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    #[serde(default)]
    pub auth_hint: String,
}

impl Probe {
    pub fn agent(&self, kind: AgentKind) -> Option<&AgentProbe> {
        self.agents.iter().find(|a| a.id == kind.slug())
    }
}

pub struct JsonlMeta {
    pub title: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DiskFile {
    pub agent: String,
    pub id: String,
    pub mtime: f64,
    pub cwd_hint: String,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ListDump {
    pub tmux: Vec<(String, String)>,
    pub files: Vec<DiskFile>,
    /// `(agent, session-id-or-empty)` from the process scan (Windows remotes;
    /// while tmux-less, this is the closest thing to a live marker).
    pub procs: Vec<(String, String)>,
}

pub enum StartOutcome {
    Ok { name: String },
    Err { error: String, hint: String },
}

pub fn write_tmux_conf_script() -> &'static str {
    r#"mkdir -p "$HOME/.faragent" && cat > "$HOME/.faragent/tmux.conf""#
}

pub fn probe_script() -> &'static str {
    r#"
printf 'FARAGENT_PROBE_V1\n'
printf 'os\tposix\n'
printf 'home\t%s\n' "$HOME"
printf 'user\t%s\n' "${USER:-${LOGNAME:-}}"
printf 'shell\t%s\n' "${SHELL:-}"
printf 'path\t%s\n' "$PATH"

ver_of() {
  _bin="$1"
  _out=$("$_bin" --version 2>&1 | head -n 1)
  if [ -z "$_out" ]; then
    _out=$("$_bin" -V 2>&1 | head -n 1)
  fi
  printf '%s' "$_out" | tr '\t\n\r' '   ' | cut -c1-160
}

auth_of() {
  case "$1" in
    grok)
      [ -s "$HOME/.grok/auth.json" ] && { echo ok; return; }
      ;;
    claude)
      [ -s "$HOME/.claude.json" ] && { echo ok; return; }
      [ -s "$HOME/.claude/.credentials.json" ] && { echo ok; return; }
      [ -s "$HOME/.claude/credentials.json" ] && { echo ok; return; }
      ;;
    codex)
      [ -s "$HOME/.codex/auth.json" ] && { echo ok; return; }
      [ -s "$HOME/.codex/config.toml" ] && { echo ok; return; }
      ;;
    pi)
      [ -s "$HOME/.pi/agent/auth.json" ] && { echo ok; return; }
      [ -s "$HOME/.pi/agent/settings.json" ] && { echo ok; return; }
      ;;
  esac
  echo unknown
}

tp=$(command -v tmux 2>/dev/null || true)
printf 'tmux_path\t%s\n' "$tp"
if [ -n "$tp" ]; then
  printf 'tmux_version\t%s\n' "$(ver_of tmux)"
else
  printf 'tmux_version\t\n'
fi

for a in claude codex grok pi; do
  p=$(command -v "$a" 2>/dev/null || true)
  if [ -n "$p" ]; then
    printf 'agent\t%s\t%s\t%s\t%s\n' "$a" "$p" "$(ver_of "$a")" "$(auth_of "$a")"
  else
    printf 'agent\t%s\t\t\tmissing\n' "$a"
  fi
done
"#
}

pub fn list_script(agent: AgentKind) -> String {
    let mut s = format!(
        r#"
printf 'FARAGENT_LIST_V1\n'
mtime_of() {{
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}}
emit_file() {{
  _agent="$1"
  _id="$2"
  _src="$3"
  _cwd="$4"
  _mt=$(mtime_of "$_src")
  _id=$(printf '%s' "$_id" | tr '\t\n\r' '   ')
  _cwd=$(printf '%s' "$_cwd" | tr '\t\n\r' '   ')
  _b64=
  if [ -f "$_src" ] && command -v base64 >/dev/null 2>&1; then
    _b64=$(dd if="$_src" bs=1024 count=8 2>/dev/null | base64 | tr -d '\n\r ')
  fi
  printf 'file\t%s\t%s\t%s\t%s\t%s\n' "$_agent" "$_id" "$_mt" "$_cwd" "$_b64"
}}
if command -v tmux >/dev/null 2>&1; then
  tmux -L {sock} -f "$HOME/.faragent/tmux.conf" list-sessions -F 'tmux	#{{session_name}}	#{{pane_current_path}}' 2>/dev/null || true
  tmux -L {legacy} list-sessions -F 'tmux	#{{session_name}}	#{{pane_current_path}}' 2>/dev/null || true
fi
"#,
        sock = TMUX_SOCKET,
        legacy = LEGACY_TMUX_SOCKET
    );
    match agent {
        AgentKind::Grok => s.push_str(
            r#"
if [ -d "$HOME/.grok/sessions" ]; then
  find "$HOME/.grok/sessions" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | head -n 200 | while IFS= read -r siddir; do
    [ -n "$siddir" ] || continue
    sid=$(basename "$siddir")
    cwdenc=$(basename "$(dirname "$siddir")")
    if [ -f "$siddir/summary.json" ]; then
      emit_file grok "$sid" "$siddir/summary.json" "$cwdenc"
    else
      printf 'file\tgrok\t%s\t%s\t%s\t\n' "$sid" "$(mtime_of "$siddir")" "$cwdenc"
    fi
  done
fi
"#,
        ),
        AgentKind::Claude => s.push_str(
            r#"
if [ -d "$HOME/.claude/projects" ]; then
  find "$HOME/.claude/projects" -maxdepth 2 -type f -name '*.jsonl' 2>/dev/null | head -n 200 | while IFS= read -r f; do
    case "$f" in
      *.orphaned-*|*.superseded-*) continue ;;
    esac
    sid=$(basename "$f" .jsonl)
    slug=$(basename "$(dirname "$f")")
    emit_file claude "$sid" "$f" "$slug"
  done
fi
"#,
        ),
        AgentKind::Codex => s.push_str(
            r#"
if [ -d "$HOME/.codex/sessions" ]; then
  find "$HOME/.codex/sessions" -type f -name '*.jsonl' 2>/dev/null | head -n 200 | while IFS= read -r f; do
    sid=$(basename "$f" .jsonl)
    emit_file codex "$sid" "$f" ""
  done
fi
"#,
        ),
        AgentKind::Pi => s.push_str(
            r#"
if [ -d "$HOME/.pi/agent/sessions" ]; then
  root="$HOME/.pi/agent/sessions"
  find "$root" -type f \( -name '*.jsonl' -o -name '*.json' \) 2>/dev/null | head -n 200 | while IFS= read -r f; do
    sid=$(basename "$f")
    sid=${sid%.*}
    rel="${f#"$root"/}"
    cwdenc="${rel%%/*}"
    emit_file pi "$sid" "$f" "$cwdenc"
  done
fi
"#,
        ),
    }
    s
}

pub fn start_script(
    agent: AgentKind,
    cwd: &str,
    session_id: Option<&str>,
    tmux_name: &str,
    create_cwd: bool,
) -> String {
    let argv = match session_id {
        Some(id) => agent.resume_argv(id),
        None => agent.new_argv(),
    };
    let inner = format!(
        "exec {}",
        argv.iter()
            .map(|a| ssh::shell_single_quote(a))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let agent_q = ssh::shell_single_quote(agent.slug());
    let cwd_q = ssh::shell_single_quote(cwd);
    let name_q = ssh::shell_single_quote(tmux_name);
    let legacy_name = tmux_name
        .strip_prefix("faragent-")
        .map(|rest| format!("farssh-{rest}"))
        .unwrap_or_default();
    let legacy_q = ssh::shell_single_quote(&legacy_name);
    let inner_q = ssh::shell_single_quote(&inner);
    format!(
        r#"
printf 'FARAGENT_START_V1\n'
if ! command -v tmux >/dev/null 2>&1; then
  printf 'err\ttmux_missing\ttmux is not on PATH; install it from the FarAgent agent list.\n'
  exit 0
fi
if ! command -v {agent_q} >/dev/null 2>&1; then
  printf 'err\tagent_missing\t{agent_q} is not on PATH in a login shell.\n'
  exit 0
fi
{cwd_block}
if tmux -L {sock} -f "$HOME/.faragent/tmux.conf" has-session -t {name_q} 2>/dev/null; then
  printf 'ok\texists\t%s\n' {name_q}
  exit 0
fi
if [ -n {legacy_q} ] && tmux -L {legacy_sock} has-session -t {legacy_q} 2>/dev/null; then
  printf 'ok\texists\t%s\n' {legacy_q}
  exit 0
fi
_err=$(tmux -L {sock} -f "$HOME/.faragent/tmux.conf" new-session -d -s {name_q} -c {cwd_q} -- bash -lc {inner_q} 2>&1)
_st=$?
if [ "$_st" -ne 0 ]; then
  _err=$(printf '%s' "$_err" | tr '\t\n\r' '   ' | cut -c1-400)
  printf 'err\ttmux_new_failed\t%s\n' "$_err"
  exit 0
fi
printf 'ok\tcreated\t%s\n' {name_q}
"#,
        agent_q = agent_q,
        cwd_q = cwd_q,
        cwd_block = cwd_block(&cwd_q, create_cwd),
        name_q = name_q,
        legacy_q = legacy_q,
        inner_q = inner_q,
        sock = TMUX_SOCKET,
        legacy_sock = LEGACY_TMUX_SOCKET,
    )
}

/// Remote check for the session's working directory.
///
/// The plain form only reports `cwd_missing`, so the TUI can ask the user
/// before anything is written. The `create` form runs `mkdir -p` — but only
/// because the user confirmed on that screen — and turns any failure (missing
/// permissions, read-only mount, a file in the way) into printable text.
fn cwd_block(cwd_q: &str, create: bool) -> String {
    if create {
        format!(
            r#"if [ ! -d {cwd_q} ]; then
  _mkerr=$(mkdir -p -- {cwd_q} 2>&1)
  if [ ! -d {cwd_q} ]; then
    _mkerr=$(printf '%s' "$_mkerr" | tr '\t\n\r' '   ' | cut -c1-400)
    printf 'err\tmkdir_failed\t%s\n' "$_mkerr"
    exit 0
  fi
fi
"#
        )
    } else {
        format!(
            r#"if [ ! -d {cwd_q} ]; then
  printf 'err\tcwd_missing\tNot a directory.\n'
  exit 0
fi
"#
        )
    }
}

pub fn parse_probe(text: &str) -> Result<Probe> {
    let body = after_magic(text, "FARAGENT_PROBE_V1")?;
    let mut home = String::new();
    let mut os = HostOs::default();
    let mut shell = String::new();
    let mut path = String::new();
    let mut tmux_path = String::new();
    let mut tmux_version = String::new();
    let mut agents = Vec::new();
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line == "FARAGENT_PROBE_V1" {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        match cols.first().copied() {
            Some("home") => home = cols.get(1).unwrap_or(&"").to_string(),
            Some("os") => {
                os = cols
                    .get(1)
                    .and_then(|s| HostOs::parse(s))
                    .unwrap_or_default()
            }
            Some("shell") => shell = cols.get(1).unwrap_or(&"").to_string(),
            Some("path") => path = cols.get(1).unwrap_or(&"").to_string(),
            Some("tmux_path") => tmux_path = cols.get(1).unwrap_or(&"").to_string(),
            Some("tmux_version") => tmux_version = cols.get(1).unwrap_or(&"").to_string(),
            Some("agent") if cols.len() >= 5 => {
                let id = cols[1].to_string();
                let p = cols[2].to_string();
                let ver = cols[3].to_string();
                let auth = cols[4].to_string();
                let found = !p.is_empty();
                agents.push(AgentProbe {
                    id,
                    found,
                    path: found.then_some(p),
                    version: (found && !ver.is_empty()).then_some(ver),
                    auth_hint: if found { auth } else { "missing".into() },
                });
            }
            _ => {}
        }
    }
    if home.is_empty() {
        return Err(anyhow!("probe did not include home: {}", snippet(text)));
    }
    Ok(Probe {
        home,
        os,
        shell,
        path,
        tmux: TmuxProbe {
            found: !tmux_path.is_empty(),
            version: (!tmux_version.is_empty()).then_some(tmux_version),
            path: (!tmux_path.is_empty()).then_some(tmux_path),
        },
        agents,
    })
}

pub fn parse_list(text: &str) -> Result<ListDump> {
    let body = after_magic(text, "FARAGENT_LIST_V1")?;
    let mut tmux = Vec::new();
    let mut files = Vec::new();
    let mut procs = Vec::new();
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line == "FARAGENT_LIST_V1" {
            continue;
        }
        let kind = line.split('\t').next().unwrap_or("");
        match kind {
            "tmux" => {
                let cols: Vec<&str> = line.splitn(3, '\t').collect();
                if cols.len() >= 2 {
                    let name = cols[1].to_string();
                    let cwd = cols.get(2).unwrap_or(&"").to_string();
                    if !name.is_empty() {
                        tmux.push((name, cwd));
                    }
                }
            }
            "proc" => {
                let cols: Vec<&str> = line.splitn(3, '\t').collect();
                if cols.len() >= 2 && !cols[1].is_empty() {
                    procs.push((cols[1].to_string(), cols.get(2).unwrap_or(&"").to_string()));
                }
            }
            "file" => {
                let cols: Vec<&str> = line.splitn(6, '\t').collect();
                if cols.len() >= 4 {
                    files.push(DiskFile {
                        agent: cols[1].to_string(),
                        id: cols[2].to_string(),
                        mtime: cols[3].parse().unwrap_or(0.0),
                        cwd_hint: cols.get(4).unwrap_or(&"").to_string(),
                        body: decode_b64(cols.get(5).unwrap_or(&"")),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(ListDump { tmux, files, procs })
}

pub fn parse_start(text: &str) -> Result<StartOutcome> {
    let body = after_magic(text, "FARAGENT_START_V1")?;
    let mut last: Option<StartOutcome> = None;
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        let cols: Vec<&str> = line.splitn(3, '\t').collect();
        match cols.first().copied() {
            Some("ok") if cols.len() >= 3 => {
                last = Some(StartOutcome::Ok {
                    name: cols[2].to_string(),
                });
            }
            Some("err") if cols.len() >= 2 => {
                last = Some(StartOutcome::Err {
                    error: cols[1].to_string(),
                    hint: cols.get(2).unwrap_or(&"").to_string(),
                });
            }
            _ => {}
        }
    }
    last.ok_or_else(|| anyhow!("start did not print ok/err: {}", snippet(text)))
}

pub fn jsonl_meta(body: &[u8], limit: usize) -> JsonlMeta {
    let text = String::from_utf8_lossy(body);
    let mut title = None;
    let mut cwd = None;
    for (i, line) in text.lines().enumerate() {
        if i >= limit {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = json_str(&obj, "cwd")
                .or_else(|| json_str(&obj, "cwd_path"))
                .or_else(|| {
                    obj.get("environment_context")
                        .and_then(|v| v.as_str())
                        .and_then(extract_cwd_tag)
                        .map(|s| s.to_string())
                });
        }
        if title.is_none() {
            if let Some(text) = message_text(&obj) {
                let first = text.trim().lines().next().unwrap_or("").trim();
                if !first.is_empty() && !first.starts_with('<') {
                    title = Some(first.chars().take(80).collect());
                }
            }
        }
        if title.is_some() && cwd.is_some() {
            break;
        }
    }
    JsonlMeta { title, cwd }
}

pub fn grok_summary_meta(body: &[u8], cwd_hint: &str) -> (Option<String>, Option<String>) {
    let decoded = percent_decode(cwd_hint);
    let fallback_cwd = (!decoded.is_empty()).then_some(decoded);
    let Ok(obj) = serde_json::from_slice::<Value>(body) else {
        return (None, fallback_cwd);
    };
    let title = ["generated_title", "session_summary", "last_turn_summary"]
        .iter()
        .find_map(|k| json_str(&obj, k))
        .map(|t| {
            t.trim()
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect()
        })
        .filter(|t: &String| !t.is_empty());
    let cwd = json_str(&obj, "git_root_dir").or(fallback_cwd);
    (title, cwd)
}

pub fn claude_guess_cwd(slug: &str, os: HostOs) -> Option<String> {
    if slug.is_empty() {
        return None;
    }
    if os == HostOs::Windows {
        return crate::win::slug_to_cwd(slug);
    }
    let mut guessed = slug.replace('-', "/");
    if !guessed.starts_with('/') && guessed.starts_with("Users") {
        guessed.insert(0, '/');
    }
    Some(guessed)
}

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn find_uuid(name: &str) -> Option<String> {
    let b = name.as_bytes();
    if b.len() < 36 {
        return None;
    }
    for i in 0..=b.len() - 36 {
        if is_uuid(&b[i..i + 36]) {
            return Some(name[i..i + 36].to_string());
        }
    }
    None
}

fn is_uuid(p: &[u8]) -> bool {
    if p.len() != 36 {
        return false;
    }
    let hex = |j: usize| p[j].is_ascii_hexdigit();
    let dash = |j: usize| p[j] == b'-';
    for j in 0..8 {
        if !hex(j) {
            return false;
        }
    }
    dash(8)
        && (9..13).all(hex)
        && dash(13)
        && (14..18).all(hex)
        && dash(18)
        && (19..23).all(hex)
        && dash(23)
        && (24..36).all(hex)
}

fn json_str(obj: &Value, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

fn extract_cwd_tag(s: &str) -> Option<&str> {
    let start = s.find("<cwd>")? + 5;
    let rest = s.get(start..)?;
    let end = rest.find("</cwd>")?;
    Some(&rest[..end])
}

fn message_text(obj: &Value) -> Option<String> {
    let msg = obj.get("message").or_else(|| obj.get("content"))?;
    if let Some(s) = msg.as_str() {
        return Some(s.to_string());
    }
    let content = msg.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let arr = content.as_array()?;
    for part in arr {
        if part.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn decode_b64(s: &str) -> Vec<u8> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Vec::new();
    }
    STANDARD.decode(cleaned.as_bytes()).unwrap_or_default()
}

fn after_magic<'a>(text: &'a str, magic: &str) -> Result<&'a str> {
    match text.find(magic) {
        Some(i) => Ok(&text[i..]),
        None => Err(anyhow!("remote output missing {magic}: {}", snippet(text))),
    }
}

fn snippet(text: &str) -> String {
    text.trim().chars().take(400).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn scripts_have_no_python() {
        assert!(!probe_script().contains("python"));
        assert!(!list_script(AgentKind::Grok).contains("python"));
        assert!(
            !start_script(AgentKind::Grok, "/tmp", None, "faragent-grok-abc", false)
                .contains("python")
        );
        assert!(probe_script().contains("FARAGENT_PROBE_V1"));
        assert!(TMUX_CONF.contains("prefix C-g"));
        assert_eq!(TMUX_SOCKET, "faragent");
        assert!(list_script(AgentKind::Grok).contains("tmux -L faragent"));
        assert!(list_script(AgentKind::Grok).contains("tmux -L farssh"));
        let start = start_script(AgentKind::Grok, "/tmp", None, "faragent-grok-abc", false);
        assert!(start.contains("$HOME/.faragent/tmux.conf"));
        assert!(start.contains("tmux -L farssh"));
    }

    #[test]
    fn only_the_confirmed_form_creates_the_directory() {
        let ask = start_script(
            AgentKind::Codex,
            "/home/me/app",
            None,
            "faragent-codex-abc",
            false,
        );
        // The script is a raw string: `\t` reaches the remote and printf expands it.
        assert!(ask.contains(r"err\tcwd_missing"));
        assert!(
            !ask.contains("mkdir"),
            "no write without confirmation: {ask}"
        );

        let create = start_script(
            AgentKind::Codex,
            "/home/me/app",
            None,
            "faragent-codex-abc",
            true,
        );
        assert!(create.contains("mkdir -p -- /home/me/app"), "{create}");
        assert!(create.contains(r"err\tmkdir_failed"));
        // Still checked afterwards, so a silent mkdir failure cannot slip through.
        assert!(create.contains("[ ! -d /home/me/app ]"));

        // Odd paths stay quoted and cannot turn into extra shell words.
        let quoted = start_script(
            AgentKind::Codex,
            "/tmp/a b; rm -rf /",
            None,
            "faragent-codex-abc",
            true,
        );
        assert!(
            quoted.contains("mkdir -p -- '/tmp/a b; rm -rf /'"),
            "{quoted}"
        );
    }

    #[test]
    fn parse_probe_sample() {
        let text = "\
login banner
FARAGENT_PROBE_V1
os	linux
home	/home/me
user	me
shell	/bin/bash
path	/usr/bin
tmux_path	/usr/bin/tmux
tmux_version	tmux 3.3
agent	claude	/usr/bin/claude	1.0	ok
agent	codex			missing
agent	grok	/opt/grok	0.9	unknown
agent	pi			missing
";
        let p = parse_probe(text).unwrap();
        assert_eq!(p.home, "/home/me");
        assert_eq!(p.os, HostOs::Posix);
        assert!(p.tmux.found);
        assert_eq!(p.agent(AgentKind::Claude).unwrap().found, true);
        assert_eq!(p.agent(AgentKind::Codex).unwrap().found, false);
        assert_eq!(
            p.agent(AgentKind::Grok).unwrap().version.as_deref(),
            Some("0.9")
        );
    }

    #[test]
    fn parse_probe_reads_windows_os() {
        let text = "FARAGENT_PROBE_V1\r\nos\twindows\r\nhome\tC:\\Users\\me\r\n";
        let p = parse_probe(text).unwrap();
        assert_eq!(p.os, HostOs::Windows);
        assert_eq!(p.home, "C:\\Users\\me");
        assert!(!p.tmux.found);
        // A probe from before the os line existed still parses.
        let old = parse_probe("FARAGENT_PROBE_V1\nhome\t/home/me\n").unwrap();
        assert_eq!(old.os, HostOs::Posix);
    }

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

    #[test]
    fn jsonl_meta_reads_cwd_and_title() {
        let body =
            br#"{"cwd":"/tmp/proj","message":{"content":[{"type":"text","text":"hello world"}]}}
{"cwd":"/ignored"}
"#;
        let m = jsonl_meta(body, 80);
        assert_eq!(m.cwd.as_deref(), Some("/tmp/proj"));
        assert_eq!(m.title.as_deref(), Some("hello world"));
    }

    #[test]
    fn jsonl_meta_cwd_tag() {
        let body = br#"{"environment_context":"<cwd>/Users/a/src</cwd>"}"#;
        let m = jsonl_meta(body, 80);
        assert_eq!(m.cwd.as_deref(), Some("/Users/a/src"));
    }

    #[test]
    fn percent_decode_path() {
        assert_eq!(percent_decode("%2FUsers%2Fa"), "/Users/a");
        assert_eq!(percent_decode("plain"), "plain");
    }

    #[test]
    fn uuid_from_filename() {
        let name = "rollout-01a093cd-ec3c-74e3-9d43-cdb915ddb244.jsonl";
        assert_eq!(
            find_uuid(name).as_deref(),
            Some("01a093cd-ec3c-74e3-9d43-cdb915ddb244")
        );
        assert!(find_uuid("nope").is_none());
    }

    #[test]
    fn parse_start_ok_and_err() {
        let ok = parse_start("FARAGENT_START_V1\nok\tcreated\tfaragent-grok-abc\n").unwrap();
        match ok {
            StartOutcome::Ok { name } => assert_eq!(name, "faragent-grok-abc"),
            _ => panic!("expected ok"),
        }
        let err = parse_start("FARAGENT_START_V1\nerr\ttmux_missing\tInstall tmux\n").unwrap();
        match err {
            StartOutcome::Err { error, .. } => assert_eq!(error, "tmux_missing"),
            _ => panic!("expected err"),
        }
    }

    #[test]
    fn claude_slug_guess() {
        assert_eq!(
            claude_guess_cwd("Users-me-src", HostOs::Posix).as_deref(),
            Some("/Users/me/src")
        );
        assert_eq!(
            claude_guess_cwd("C--Users-me-src-app", HostOs::Windows).as_deref(),
            Some("C:\\Users\\me\\src\\app")
        );
        assert_eq!(claude_guess_cwd("", HostOs::Windows), None);
    }

    #[test]
    fn parse_list_reads_proc_lines() {
        let text = "\
FARAGENT_LIST_V1
file\tclaude\tabc123\t10.0\tC--Users-me\t
proc\tclaude\tabc123
proc\tclaude\t
";
        let dump = parse_list(text).unwrap();
        assert_eq!(
            dump.procs,
            vec![
                ("claude".to_string(), "abc123".to_string()),
                ("claude".to_string(), String::new()),
            ]
        );
        // POSIX output without proc lines still parses.
        let old = parse_list("FARAGENT_LIST_V1\nfile\tgrok\tx\t1.0\thint\t\n").unwrap();
        assert!(old.procs.is_empty());
    }
}

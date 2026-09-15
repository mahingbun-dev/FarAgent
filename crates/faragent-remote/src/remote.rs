//! Remote side is POSIX `bash` + `tmux` only. All JSON / session logic runs here.

use anyhow::{anyhow, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use faragent_core::agents::AgentKind;
use faragent_core::shell::shell_single_quote;
use serde::Deserialize;
use serde_json::Value;

pub const TMUX_SOCKET: &str = "faragent";
/// Pre-rename isolated tmux server; list/attach still query it.
pub const LEGACY_TMUX_SOCKET: &str = "farssh";

pub use faragent_core::vocab::HostOs;

/// The one command the "create the missing directory" confirmation runs on
/// the remote, per dialect.
pub fn new_dir_command(dir: &str, os: HostOs) -> String {
    match os {
        HostOs::Posix => format!("mkdir -p {dir}"),
        HostOs::Windows => format!("New-Item -ItemType Directory -Force -LiteralPath '{dir}'"),
    }
}

/// The tmux attach line for an existing session. Socket + conf follow the
/// session name so pre-rename live panes still attach.
pub fn attach_script(tmux_name: &str) -> String {
    let name_q = shell_single_quote(tmux_name);
    let (sock, conf) = if tmux_name.starts_with("farssh-") {
        ("farssh", "$HOME/.farssh/tmux.conf")
    } else {
        ("faragent", "$HOME/.faragent/tmux.conf")
    };
    format!("exec tmux -L {sock} -f \"{conf}\" attach -t {name_q}")
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
    /// Codex `codex exec` / launchd rollouts. Other agents stay false.
    pub scheduled: bool,
}

#[derive(Debug, Clone)]
pub struct DiskFile {
    pub agent: String,
    pub id: String,
    pub mtime: f64,
    pub cwd_hint: String,
    pub body: Vec<u8>,
    /// The conversation transcript the app tails, when this row came from a
    /// file. For most agents that is the very file `body` was read from; Grok
    /// is the exception — its list line is built from `summary.json` while the
    /// conversation lives beside it in `chat_history.jsonl`.
    pub path: Option<String>,
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

/// Bytes of each transcript sent home for title/cwd. Codex session_meta
/// lines are often >8KB (`base_instructions`), and the first real user
/// prompt sits after injected AGENTS.md, so Codex needs a larger prefix.
fn list_file_prefix_kb(agent: AgentKind) -> u32 {
    match agent {
        AgentKind::Codex => 128,
        _ => 8,
    }
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
  _path="${{5:-$_src}}"
  _mt=$(mtime_of "$_src")
  _id=$(printf '%s' "$_id" | tr '\t\n\r' '   ')
  _cwd=$(printf '%s' "$_cwd" | tr '\t\n\r' '   ')
  _path=$(printf '%s' "$_path" | tr '\t\n\r' '   ')
  _b64=
  if [ -f "$_src" ] && command -v base64 >/dev/null 2>&1; then
    _b64=$(dd if="$_src" bs=1024 count={prefix_kb} 2>/dev/null | base64 | tr -d '\n\r ')
  fi
  printf 'file\t%s\t%s\t%s\t%s\t%s\t%s\n' "$_agent" "$_id" "$_mt" "$_cwd" "$_b64" "$_path"
}}
if command -v tmux >/dev/null 2>&1; then
  tmux -L {sock} -f "$HOME/.faragent/tmux.conf" list-sessions -F 'tmux	#{{session_name}}	#{{pane_current_path}}' 2>/dev/null || true
  tmux -L {legacy} list-sessions -F 'tmux	#{{session_name}}	#{{pane_current_path}}' 2>/dev/null || true
fi
"#,
        sock = TMUX_SOCKET,
        legacy = LEGACY_TMUX_SOCKET,
        prefix_kb = list_file_prefix_kb(agent),
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
      emit_file grok "$sid" "$siddir/summary.json" "$cwdenc" "$siddir/chat_history.jsonl"
    else
      printf 'file\tgrok\t%s\t%s\t%s\t\t%s\n' "$sid" "$(mtime_of "$siddir")" "$cwdenc" "$siddir/chat_history.jsonl"
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
  _idx=$(mktemp 2>/dev/null || echo "/tmp/faragent-codex-list.$$")
  find "$HOME/.codex/sessions" -type f -name '*.jsonl' 2>/dev/null |
  while IFS= read -r f; do
    _kind=interactive
    if dd if="$f" bs=1024 count=4 2>/dev/null | grep -q '"source":"exec"'; then
      _kind=scheduled
    fi
    printf '%s\t%s\t%s\n' "$_kind" "$(mtime_of "$f")" "$f"
  done > "$_idx"
  for _kind in interactive scheduled; do
    awk -F '\t' -v k="$_kind" '$1==k { print $2 "\t" $3 }' "$_idx" |
    sort -nr | head -n 30 | cut -f2- |
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      sid=$(basename "$f" .jsonl)
      emit_file codex "$sid" "$f" ""
    done
  done
  rm -f "$_idx"
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
    full_permissions: bool,
) -> String {
    let argv = agent.launch_argv(session_id, full_permissions);
    let inner = format!(
        "exec {}",
        argv.iter()
            .map(|a| shell_single_quote(a))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let agent_q = shell_single_quote(agent.slug());
    let cwd_q = shell_single_quote(cwd);
    let name_q = shell_single_quote(tmux_name);
    let legacy_name = tmux_name
        .strip_prefix("faragent-")
        .map(|rest| format!("farssh-{rest}"))
        .unwrap_or_default();
    let legacy_q = shell_single_quote(&legacy_name);
    let inner_q = shell_single_quote(&inner);
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
                // Seven columns since the transcript path was appended. A line
                // from an older remote has six and simply carries no path:
                // `splitn` stops early, `cols.get(6)` is `None`, and every
                // earlier column keeps its position.
                let cols: Vec<&str> = line.splitn(7, '\t').collect();
                if cols.len() >= 4 {
                    files.push(DiskFile {
                        agent: cols[1].to_string(),
                        id: cols[2].to_string(),
                        mtime: cols[3].parse().unwrap_or(0.0),
                        cwd_hint: cols.get(4).unwrap_or(&"").to_string(),
                        body: decode_b64(cols.get(5).unwrap_or(&"")),
                        path: cols.get(6).filter(|p| !p.is_empty()).map(|p| p.to_string()),
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
    let mut scheduled = false;
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
        if !scheduled {
            scheduled = scheduled_from_record(&obj);
        }
        if cwd.is_none() {
            cwd = cwd_from_record(&obj);
        }
        if title.is_none() {
            title = title_from_record(&obj);
        }
        if title.is_some() && cwd.is_some() {
            break;
        }
    }
    JsonlMeta {
        title,
        cwd,
        scheduled,
    }
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

fn payload_of(obj: &Value) -> Option<&Value> {
    obj.get("payload").filter(|v| v.is_object())
}

fn scheduled_from_record(obj: &Value) -> bool {
    let rec = payload_of(obj).unwrap_or(obj);
    let source = json_str(rec, "source");
    let originator = json_str(rec, "originator");
    matches!(source.as_deref(), Some("exec")) || matches!(originator.as_deref(), Some("codex_exec"))
}

fn cwd_from_record(obj: &Value) -> Option<String> {
    let from = |v: &Value| {
        json_str(v, "cwd")
            .or_else(|| json_str(v, "cwd_path"))
            .or_else(|| {
                v.get("environment_context")
                    .and_then(|x| x.as_str())
                    .and_then(extract_cwd_tag)
                    .map(|s| s.to_string())
            })
    };
    from(obj).or_else(|| payload_of(obj).and_then(from))
}

fn is_skipped_role(obj: &Value) -> bool {
    matches!(
        obj.get("role").and_then(|v| v.as_str()),
        Some("developer" | "system" | "assistant")
    )
}

fn title_from_record(obj: &Value) -> Option<String> {
    let record = payload_of(obj).unwrap_or(obj);
    if is_skipped_role(record) || is_skipped_role(obj) {
        return None;
    }
    if let Some(t) = user_message_item(record).and_then(|s| usable_title(&s)) {
        return Some(t);
    }
    message_text(record)
        .or_else(|| message_text(obj))
        .and_then(|s| usable_title(&s))
}

fn user_message_item(payload: &Value) -> Option<String> {
    let item = payload.get("item")?;
    if item.get("type").and_then(|v| v.as_str()) != Some("UserMessage") {
        return None;
    }
    content_text(item.get("content")?)
}

fn usable_title(text: &str) -> Option<String> {
    let mut t = text.trim();
    const MARKER: &str = "## My request:";
    if let Some(idx) = t.find(MARKER) {
        t = t[idx + MARKER.len()..].trim();
    }
    let first = t.lines().next().unwrap_or("").trim();
    if first.is_empty() || skip_as_title(first) {
        return None;
    }
    Some(first.chars().take(80).collect())
}

fn skip_as_title(s: &str) -> bool {
    let s = s.trim();
    s.starts_with('<')
        || s.starts_with("# AGENTS.md")
        || s.starts_with("# Files mentioned by the user")
        || s.starts_with("[Request interrupted")
}

fn content_text(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string()).filter(|t| !t.is_empty());
    }
    let arr = content.as_array()?;
    let mut parts = Vec::new();
    for part in arr {
        let ty = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if !matches!(ty, "text" | "input_text" | "") {
            continue;
        }
        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
            if !t.is_empty() {
                parts.push(t);
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn message_text(obj: &Value) -> Option<String> {
    let msg = obj.get("message").or_else(|| obj.get("content"))?;
    if let Some(s) = msg.as_str() {
        return Some(s.to_string());
    }
    if let Some(content) = msg.get("content") {
        return content_text(content);
    }
    content_text(msg)
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
        assert!(!start_script(
            AgentKind::Grok,
            "/tmp",
            None,
            "faragent-grok-abc",
            false,
            false,
        )
        .contains("python"));
        assert!(probe_script().contains("FARAGENT_PROBE_V1"));
        assert!(TMUX_CONF.contains("prefix C-g"));
        assert_eq!(TMUX_SOCKET, "faragent");
        assert!(list_script(AgentKind::Grok).contains("tmux -L faragent"));
        assert!(list_script(AgentKind::Grok).contains("tmux -L farssh"));
        let start = start_script(
            AgentKind::Grok,
            "/tmp",
            None,
            "faragent-grok-abc",
            false,
            false,
        );
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
            false,
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
            false,
        );
        assert!(
            quoted.contains("mkdir -p -- '/tmp/a b; rm -rf /'"),
            "{quoted}"
        );
    }

    #[test]
    fn start_script_full_permissions_embeds_flags() {
        let claude = start_script(
            AgentKind::Claude,
            "/tmp",
            None,
            "faragent-claude-abc",
            false,
            true,
        );
        assert!(
            claude.contains("--permission-mode") && claude.contains("bypassPermissions"),
            "{claude}"
        );

        let claude_resume = start_script(
            AgentKind::Claude,
            "/tmp",
            Some("abc"),
            "faragent-claude-abc",
            false,
            true,
        );
        assert!(
            claude_resume.contains("--resume")
                && claude_resume.contains("--permission-mode")
                && claude_resume.contains("bypassPermissions"),
            "{claude_resume}"
        );

        let codex = start_script(
            AgentKind::Codex,
            "/tmp",
            None,
            "faragent-codex-abc",
            false,
            true,
        );
        assert!(
            codex.contains("--dangerously-bypass-approvals-and-sandbox"),
            "{codex}"
        );

        let codex_resume = start_script(
            AgentKind::Codex,
            "/tmp",
            Some("abc"),
            "faragent-codex-abc",
            false,
            true,
        );
        let inner = "exec codex --dangerously-bypass-approvals-and-sandbox resume abc";
        assert!(
            codex_resume.contains(inner),
            "codex flag must sit before resume: {codex_resume}"
        );

        let grok = start_script(
            AgentKind::Grok,
            "/tmp",
            None,
            "faragent-grok-abc",
            false,
            true,
        );
        assert!(grok.contains("--always-approve"), "{grok}");

        let grok_off = start_script(
            AgentKind::Grok,
            "/tmp",
            None,
            "faragent-grok-abc",
            false,
            false,
        );
        assert!(!grok_off.contains("--always-approve"), "{grok_off}");

        let pi = start_script(AgentKind::Pi, "/tmp", None, "faragent-pi-abc", false, true);
        assert!(!pi.contains("--yolo"), "{pi}");
        assert!(!pi.contains("bypass"), "{pi}");
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
    fn jsonl_meta_reads_codex_payload_cwd_and_user_title() {
        let body = r##"{"timestamp":"2026-09-14T02:00:19Z","type":"session_meta","payload":{"session_id":"01a09da3-f4c3-7f73-8a10-752981cdc3d3","cwd":"/tmp/wo","cli_version":"0.153.4"}}
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<app-context>\nCodex desktop context"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\n<INSTRUCTIONS>\nprefer .venv"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"how to monetize a vibe coding product?\n"}]}}
"##;
        let m = jsonl_meta(body.as_bytes(), 120);
        assert_eq!(m.cwd.as_deref(), Some("/tmp/wo"));
        assert_eq!(
            m.title.as_deref(),
            Some("how to monetize a vibe coding product?")
        );
    }

    #[test]
    fn jsonl_meta_codex_uses_my_request_not_file_wrapper() {
        let body = r##"{"type":"session_meta","payload":{"cwd":"/tmp/app"}}
{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"\n# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request:\nmatch the thinking-process style\n"}]}}}
"##;
        let m = jsonl_meta(body.as_bytes(), 80);
        assert_eq!(m.cwd.as_deref(), Some("/tmp/app"));
        assert_eq!(m.title.as_deref(), Some("match the thinking-process style"));
    }

    #[test]
    fn jsonl_meta_codex_skips_command_and_interrupted_titles() {
        let body = r##"{"type":"session_meta","payload":{"cwd":"/tmp/p"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<command-name>/clear</command-name>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"[Request interrupted by user]"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"what is in the worktree"}]}}
"##;
        let m = jsonl_meta(body.as_bytes(), 80);
        assert_eq!(m.title.as_deref(), Some("what is in the worktree"));
    }

    #[test]
    fn list_script_codex_reads_a_larger_prefix_than_other_agents() {
        let shared = list_script(AgentKind::Grok);
        assert!(
            shared.contains("count=8") || shared.contains("count=\"$_kb\""),
            "default prefix should stay 8KB: {shared}"
        );
        let codex = list_script(AgentKind::Codex);
        assert!(
            codex.contains("count=128"),
            "codex first-line+AGENTS.md often exceeds 8KB: {codex}"
        );
        assert!(!list_script(AgentKind::Claude).contains("count=128"));
        assert!(!list_script(AgentKind::Pi).contains("count=128"));
    }

    #[test]
    fn list_script_codex_sends_newest_files_not_an_unsorted_200() {
        let codex = list_script(AgentKind::Codex);
        assert!(
            codex.contains("sort -nr"),
            "codex must pick newest transcripts: {codex}"
        );
        assert!(
            codex.contains(r#""source":"exec""#),
            "codex must split launchd/exec rollouts from desktop sessions: {codex}"
        );
        assert!(
            codex.contains("head -n 30"),
            "each bucket is capped so exec jobs cannot crowd out interactive: {codex}"
        );
        assert!(
            !codex.contains("head -n 200"),
            "codex must not keep the unsorted 200 cap: {codex}"
        );
        assert!(list_script(AgentKind::Claude).contains("head -n 200"));
    }

    #[test]
    fn jsonl_meta_marks_codex_exec_as_scheduled() {
        let body = r#"{"type":"session_meta","payload":{"cwd":"/tmp/p","source":"exec","originator":"codex_exec"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hourly sync"}]}}
"#;
        let m = jsonl_meta(body.as_bytes(), 20);
        assert!(m.scheduled);
        assert_eq!(m.title.as_deref(), Some("hourly sync"));
    }

    #[test]
    fn jsonl_meta_marks_vscode_codex_as_interactive() {
        let body = r#"{"type":"session_meta","payload":{"cwd":"/tmp/p","source":"vscode","originator":"Codex Desktop"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the build"}]}}
"#;
        let m = jsonl_meta(body.as_bytes(), 20);
        assert!(!m.scheduled);
        assert_eq!(m.title.as_deref(), Some("fix the build"));
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

    #[test]
    fn parse_list_reads_the_appended_transcript_path() {
        // Seven columns: the path is appended after the b64 body.
        let text = "\
FARAGENT_LIST_V1
file\tclaude\tabc123\t10.0\t-Users-me\taGVsbG8=\t/home/me/.claude/projects/-Users-me/abc123.jsonl
";
        let dump = parse_list(text).unwrap();
        assert_eq!(dump.files.len(), 1);
        let f = &dump.files[0];
        assert_eq!(f.agent, "claude");
        assert_eq!(f.id, "abc123");
        assert_eq!(f.mtime, 10.0);
        assert_eq!(f.cwd_hint, "-Users-me");
        assert_eq!(f.body, b"hello");
        assert_eq!(
            f.path.as_deref(),
            Some("/home/me/.claude/projects/-Users-me/abc123.jsonl")
        );
    }

    #[test]
    fn parse_list_accepts_a_line_from_before_the_path_column() {
        // The old six-column shape (no path) must keep parsing: `path` is
        // `None`, and every earlier column stays where it was.
        let text = "FARAGENT_LIST_V1\nfile\tgrok\tx\t1.0\thint\taGVsbG8=\n";
        let dump = parse_list(text).unwrap();
        assert_eq!(dump.files.len(), 1);
        assert_eq!(dump.files[0].id, "x");
        assert_eq!(dump.files[0].body, b"hello");
        assert_eq!(dump.files[0].path, None);

        // An empty trailing column is the same as no column at all.
        let empty =
            parse_list("FARAGENT_LIST_V1\nfile\tclaude\ty\t2.0\thint\taGVsbG8=\t\n").unwrap();
        assert_eq!(empty.files[0].path, None);
        assert_eq!(empty.files[0].cwd_hint, "hint");
        assert_eq!(empty.files[0].body, b"hello");
    }

    #[test]
    fn grok_list_carries_the_conversation_file_not_the_summary() {
        // Grok's list line is built from `summary.json`, but the conversation
        // the app tails lives beside it in `chat_history.jsonl`.
        let grok = list_script(AgentKind::Grok);
        assert!(
            grok.contains("$siddir/chat_history.jsonl"),
            "grok must emit the conversation file as the transcript path: {grok}"
        );
        // And the path column exists in the shared emit helper at all.
        assert!(list_script(AgentKind::Claude).contains(r"\t%s\t%s\t%s\t%s\t%s\t%s\n"));
    }

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

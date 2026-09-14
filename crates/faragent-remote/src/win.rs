//! Windows remote dialect: cmd.exe is the outer shell (sshd's default), and
//! PowerShell 5.1 does the work. Scripts are ASCII-only and travel on stdin
//! (`-File -`); dynamic values ride base64 `$args`, so no cmd quoting is ever
//! involved. Interactive launchers use a short `-EncodedCommand` payload
//! because stdin must stay attached to the tty.
//!
//! Protocol note: the `FARAGENT_*_V1` markers and tab-separated line shapes
//! are shared with `remote.rs`; the parsers there never care which dialect
//! produced the bytes.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use faragent_core::agents::AgentKind;

/// Every generated script starts with this so UTF-8 crosses the wire even on
/// Chinese Windows consoles (whose default code page is GBK).
pub const UTF8_PREAMBLE: &str =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8";

/// `powershell -NoProfile -ExecutionPolicy Bypass -File - <b64 args…>` — the
/// canonical non-interactive delivery. The script body goes on stdin.
/// `powershell … -EncodedCommand <utf16le-b64>` — for short launchers where
/// stdin must stay attached to the terminal.
pub fn encoded_command(script: &str) -> String {
    format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        utf16le_b64(script)
    )
}

/// PowerShell expects UTF-16LE base64 for `-EncodedCommand`.
pub fn utf16le_b64(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len() * 2);
    for u in s.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

/// UTF-8 base64 for the `$args` channel: dynamic values (paths, ids) never
/// touch the command line as text.
pub fn b64(s: &str) -> String {
    STANDARD.encode(s.as_bytes())
}

/// PowerShell literal quoting: wrap in `'` and double any embedded `'`.
pub fn ps_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Shared helpers every generated script carries: sanitize a value for the
/// tab protocol, epoch mtime, prefix base64, and the `file` line itself.
/// `__PREFIX_BYTES__` is filled per agent — Codex needs more than 8KB.
const HELPERS: &str = r#"
function Clean([string]$s) { return ($s -replace "[`t`r`n]", ' ') }
function Mt([string]$p) {
  try { $i = Get-Item -LiteralPath $p -Force; return [int64]($i.LastWriteTimeUtc - [datetime]'1970-01-01T00:00:00Z').TotalSeconds } catch { return 0 }
}
function B64([string]$p) {
  try {
    $fs = [IO.File]::OpenRead($p); $buf = New-Object byte[] __PREFIX_BYTES__; $n = $fs.Read($buf,0,__PREFIX_BYTES__); $fs.Close()
    if ($n -le 0) { return '' }
    return [Convert]::ToBase64String($buf,0,$n)
  } catch { return '' }
}
function Emit([string]$ag,[string]$id,[string]$src,[string]$cwd) {
  $b = ''
  if (Test-Path -LiteralPath $src -PathType Leaf) { $b = B64 $src }
  Write-Output ("file`t{0}`t{1}`t{2}`t{3}`t{4}" -f $ag, (Clean $id), (Mt $src), (Clean $cwd), $b)
}
"#;

fn list_helpers(agent: AgentKind) -> String {
    let bytes = match agent {
        AgentKind::Codex => 128 * 1024,
        _ => 8192,
    };
    HELPERS.replace("__PREFIX_BYTES__", &bytes.to_string())
}

/// Probe: same `FARAGENT_PROBE_V1` tab protocol as the POSIX script, with
/// `os\twindows` so the client can trust the dialect.
pub fn probe_script() -> String {
    format!(
        r#"{UTF8_PREAMBLE}
Write-Output 'FARAGENT_PROBE_V1'
Write-Output "os`twindows"
Write-Output "home`t$env:USERPROFILE"
Write-Output "user`t$env:USERNAME"
Write-Output "shell`t$env:ComSpec"
Write-Output "path`t$env:PATH"

function Clean([string]$s) {{ return ($s -replace "[`t`r`n]", ' ') }}
function VerOf([string]$p) {{
  try {{
    $out = & $p --version 2>&1 | Select-Object -First 1
    if (-not $out) {{ $out = & $p -V 2>&1 | Select-Object -First 1 }}
    $s = Clean ([string]$out)
    if ($s.Length -gt 160) {{ $s = $s.Substring(0,160) }}
    return $s
  }} catch {{ return '' }}
}}
function AuthOf([string]$a) {{
  $h = $env:USERPROFILE
  $paths = @()
  switch ($a) {{
    'grok'   {{ $paths = @("$h\.grok\auth.json") }}
    'claude' {{ $paths = @("$h\.claude.json", "$h\.claude\.credentials.json") }}
    'codex'  {{ $paths = @("$h\.codex\auth.json", "$h\.codex\config.toml") }}
    'pi'     {{ $paths = @("$h\.pi\agent\auth.json", "$h\.pi\agent\settings.json") }}
  }}
  foreach ($p in $paths) {{
    if ((Test-Path -LiteralPath $p) -and (Get-Item -LiteralPath $p).Length -gt 0) {{ return 'ok' }}
  }}
  return 'unknown'
}}

foreach ($a in @('claude','codex','grok','pi')) {{
  $cmd = Get-Command $a -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source) {{
    Write-Output ("agent`t{{0}}`t{{1}}`t{{2}}`t{{3}}" -f $a, $cmd.Source, (VerOf $cmd.Source), (AuthOf $a))
  }} else {{
    Write-Output ("agent`t{{0}}`t`t`tmissing" -f $a)
  }}
}}
"#
    )
}

/// Install preflight in the shared `FARAGENT_PREFLIGHT_V1` protocol. There is
/// no tmux or curl bootstrap on Windows; winget is the only package manager
/// the planner can use (user-scope installs, no admin).
pub fn preflight_script(agent: AgentKind) -> String {
    format!(
        r#"{UTF8_PREAMBLE}
Write-Output 'FARAGENT_PREFLIGHT_V1'
Write-Output "os`twindows"
Write-Output "home`t$env:USERPROFILE"
function Src([string]$n) {{
  $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c -and $c.Source) {{ return $c.Source }}
  return ''
}}
Write-Output ("curl`t" + (Src 'curl.exe'))
Write-Output ("node`t" + (Src 'node'))
Write-Output ("npm`t" + (Src 'npm'))
Write-Output 'nvm`t0'
Write-Output 'tmux`t'
$wg = Src 'winget'
Write-Output ("winget`t" + $wg)
if ($wg) {{ Write-Output 'pkg`twinget' }} else {{ Write-Output 'pkg`t' }}
Write-Output ("agent_path`t" + (Src '{slug}'))
Write-Output 'live`t0'
"#,
        slug = agent.slug(),
    )
}

/// Session list for one agent: disk transcripts (`file` lines, same shapes and
/// hint conventions as the POSIX script) plus a process scan that emits
/// `proc\t<agent>\t<session-id-or-empty>` for anything that looks like this
/// agent running under the current user. There is no tmux on Windows.
pub fn list_script(agent: AgentKind) -> String {
    let helpers = list_helpers(agent);
    let mut s = format!(
        r#"{UTF8_PREAMBLE}
Write-Output 'FARAGENT_LIST_V1'
{helpers}
"#
    );
    let root = |tail: &str| format!("(Join-Path $env:USERPROFILE '{tail}')");
    match agent {
        AgentKind::Grok => s.push_str(&format!(
            r#"$root = {root}
if (Test-Path -LiteralPath $root) {{
  $count = 0
  Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {{
    $cwdenc = $_.Name
    Get-ChildItem -LiteralPath $_.FullName -Directory | ForEach-Object {{
      if ($count -ge 200) {{ return }}
      $count++
      $sum = Join-Path $_.FullName 'summary.json'
      if (Test-Path -LiteralPath $sum -PathType Leaf) {{ Emit 'grok' $_.Name $sum $cwdenc }}
      else {{ Emit 'grok' $_.Name $_.FullName $cwdenc }}
    }}
  }}
}}
{proc_scan}
"#,
            root = root(".grok\\sessions"),
            proc_scan = proc_scan(agent),
        )),
        AgentKind::Claude => s.push_str(&format!(
            r#"$root = {root}
if (Test-Path -LiteralPath $root) {{
  $count = 0
  Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {{
    $slug = $_.Name
    Get-ChildItem -LiteralPath $_.FullName -File -Filter '*.jsonl' | ForEach-Object {{
      if ($count -ge 200) {{ return }}
      if ($_.Name -match '\.(orphaned|superseded)-') {{ return }}
      $count++
      Emit 'claude' $_.BaseName $_.FullName $slug
    }}
  }}
}}
{proc_scan}
"#,
            root = root(".claude\\projects"),
            proc_scan = proc_scan(agent),
        )),
        AgentKind::Codex => s.push_str(&format!(
            r#"$root = {root}
if (Test-Path -LiteralPath $root) {{
  $interactive = New-Object System.Collections.Generic.List[object]
  $scheduled = New-Object System.Collections.Generic.List[object]
  Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.jsonl' | ForEach-Object {{
    $fs = [IO.File]::OpenRead($_.FullName)
    $buf = New-Object byte[] 4096
    $n = $fs.Read($buf, 0, 4096)
    $fs.Close()
    $head = [Text.Encoding]::UTF8.GetString($buf, 0, $n)
    if ($head.Contains('"source":"exec"')) {{ [void]$scheduled.Add($_) }}
    else {{ [void]$interactive.Add($_) }}
  }}
  $interactive | Sort-Object LastWriteTime -Descending | Select-Object -First 30 | ForEach-Object {{ Emit 'codex' $_.BaseName $_.FullName '' }}
  $scheduled | Sort-Object LastWriteTime -Descending | Select-Object -First 30 | ForEach-Object {{ Emit 'codex' $_.BaseName $_.FullName '' }}
}}
{proc_scan}
"#,
            root = root(".codex\\sessions"),
            proc_scan = proc_scan(agent),
        )),
        AgentKind::Pi => s.push_str(&format!(
            r#"$root = {root}
if (Test-Path -LiteralPath $root) {{
  $count = 0
  Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {{ $_.Extension -in '.json','.jsonl' }} | ForEach-Object {{
    if ($count -ge 200) {{ return }}
    $count++
    $rel = $_.FullName.Substring($root.Length).TrimStart('\')
    $parts = $rel.Split('\')
    $cwdenc = ''
    if ($parts.Length -gt 1) {{ $cwdenc = $parts[0] }}
    Emit 'pi' $_.BaseName $_.FullName $cwdenc
  }}
}}
{proc_scan}
"#,
            root = root(".pi\\agent\\sessions"),
            proc_scan = proc_scan(agent),
        )),
    }
    s
}

/// Command-line markers per agent: the install shim or binary name plus the
/// npm package path. Processes with no marker are not this agent.
fn proc_pattern(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Claude => {
            r"(?i)(claude\.exe|@anthropic-ai[\\/]claude-code|\.local[\\/]bin[\\/]claude)"
        }
        AgentKind::Codex => r"(?i)(codex\.exe|@openai[\\/]codex|codex-windows)",
        AgentKind::Grok => r"(?i)(grok\.exe|grok-build|\.grok[\\/]bin)",
        AgentKind::Pi => r"(?i)(pi\.exe|pi-coding-agent|earendil)",
    }
}

/// Best-effort "is this session already running" scan (drives a confirmation
/// dialog only; never a hard block). Session ids are pulled out of resume-ish
/// flags when present; a marker match without an id is still reported.
fn proc_scan(agent: AgentKind) -> String {
    format!(
        r#"Get-CimInstance Win32_Process | ForEach-Object {{
  if ($_.CommandLine -and $_.CommandLine -match '{pattern}') {{
    $id = ''
    if ($_.CommandLine -match '(?i)(?:--resume|resume|--session)[\s=]+"?([A-Za-z0-9_\-]{{8,}})"?') {{ $id = $Matches[1] }}
    Write-Output ("proc`t{slug}`t$id")
  }}
}}"#,
        pattern = proc_pattern(agent),
        slug = agent.slug(),
    )
}

/// Validation half of starting a Windows session. Arguments (base64):
/// `$args[0]` = working directory, `$args[1]` = `1` when the user confirmed
/// creating it, `$args[2]` = display name. There is no background session to
/// create — the TUI launches the agent in the foreground afterwards.
pub fn start_script(agent: AgentKind) -> String {
    format!(
        r#"{UTF8_PREAMBLE}
Write-Output 'FARAGENT_START_V1'
$cwd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]))
$create = $args[1] -eq '1'
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[2]))
if (-not (Test-Path -LiteralPath $cwd)) {{
  if ($create) {{
    try {{ New-Item -ItemType Directory -Force -LiteralPath $cwd | Out-Null }} catch {{}}
    if (-not (Test-Path -LiteralPath $cwd)) {{
      Write-Output "err`tmkdir_failed`tCould not create the directory."
      exit 0
    }}
  }} else {{
    Write-Output "err`tcwd_missing`tNot a directory."
    exit 0
  }}
}}
$cmd = Get-Command '{slug}' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not ($cmd -and $cmd.Source)) {{
  Write-Output "err`tagent_missing`t{slug} is not on PATH in this session."
  exit 0
}}
Write-Output ("ok`tready`t{{0}}" -f $name)
"#,
        slug = agent.slug(),
    )
}

/// Interactive launcher: cd into the session directory and hand the console
/// to the agent. `-EncodedCommand` because stdin must stay attached to the
/// tty; the argv comes from the shared `agents` tables so it cannot drift.
pub fn attach_launcher(cwd: &str, argv: &[String]) -> String {
    let mut invocation = String::new();
    for (i, a) in argv.iter().enumerate() {
        if i > 0 {
            invocation.push(' ');
        }
        invocation.push_str(&ps_single_quote(a));
    }
    encoded_command(&format!(
        "Set-Location -LiteralPath {}; & {invocation}; exit $LASTEXITCODE",
        ps_single_quote(cwd)
    ))
}

/// `C:\Users\me\app` encodes to `C--Users-me-app` (every non-alphanumeric
/// character becomes `-`). Recover the drive form; dashes inside real names
/// stay ambiguous, exactly like the POSIX guess — the JSONL `cwd` field wins
/// whenever it is present.
pub fn slug_to_cwd(slug: &str) -> Option<String> {
    if slug.is_empty() {
        return None;
    }
    let b = slug.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b'-' && b[2] == b'-' {
        let rest = slug[3..].replace('-', "\\");
        Some(format!("{}:\\{}", &slug[..1], rest))
    } else {
        Some(slug.replace('-', "\\"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_ascii(name: &str, s: &str) {
        assert!(
            s.is_ascii(),
            "{name} must stay ASCII on the ssh command line"
        );
    }

    #[test]
    fn utf16le_b64_known_vector() {
        // PowerShell's documented sample: `echo hi` → aABpAA==
        assert_eq!(utf16le_b64("hi"), "aABpAA==");
        assert_eq!(utf16le_b64(""), "");
    }

    #[test]
    fn encoded_command_is_ascii_with_utf16_payload() {
        let cmd = encoded_command("Set-Location 'C:\\中文路径'");
        assert!(cmd.starts_with("powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "));
        assert!(
            cmd.is_ascii(),
            "the ssh command line must stay ASCII: {cmd}"
        );
        // The payload round-trips.
        let payload = cmd.rsplit(' ').next().unwrap();
        let bytes = STANDARD.decode(payload).unwrap();
        let utf16: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(
            String::from_utf16(&utf16).unwrap(),
            "Set-Location 'C:\\中文路径'"
        );
    }

    #[test]
    fn b64_roundtrip_and_quoting() {
        assert_eq!(b64("abc"), "YWJj");
        assert_eq!(ps_single_quote("plain"), "'plain'");
        assert_eq!(ps_single_quote("it's"), "'it''s'");
    }

    #[test]
    fn scripts_are_ascii_and_carry_markers() {
        assert_ascii("probe", &probe_script());
        assert!(probe_script().contains("FARAGENT_PROBE_V1"));
        assert!(probe_script().contains("os`twindows"));
        for agent in AgentKind::ALL {
            let s = list_script(agent);
            assert_ascii(agent.slug(), &s);
            assert!(s.contains("FARAGENT_LIST_V1"), "{agent:?}");
            assert!(s.contains("Write-Output (\"proc`t"), "{agent:?}");
            assert!(!s.contains("tmux"), "no tmux lines on Windows: {agent:?}");
            assert!(s.contains("USERPROFILE"), "{agent:?}");
        }
        assert!(list_script(AgentKind::Claude).contains(".claude\\projects"));
        assert!(list_script(AgentKind::Codex).contains(".codex\\sessions"));
        assert!(list_script(AgentKind::Grok).contains(".grok\\sessions"));
        assert!(list_script(AgentKind::Pi).contains(".pi\\agent\\sessions"));
        assert!(
            list_script(AgentKind::Codex).contains("131072"),
            "codex prefix must exceed 8KB so session_meta.cwd survives"
        );
        assert!(
            list_script(AgentKind::Codex).contains(r#""source":"exec""#),
            "split launchd/exec rollouts from desktop sessions"
        );
        assert!(
            list_script(AgentKind::Codex).contains("Select-Object -First 30"),
            "each bucket is capped so exec jobs cannot crowd out interactive"
        );
        assert!(list_script(AgentKind::Claude).contains("8192"));
        assert!(!list_script(AgentKind::Claude).contains("131072"));
    }

    #[test]
    fn slug_recovers_drive_paths() {
        assert_eq!(
            slug_to_cwd("C--Users-me-code-app").as_deref(),
            Some("C:\\Users\\me\\code\\app")
        );
        // No drive shape: dashes still become separators.
        assert_eq!(
            slug_to_cwd("Users-me-app").as_deref(),
            Some("Users\\me\\app")
        );
        assert_eq!(slug_to_cwd(""), None);
    }

    fn decode_payload(cmd: &str) -> String {
        let payload = cmd.rsplit(' ').next().unwrap();
        let bytes = STANDARD.decode(payload).unwrap();
        let utf16: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&utf16).unwrap()
    }

    #[test]
    fn start_script_validates_cwd_and_agent() {
        let s = start_script(AgentKind::Claude);
        assert_ascii("start", &s);
        assert!(s.contains("FARAGENT_START_V1"));
        assert!(s.contains("err`tcwd_missing"));
        assert!(s.contains("err`tmkdir_failed"));
        assert!(s.contains("err`tagent_missing"));
        assert!(s.contains("Get-Command 'claude'"));
        assert!(s.contains("[Convert]::FromBase64String($args[0])"));
        // Creating the directory only happens when the caller confirmed.
        assert!(s.contains("$create = $args[1] -eq '1'"));
    }

    #[test]
    fn attach_launcher_carries_the_shared_argv_tables() {
        let argv = AgentKind::Claude.resume_argv("abc-123");
        let cmd = attach_launcher("C:\\Users\\me\\My App", &argv);
        assert_ascii("launcher", &cmd);
        let script = decode_payload(&cmd);
        assert!(script.contains("Set-Location -LiteralPath 'C:\\Users\\me\\My App'"));
        assert!(script.contains("& 'claude' '--resume' 'abc-123'"));
        assert!(script.contains("exit $LASTEXITCODE"));

        // New sessions use the bare-binary table.
        let script = decode_payload(&attach_launcher("C:\\x", &AgentKind::Pi.new_argv()));
        assert!(script.contains("& 'pi'"));
    }

    #[test]
    fn attach_launcher_quotes_apostrophes() {
        let cmd = attach_launcher("C:\\it's\\app", &["claude".into()]);
        assert!(decode_payload(&cmd).contains("'C:\\it''s\\app'"));
    }
}

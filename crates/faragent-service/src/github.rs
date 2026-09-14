//! Copy a local `gh` login onto a remote host (hosts.yml + SSH key).
//! The GitHub token never appears in argv, logs, or [`GitHubSyncReport`].

use anyhow::{anyhow, Result};
use faragent_core::text::LocalizedText;
use faragent_core::vocab::HostOs;
use faragent_remote::win;
use faragent_transport::{host_os, run_login, run_win_login, run_win_login_args, OpenSshTransport};
use std::io::Write;
use std::process::{Command, Output, Stdio};

/// Shown when this machine has no `gh` login (and as the [`sync_to_host`] error).
pub const NOT_LOGGED_IN: LocalizedText<&'static str> = LocalizedText::new(
    "本机未登录 GitHub，请先运行 `gh auth login`.",
    "GitHub CLI is not logged in on this machine; run `gh auth login` first",
);

#[derive(Debug, Clone)]
pub struct GitHubSyncReport {
    pub user: String,
    pub remote_gh: bool,
    pub ssh_key_added: bool,
    pub warnings: Vec<LocalizedText<String>>,
}

pub const CONFIRM_TITLE: LocalizedText<&'static str> = LocalizedText::new(
    "FarAgent · 同步 GitHub 登录",
    "FarAgent · sync GitHub login",
);

pub const CONFIRM_KEYS: LocalizedText<&'static str> = LocalizedText::new(
    "回车 写入远程并登记 SSH 公钥 · Esc 取消",
    "enter write to the remote and register an SSH key · esc cancel",
);

pub const CONFIRM_LIST_TITLE: LocalizedText<&'static str> = LocalizedText::new(
    "将写入远程 gh 凭据并登记 SSH 公钥",
    "will write remote gh credentials and register an SSH key",
);

pub const SYNCING: LocalizedText<&'static str> = LocalizedText::new(
    "正在把本机 GitHub 登录同步到远程…",
    "syncing this machine's GitHub login onto the remote…",
);

/// Body of the TUI/App confirm screen. Never mentions the token value.
pub fn confirm_lines(host: &str) -> LocalizedText<Vec<String>> {
    LocalizedText::new(
        vec![
            format!("把本机 `gh` 登录写入 {host} 上的 ~/.config/gh/hosts.yml（权限 0600），"),
            "如缺少 SSH 密钥则生成 ed25519，并把公钥登记到 GitHub（标题 faragent-<host>）。".into(),
            String::new(),
            "本机未登录时请先在这台电脑运行 `gh auth login`（浏览器留在本机）。".into(),
            "凭据不会出现在界面、日志或命令行上。".into(),
            String::new(),
            "回车执行 · Esc 取消。".into(),
        ],
        vec![
            format!("Write this machine's `gh` login to ~/.config/gh/hosts.yml on {host} (mode 0600),"),
            "create an ed25519 SSH key if missing, and register the public key with GitHub (title faragent-<host>).".into(),
            String::new(),
            "If this laptop is not logged in, run `gh auth login` here first (the browser stays local).".into(),
            "The credential is never shown in the UI, logs, or argv.".into(),
            String::new(),
            "Enter runs · Esc cancels.".into(),
        ],
    )
}

impl GitHubSyncReport {
    /// User-facing summary. Never includes the token.
    pub fn lines(&self, host: &str) -> LocalizedText<Vec<String>> {
        let gh_zh = if self.remote_gh {
            "已安装"
        } else {
            "未安装"
        };
        let gh_en = if self.remote_gh {
            "installed"
        } else {
            "not installed"
        };
        let key_zh = if self.ssh_key_added {
            "已登记到 GitHub"
        } else {
            "未登记"
        };
        let key_en = if self.ssh_key_added {
            "registered with GitHub"
        } else {
            "not registered"
        };
        let mut zh = vec![
            format!("GitHub 已同步到 {host}"),
            format!("  用户: {}", self.user),
            format!("  远程 gh: {gh_zh}"),
            format!("  SSH 公钥: {key_zh}"),
        ];
        let mut en = vec![
            format!("GitHub synced onto {host}"),
            format!("  user: {}", self.user),
            format!("  remote gh: {gh_en}"),
            format!("  SSH key: {key_en}"),
        ];
        if !self.warnings.is_empty() {
            zh.push("  警告:".into());
            en.push("  warnings:".into());
            for w in &self.warnings {
                zh.push(format!("    {}", w.zh));
                en.push(format!("    {}", w.en));
            }
        }
        LocalizedText::new(zh, en)
    }

    pub fn plain(&self, host: &str, lang: faragent_core::text::Lang) -> String {
        self.lines(host).pick(lang).join("\n")
    }
}

pub fn hosts_yml(user: &str, token: &str) -> String {
    format!(
        "github.com:\n    git_protocol: https\n    users:\n        {user}:\n            oauth_token: {token}\n    user: {user}\n"
    )
}

pub fn parse_gh_login(json: &str) -> Result<String> {
    const KEY: &str = "\"login\"";
    for (i, _) in json.match_indices(KEY) {
        let after = json[i + KEY.len()..].trim_start();
        let Some(after) = after.strip_prefix(':') else {
            continue;
        };
        let after = after.trim_start();
        let Some(after) = after.strip_prefix('"') else {
            continue;
        };
        let mut login = String::new();
        let mut chars = after.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => {
                    if let Some(n) = chars.next() {
                        login.push(n);
                    }
                }
                '"' => break,
                _ => login.push(c),
            }
        }
        if !login.is_empty() {
            return Ok(login);
        }
    }
    Err(anyhow!("gh api user: missing login field"))
}

pub fn parse_remote_pubkey(text: &str) -> Result<(String, bool)> {
    let Some(idx) = text.find("FARAGENT_GH_V1") else {
        return Err(anyhow!(
            "remote output missing FARAGENT_GH_V1: {}",
            snippet(text)
        ));
    };
    let mut pubkey = None;
    let mut has_gh = false;
    for line in text[idx..].lines() {
        let line = line.trim_end_matches('\r');
        let Some((kind, rest)) = line.split_once('\t') else {
            continue;
        };
        match kind {
            "pubkey" => {
                let key = rest.trim();
                if !key.is_empty() {
                    pubkey = Some(key.to_string());
                }
            }
            "gh" => has_gh = rest.trim() == "ok",
            _ => {}
        }
    }
    match pubkey {
        Some(key) => Ok((key, has_gh)),
        None => Err(anyhow!(
            "remote output missing pubkey in FARAGENT_GH_V1: {}",
            snippet(text)
        )),
    }
}

/// Reads token then user (two stdin lines), writes `~/.config/gh/hosts.yml` mode 0600,
/// ensures `~/.ssh/id_ed25519`, prints a `FARAGENT_GH_V1` dump. Never prints the token.
pub fn posix_install_script() -> String {
    r#"
IFS= read -r _fa_gh_token || exit 1
IFS= read -r _fa_gh_user || exit 1
_gh_dir="$HOME/.config/gh"
mkdir -p "$_gh_dir" || exit 1
_hosts="$_gh_dir/hosts.yml"
umask 077
{
  printf 'github.com:\n'
  printf '    git_protocol: https\n'
  printf '    users:\n'
  printf '        %s:\n' "$_fa_gh_user"
  printf '            oauth_token: %s\n' "$_fa_gh_token"
  printf '    user: %s\n' "$_fa_gh_user"
} > "$_hosts" || exit 1
chmod 600 "$_hosts" || exit 1
unset _fa_gh_token
mkdir -p "$HOME/.ssh" || true
chmod 700 "$HOME/.ssh" || true
if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
  ssh-keygen -t ed25519 -q -N '' -f "$HOME/.ssh/id_ed25519" -C faragent >/dev/null 2>&1 || true
fi
_pub=""
if [ -f "$HOME/.ssh/id_ed25519.pub" ]; then
  _pub=$(tr -d '\t\r\n' < "$HOME/.ssh/id_ed25519.pub")
fi
printf 'FARAGENT_GH_V1\n'
printf 'pubkey\t%s\n' "$_pub"
if command -v gh >/dev/null 2>&1; then
  printf 'gh\tok\n'
else
  printf 'gh\tmissing\n'
fi
printf 'ok\n'
"#
    .to_string()
}

/// Token/user arrive as UTF-8 base64 `$args[0]` / `$args[1]`. Must not echo the token.
pub fn win_install_script() -> String {
    format!(
        r#"{preamble}
$token = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]))
$user = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[1]))
if ($env:GH_CONFIG_DIR) {{ $ghDir = $env:GH_CONFIG_DIR }}
elseif ($env:APPDATA) {{ $ghDir = Join-Path $env:APPDATA 'GitHub CLI' }}
else {{ $ghDir = Join-Path $env:USERPROFILE '.config\gh' }}
New-Item -ItemType Directory -Force -LiteralPath $ghDir | Out-Null
$hosts = Join-Path $ghDir 'hosts.yml'
$yml = @"
github.com:
    git_protocol: https
    users:
        ${{user}}:
            oauth_token: ${{token}}
    user: ${{user}}
"@
[IO.File]::WriteAllText($hosts, $yml)
$token = $null
$keyDir = Join-Path $env:USERPROFILE '.ssh'
$key = Join-Path $keyDir 'id_ed25519'
if (-not (Test-Path -LiteralPath $key)) {{
  New-Item -ItemType Directory -Force -LiteralPath $keyDir | Out-Null
  & ssh-keygen -t ed25519 -q -N '""' -f $key -C faragent 2>$null | Out-Null
}}
$pub = ''
$pubPath = $key + '.pub'
if (Test-Path -LiteralPath $pubPath) {{
  $pub = ((Get-Content -LiteralPath $pubPath -Raw -ErrorAction SilentlyContinue) -replace "[`t`r`n]", ' ').Trim()
}}
Write-Output 'FARAGENT_GH_V1'
Write-Output ("pubkey`t{{0}}" -f $pub)
if (Get-Command gh -ErrorAction SilentlyContinue) {{
  Write-Output "gh`tok"
}} else {{
  Write-Output "gh`tmissing"
}}
Write-Output 'ok'
"#,
        preamble = win::UTF8_PREAMBLE,
    )
}

pub fn sync_to_host(host: &str) -> Result<GitHubSyncReport> {
    let token = local_auth_token()?;
    let user = local_auth_user()?;
    let client = OpenSshTransport::connect(host)?;
    let os = host_os(host).unwrap_or_default();
    let dump = install_on_remote(&client, os, host, &token, &user)?;
    let (pubkey, remote_gh) = parse_remote_pubkey(&dump)?;
    let mut warnings = Vec::new();
    let ssh_key_added = add_ssh_key(host, &pubkey, &mut warnings);
    git_rewrite_on_remote(&client, os, remote_gh, &mut warnings);
    Ok(GitHubSyncReport {
        user,
        remote_gh,
        ssh_key_added,
        warnings,
    })
}

fn local_auth_token() -> Result<String> {
    let out = match spawn_gh(&["auth", "token"], None) {
        Ok(o) => o,
        Err(_) => return Err(not_logged_in_error()),
    };
    if !out.status.success() {
        return Err(not_logged_in_error());
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        return Err(not_logged_in_error());
    }
    Ok(token)
}

fn local_auth_user() -> Result<String> {
    if let Ok(out) = spawn_gh(&["api", "user", "--jq", ".login"], None) {
        let trimmed = String::from_utf8_lossy(&out.stdout);
        let trimmed = trimmed.trim();
        if out.status.success() && !trimmed.is_empty() && !trimmed.starts_with('{') {
            return Ok(trimmed.to_string());
        }
        if trimmed.contains("\"login\"") {
            return parse_gh_login(trimmed);
        }
    }
    let out = spawn_gh(&["api", "user"], None).map_err(|e| anyhow!("gh api user: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!("gh api user failed"));
    }
    parse_gh_login(String::from_utf8_lossy(&out.stdout).trim())
}

fn install_on_remote(
    client: &OpenSshTransport,
    os: HostOs,
    host: &str,
    token: &str,
    user: &str,
) -> Result<String> {
    match os {
        HostOs::Posix => {
            let stdin = format!("{token}\n{user}\n");
            let out = client.exec_login_stdin(&posix_install_script(), stdin.as_bytes())?;
            client.require_ok(&out)?;
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        HostOs::Windows => {
            let token_b64 = win::b64(token);
            let user_b64 = win::b64(user);
            run_win_login_args(
                client,
                &win_install_script(),
                &[&token_b64, &user_b64],
            )
            .map_err(|_| {
                anyhow!(
                    "远程写入 GitHub 凭据失败 ({host}) / remote GitHub credential install failed ({host})"
                )
            })
        }
    }
}

fn add_ssh_key(host: &str, pubkey: &str, warnings: &mut Vec<LocalizedText<String>>) -> bool {
    let title = format!("faragent-{host}");
    let mut payload = pubkey.as_bytes().to_vec();
    if !payload.ends_with(b"\n") {
        payload.push(b'\n');
    }
    let out = match spawn_gh(&["ssh-key", "add", "--title", &title, "-"], Some(&payload)) {
        Ok(o) => o,
        Err(e) => {
            warnings.push(ssh_key_warning(&e.to_string()));
            return false;
        }
    };
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    if ssh_key_add_accepted(out.status.success(), &stdout, &stderr) {
        true
    } else {
        let detail = first_nonempty(&stderr, &stdout);
        warnings.push(ssh_key_warning(&detail));
        false
    }
}

fn git_rewrite_on_remote(
    client: &OpenSshTransport,
    os: HostOs,
    remote_gh: bool,
    warnings: &mut Vec<LocalizedText<String>>,
) {
    let result = match os {
        HostOs::Posix => run_login(client, &posix_git_rewrite_script(remote_gh)),
        HostOs::Windows => run_win_login(client, &win_git_rewrite_script(remote_gh)),
    };
    if let Err(e) = result {
        let detail: String = e.to_string().chars().take(240).collect();
        warnings.push(LocalizedText::new(
            format!("远程 git 重写未完成：{detail}"),
            format!("remote git rewrite did not complete: {detail}"),
        ));
    }
}

fn posix_git_rewrite_script(remote_gh: bool) -> String {
    let mut s =
        String::from("git config --global url.git@github.com:.insteadOf https://github.com/");
    if remote_gh {
        s.push_str(" && gh auth setup-git");
    }
    s
}

fn win_git_rewrite_script(remote_gh: bool) -> String {
    let mut s = format!(
        "{}\n& git config --global -- 'url.git@github.com:.insteadOf' 'https://github.com/'",
        win::UTF8_PREAMBLE
    );
    if remote_gh {
        s.push_str("\n& gh auth setup-git");
    }
    s
}

fn ssh_key_add_accepted(ok: bool, stdout: &str, stderr: &str) -> bool {
    if ok {
        return true;
    }
    let blob = format!("{stdout}\n{stderr}");
    blob.contains("already exists") || blob.contains("422")
}

fn ssh_key_warning(detail: &str) -> LocalizedText<String> {
    let detail: String = detail.chars().take(200).collect();
    LocalizedText::new(
        format!("未能把远程 SSH 公钥登记到 GitHub：{detail}"),
        format!("could not register the remote SSH key with GitHub: {detail}"),
    )
}

fn not_logged_in_error() -> anyhow::Error {
    anyhow!("{} / {}", NOT_LOGGED_IN.zh, NOT_LOGGED_IN.en)
}

fn spawn_gh(args: &[&str], stdin: Option<&[u8]>) -> std::io::Result<Output> {
    let mut cmd = Command::new("gh");
    cmd.args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let Some(bytes) = stdin {
        if let Some(mut s) = child.stdin.take() {
            let _ = s.write_all(bytes);
        }
    }
    child.wait_with_output()
}

fn snippet(text: &str) -> String {
    text.trim().chars().take(400).collect()
}

fn first_nonempty(a: &str, b: &str) -> String {
    let a = a.trim();
    if !a.is_empty() {
        a.to_string()
    } else {
        b.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_yml_contains_user_and_token_and_mode_fields() {
        let y = hosts_yml("octocat", "gho_secret");
        assert!(y.contains("octocat"));
        assert!(y.contains("gho_secret"));
        assert!(y.contains("oauth_token"));
        assert!(y.contains("git_protocol: https"));
    }

    #[test]
    fn hosts_yml_exact_layout() {
        let y = hosts_yml("octocat", "gho_secret");
        assert_eq!(
            y,
            "github.com:\n    git_protocol: https\n    users:\n        octocat:\n            oauth_token: gho_secret\n    user: octocat\n"
        );
    }

    #[test]
    fn parse_gh_login_from_api_json() {
        assert_eq!(
            parse_gh_login(r#"{"login":"octocat","id":1}"#).unwrap(),
            "octocat"
        );
    }

    #[test]
    fn parse_gh_login_allows_spaces() {
        assert_eq!(
            parse_gh_login(r#"{ "login" : "octocat" }"#).unwrap(),
            "octocat"
        );
    }

    #[test]
    fn parse_gh_login_rejects_empty() {
        assert!(parse_gh_login("{}").is_err());
        assert!(parse_gh_login("not json").is_err());
    }

    #[test]
    fn parse_gh_login_skips_unicode_fields() {
        assert_eq!(
            parse_gh_login(r#"{"name":"你好","login":"octocat"}"#).unwrap(),
            "octocat"
        );
    }

    #[test]
    fn parse_remote_pubkey_dump() {
        let text = "\
FARAGENT_GH_V1
pubkey	ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake faragent
gh	missing
ok
";
        let (key, has_gh) = parse_remote_pubkey(text).unwrap();
        assert!(key.starts_with("ssh-ed25519 "));
        assert!(!has_gh);
    }

    #[test]
    fn parse_remote_pubkey_skips_banner_and_reads_gh_ok() {
        let text = "\
login banner
FARAGENT_GH_V1
pubkey	ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake faragent
gh	ok
ok
";
        let (key, has_gh) = parse_remote_pubkey(text).unwrap();
        assert!(key.starts_with("ssh-ed25519 "));
        assert!(has_gh);
    }

    #[test]
    fn parse_remote_pubkey_requires_marker() {
        let err = parse_remote_pubkey("no marker\npubkey\tssh-ed25519 x\n").unwrap_err();
        assert!(err.to_string().contains("FARAGENT_GH_V1"));
    }

    #[test]
    fn ssh_key_add_treats_already_exists_and_422_as_success() {
        assert!(ssh_key_add_accepted(true, "", ""));
        assert!(ssh_key_add_accepted(
            false,
            "",
            "HTTP 422: Validation Failed\nkey already exists"
        ));
        assert!(ssh_key_add_accepted(false, "", "HTTP 422: Unprocessable"));
        assert!(!ssh_key_add_accepted(
            false,
            "",
            "HTTP 401: Bad credentials"
        ));
    }

    #[test]
    fn report_and_confirm_never_include_a_token() {
        let report = GitHubSyncReport {
            user: "octocat".into(),
            remote_gh: true,
            ssh_key_added: true,
            warnings: vec![],
        };
        let text = format!(
            "{}\n{}",
            report.plain("home", faragent_core::text::Lang::Zh),
            report.plain("home", faragent_core::text::Lang::En)
        );
        assert!(text.contains("octocat"));
        assert!(text.contains("home"));
        assert!(!text.contains("gho_"));
        assert!(!text.contains("oauth_token"));
        let confirm = format!(
            "{:?}{:?}",
            confirm_lines("home").zh,
            confirm_lines("home").en
        );
        assert!(!confirm.contains("gho_"));
        assert!(!confirm.contains("oauth_token"));
        assert!(confirm.contains("hosts.yml"));
    }

    #[test]
    fn not_logged_in_is_bilingual() {
        assert!(NOT_LOGGED_IN.zh.contains("gh auth login"));
        assert!(NOT_LOGGED_IN.en.contains("gh auth login"));
        let msg = not_logged_in_error().to_string();
        assert!(msg.contains("本机未登录 GitHub"));
        assert!(msg.contains("GitHub CLI is not logged in"));
        assert!(!msg.contains("gho_"));
        assert!(!msg.contains("oauth_token"));
    }

    #[test]
    fn posix_install_script_writes_hosts_quietly() {
        let s = posix_install_script();
        assert!(s.contains("FARAGENT_GH_V1"));
        assert!(s.contains("chmod 600"));
        assert!(s.contains("ssh-keygen"));
        assert!(s.contains("ed25519"));
        assert!(s.contains("hosts.yml"));
        assert!(s.contains("IFS= read"));
        assert!(!s.contains("python"));
        assert_token_not_echoed(&s, "$_fa_gh_token");
    }

    #[test]
    fn win_install_script_decodes_args_quietly() {
        let s = win_install_script();
        assert!(s.contains("FARAGENT_GH_V1"));
        assert!(s.contains("[Console]::OutputEncoding"));
        assert!(s.contains("FromBase64String"));
        assert!(s.contains("ssh-keygen"));
        assert!(s.contains("hosts.yml"));
        assert!(s.contains("$args[0]"));
        assert!(s.contains("$args[1]"));
        assert!(!s.contains("Write-Output $token"));
        assert!(!s.contains("Write-Host $token"));
        assert!(!s.contains("echo $token"));
        assert_token_not_echoed(&s, "$token");
    }

    fn assert_token_not_echoed(script: &str, token_var: &str) {
        for line in script.lines() {
            let t = line.trim();
            if !t.contains(token_var) {
                continue;
            }
            let echoes = t.starts_with("echo ")
                || t.starts_with("Write-Output")
                || t.starts_with("Write-Host")
                || t.starts_with("printf") && !t.contains("oauth_token");
            assert!(
                !echoes,
                "token must not be printed, only written to hosts.yml: {t}"
            );
        }
    }
}

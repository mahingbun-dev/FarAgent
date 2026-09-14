# Session permissions, directory picker, GitHub sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default-on agent bypass flags, a remote directory picker for new sessions, and one-shot local-to-remote GitHub credential sync.

**Architecture:** Core APIs live in existing crates (`faragent-core` argv/config, `faragent-remote` dir protocol, `faragent-service` GitHub sync). TUI/CLI/App only consume those APIs. Tasks 1–3 touch disjoint files and can land as separate commits; Task 4 wires call sites.

**Tech Stack:** Rust 1.80 workspace, ratatui TUI, Tauri commands, system `ssh` + local `gh`.

**Spec:** `docs/superpowers/specs/2026-09-14-session-perms-dirs-github-design.md`

## Global Constraints

- Work only in this worktree: `/Users/maqb11/code/ma-code/FarAgent/.worktrees/session-perms-dirs-github` on branch `feat/session-perms-dirs-github`.
- TDD: failing test first, watch it fail, then implement. Tests live in the same crate (`#[cfg(test)]` modules), matching this repo.
- Do not add HTTP crates; local GitHub API goes through the `gh` CLI.
- Do not log or serialize GitHub tokens. Do not put tokens in argv.
- `new_argv()` / `resume_argv()` stay bare; new API is `launch_argv`.
- Pi with `full_permissions=true` does **not** gain extra flags (stock `pi` has no permission prompts; `--yolo` is not a core flag).
- Codex bypass flag must come **before** the `resume` subcommand.
- Default `full_permissions` is `true` when the config field is missing.
- Listing directories never creates them. Missing cwd still uses the existing confirm + `mkdir` path.
- Chinese + English strings for any new TUI/CLI user-facing text (`LocalizedText` in service; `Chrome` trait in TUI).
- `cargo test --workspace` must pass before each commit. Do not commit unless tests you added were seen failing first.
- Commit messages follow this repo: `crate: what changed` (e.g. `core: launch_argv with bypass flags`).

## File map

| File | Responsibility |
| --- | --- |
| `crates/faragent-core/src/agents.rs` | `launch_argv(session_id, full_permissions)` |
| `crates/faragent-core/src/config.rs` | `full_permissions` field + getters |
| `crates/faragent-remote/src/dirs.rs` | `FARAGENT_DIRS_V1` scripts + parser + `join_dir` (new file) |
| `crates/faragent-remote/src/lib.rs` | `pub mod dirs` |
| `crates/faragent-service/src/github.rs` | local `gh` + remote write + `gh ssh-key add` (new file) |
| `crates/faragent-service/src/lib.rs` | `pub mod github` |
| `crates/faragent-service/src/dirs.rs` | `list_dirs(host, os, path)` (new file, Task 4) |
| `crates/faragent-remote/src/remote.rs` | `start_script` uses `launch_argv` (Task 4) |
| `crates/faragent-service/src/sessions.rs` | pass `full_permissions` into start (Task 4) |
| `crates/faragent-tui/src/tui.rs` + `chrome.rs` | picker, `p` toggle, `G` github, `s` to start |
| `crates/faragent-cli/src/main.rs` | `github-sync` subcommand |
| `apps/faragent-app/src-tauri/src/{commands,attach,lib}.rs` | IPC + WinAgent argv |

---

### Task 1: launch_argv + config.full_permissions

**Files:**
- Modify: `crates/faragent-core/src/agents.rs`
- Modify: `crates/faragent-core/src/config.rs`
- Test: same files' `#[cfg(test)]` modules

**Interfaces:**
- Consumes: existing `new_argv` / `resume_argv`
- Produces:
  - `AgentKind::launch_argv(self, session_id: Option<&str>, full_permissions: bool) -> Vec<String>`
  - `Config.full_permissions: bool` with serde default **true**
  - `config::full_permissions() -> bool`
  - `config::set_full_permissions(on: bool) -> Result<()>`

**Do not** change `new_argv` / `resume_argv` bodies or any other crate.

- [ ] **Step 1: Write the failing tests in `agents.rs`**

```rust
#[test]
fn launch_argv_bare_matches_new_and_resume() {
    for agent in AgentKind::ALL {
        assert_eq!(agent.launch_argv(None, false), agent.new_argv());
        assert_eq!(agent.launch_argv(Some("abc"), false), agent.resume_argv("abc"));
    }
}

#[test]
fn launch_argv_full_permissions_per_agent() {
    assert_eq!(
        AgentKind::Claude.launch_argv(None, true),
        vec!["claude", "--permission-mode", "bypassPermissions"]
    );
    assert_eq!(
        AgentKind::Claude.launch_argv(Some("abc"), true),
        vec!["claude", "--resume", "abc", "--permission-mode", "bypassPermissions"]
    );
    assert_eq!(
        AgentKind::Codex.launch_argv(None, true),
        vec!["codex", "--dangerously-bypass-approvals-and-sandbox"]
    );
    assert_eq!(
        AgentKind::Codex.launch_argv(Some("abc"), true),
        vec![
            "codex",
            "--dangerously-bypass-approvals-and-sandbox",
            "resume",
            "abc"
        ]
    );
    assert_eq!(
        AgentKind::Grok.launch_argv(None, true),
        vec!["grok", "--always-approve"]
    );
    assert_eq!(
        AgentKind::Grok.launch_argv(Some("abc"), true),
        vec!["grok", "--resume", "abc", "--always-approve"]
    );
    assert_eq!(AgentKind::Pi.launch_argv(None, true), vec!["pi"]);
    assert_eq!(
        AgentKind::Pi.launch_argv(Some("abc"), true),
        vec!["pi", "--session", "abc"]
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p faragent-core --lib launch_argv -- --nocapture`

Expected: FAIL compiling (`launch_argv` not found) or assertion fail.

- [ ] **Step 3: Implement `launch_argv`**

Keep `new_argv`/`resume_argv` as they are. `launch_argv` builds from them except Codex+full, which prefixes the bypass flag before `resume`.

- [ ] **Step 4: Write failing config tests then implement**

```rust
#[test]
fn full_permissions_defaults_true_when_absent() {
    let cfg: Config = serde_json::from_str("{}").unwrap();
    assert!(cfg.full_permissions);
    let off: Config = serde_json::from_str(r#"{"full_permissions":false}"#).unwrap();
    assert!(!off.full_permissions);
}

fn default_true() -> bool {
    true
}
```

On `Config`:

```rust
/// When true (the default), new and idle-resume launches pass that agent's
/// bypass / full-permission flag. Live attach does not re-exec.
#[serde(default = "default_true")]
pub full_permissions: bool,
```

Add `full_permissions()` / `set_full_permissions`. `#[serde(default)]` on bool is **false** — must use `default = "default_true"`. Existing `Config { language: ..., ..Default::default() }` in tests still works if `Default` sets `full_permissions: true` (implement `Default` manually or `#[serde(default = "default_true")]` plus `#[derive(Default)]` will default bool to false).

**Ruling for Default:** do **not** `#[derive(Default)]` if that forces `full_permissions: false`. Replace `#[derive(Default)]` with a manual `Default` that sets `full_permissions: true`, `language: None`, `hosts: empty`. Update any test that assumed derive Default.

- [ ] **Step 5: Run `cargo test -p faragent-core` — all pass**
- [ ] **Step 6: Commit** `core: launch_argv and full_permissions default on`

---

### Task 2: FARAGENT_DIRS_V1 protocol

**Files:**
- Create: `crates/faragent-remote/src/dirs.rs`
- Modify: `crates/faragent-remote/src/lib.rs` (add `pub mod dirs;` only)
- Test: `dirs.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `HostOs`, `shell_single_quote` (`faragent_core::shell`), `win::b64` / `UTF8_PREAMBLE` / `ps_single_quote`
- Produces:
  - `pub struct DirListing { pub cwd: String, pub parent: String, pub dirs: Vec<String> }`
  - `pub enum DirListError { NotADir { path: String }, Unreadable { path: String, hint: String } }`
  - `pub fn posix_list_script(path: &str) -> String`
  - `pub fn win_list_script() -> String` (path is `$args[0]` base64, same as other win scripts)
  - `pub fn parse_listing(text: &str) -> Result<DirListing, DirListError>`
  - `pub fn join_dir(cwd: &str, name: &str, os: HostOs) -> String`

Protocol (stdout after login-shell noise). Marker required:

```
FARAGENT_DIRS_V1
cwd	/home/me
parent	/home
dir	code
dir	docs
ok
```

Errors (still after the marker):

```
FARAGENT_DIRS_V1
err	not_a_dir	/nope
```

```
FARAGENT_DIRS_V1
err	unreadable	/secret
```

POSIX script: quote `path` with `shell_single_quote`. `if [ ! -d path ]` → `not_a_dir`. List **directories only** (`[ -d ]`), skip `.` and `..`. `parent=$(dirname -- path)` ; if path is `/` then parent is `/`. No `python`. No `mkdir`.

Windows script: decode `$args[0]` as UTF-8 cwd. `Test-Path -LiteralPath` directory; `Get-ChildItem -LiteralPath -Directory -Force`. Parent: `[IO.Path]::GetDirectoryName`; drive root parent is the root itself (e.g. `C:\`). Use `UTF8_PREAMBLE`. Emit the same tab-separated shape.

`join_dir`:
- Posix: if cwd is `/`, `/{name}`; else `{cwd}/{name}` with no double slash
- Windows: trim trailing `\` except drive root `C:\`; join with `\`
- `name == ".."` returns `parent` equivalent (posix `dirname`, windows GetDirectoryName)

- [ ] **Step 1: Write failing parse tests**

```rust
#[test]
fn parse_listing_reads_cwd_parent_and_dirs() {
    let text = "\
banner
FARAGENT_DIRS_V1
cwd	/home/me
parent	/home
dir	code
dir	docs
ok
";
    let l = parse_listing(text).unwrap();
    assert_eq!(l.cwd, "/home/me");
    assert_eq!(l.parent, "/home");
    assert_eq!(l.dirs, vec!["code", "docs"]);
}

#[test]
fn parse_listing_not_a_dir() {
    let text = "FARAGENT_DIRS_V1\nerr\tnot_a_dir\t/nope\n";
    match parse_listing(text) {
        Err(DirListError::NotADir { path }) => assert_eq!(path, "/nope"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn join_dir_posix_and_windows() {
    use faragent_core::vocab::HostOs;
    assert_eq!(join_dir("/home/me", "code", HostOs::Posix), "/home/me/code");
    assert_eq!(join_dir("/", "etc", HostOs::Posix), "/etc");
    assert_eq!(join_dir("C:\\Users\\me", "code", HostOs::Windows), "C:\\Users\\me\\code");
    assert_eq!(join_dir("C:\\", "Users", HostOs::Windows), "C:\\Users");
}
```

- [ ] **Step 2: Run `cargo test -p faragent-remote --lib dirs::` — expect FAIL**
- [ ] **Step 3: Implement parser, join_dir, scripts**
- [ ] **Step 4: Script tests**

```rust
#[test]
fn posix_script_has_marker_no_python_no_mkdir() {
    let s = posix_list_script("/home/me/app");
    assert!(s.contains("FARAGENT_DIRS_V1"));
    assert!(s.contains("'/home/me/app'"));
    assert!(!s.contains("python"));
    assert!(!s.contains("mkdir"));
}

#[test]
fn win_script_has_marker_and_preamble() {
    let s = win_list_script();
    assert!(s.contains("FARAGENT_DIRS_V1"));
    assert!(s.contains("Get-ChildItem"));
    assert!(s.contains("[Console]::OutputEncoding"));
}
```

- [ ] **Step 5: `cargo test -p faragent-remote` passes**
- [ ] **Step 6: Commit** `remote: FARAGENT_DIRS_V1 directory listing protocol`

---

### Task 3: GitHub sync service (pure + local gh helpers)

**Files:**
- Create: `crates/faragent-service/src/github.rs`
- Modify: `crates/faragent-service/src/lib.rs` (`pub mod github;` only)
- Test: `github.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `OpenSshTransport`, `run_login` / `run_win_login_args`, `shell_single_quote`
- Produces:
  - `pub struct GitHubSyncReport { pub user: String, pub remote_gh: bool, pub ssh_key_added: bool, pub warnings: Vec<LocalizedText<String>> }`
  - `pub fn hosts_yml(user: &str, token: &str) -> String`
  - `pub fn parse_gh_login(json: &str) -> Result<String>` (`{"login":"octocat",...}` → `octocat`)
  - `pub fn parse_remote_pubkey(text: &str) -> Result<(String, bool)>` from `FARAGENT_GH_V1` dump (`pubkey` line, `gh	ok|missing`)
  - `pub fn posix_install_script() -> String` — reads token + user from stdin as two lines, writes hosts.yml 0600, ensures ed25519 key, prints marker dump. **Does not** print the token.
  - `pub fn win_install_script() -> String` — token/user via base64 `$args[0]` `$args[1]` (Windows has no cheap stdin pairing with our exec helper); still must not echo the token.
  - `pub fn sync_to_host(host: &str) -> Result<GitHubSyncReport>`

`hosts_yml` exact body:

```yaml
github.com:
    git_protocol: https
    users:
        {user}:
            oauth_token: {token}
    user: {user}
```

`sync_to_host` steps (integration, unit-test the helpers; the function itself may be thin):

1. `gh auth token` on this machine (stdout trimmed). Failure → `anyhow` with LocalizedText-quality message: 本机未登录 GitHub，请先运行 `gh auth login` / "GitHub CLI is not logged in on this machine; run `gh auth login` first".
2. `gh api user --jq .login` → username.
3. SSH `posix_install_script` with stdin `token\nuser\n` (POSIX) or win args.
4. Parse pubkey. Local: `gh ssh-key add --title faragent-{host} -` with pubkey on stdin. Exit 0 or stderr containing `already exists` / HTTP 422 → `ssh_key_added: true`. Other errors → warning, do not fail the whole sync (token is already on the remote).
5. Remote `git config --global url.git@github.com:.insteadOf https://github.com/`. If `gh` present, `gh auth setup-git`.

Never `println!` the token. Do not put it in `GitHubSyncReport`.

- [ ] **Step 1: Failing tests for hosts_yml, parse_gh_login, parse_remote_pubkey**

```rust
#[test]
fn hosts_yml_contains_user_and_token_and_mode_fields() {
    let y = hosts_yml("octocat", "gho_secret");
    assert!(y.contains("octocat"));
    assert!(y.contains("gho_secret"));
    assert!(y.contains("oauth_token"));
    assert!(y.contains("git_protocol: https"));
}

#[test]
fn parse_gh_login_from_api_json() {
    assert_eq!(parse_gh_login(r#"{"login":"octocat","id":1}"#).unwrap(), "octocat");
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
```

- [ ] **Step 2: Run `cargo test -p faragent-service --lib github::` — FAIL**
- [ ] **Step 3: Implement helpers + scripts + `sync_to_host`**
- [ ] **Step 4: Script tests: marker present, no token echo (`printf` of token forbidden except writing the file), `chmod 600`, `ssh-keygen`**
- [ ] **Step 5: `cargo test -p faragent-service` passes**
- [ ] **Step 6: Commit** `service: sync local gh login onto a remote host`

---

### Task 4: Wire TUI, CLI, sessions, App

**Files:**
- Modify: `crates/faragent-remote/src/remote.rs` (`start_script` takes `full_permissions: bool` and uses `launch_argv`)
- Modify: `crates/faragent-service/src/sessions.rs` (`ensure_*` read `config::full_permissions()`)
- Create: `crates/faragent-service/src/dirs.rs` + `pub mod dirs` in service `lib.rs`
- Modify: `crates/faragent-tui/src/tui.rs`, `chrome.rs`
- Modify: `crates/faragent-cli/src/main.rs`
- Modify: `apps/faragent-app/src-tauri/src/attach.rs` (WinAgent uses `launch_argv`)
- Modify: `apps/faragent-app/src-tauri/src/commands.rs` + `lib.rs` (list_dirs, github_sync, get/set full_permissions)
- Modify: `apps/faragent-app/src/components/dialogs.tsx`, `pages.tsx` if they compile; add ipc wrappers under `src/lib/` **only as needed** for these commands
- Docs: `docs/zh/user-guide.md` and `docs/en/user-guide.md` — new session keys, `p` toggle, `G` / `github-sync`

**Interfaces:**
- Consumes: Task 1 `launch_argv` + `full_permissions`; Task 2 `dirs::*`; Task 3 `github::sync_to_host`
- Produces: user-visible flows

**start_script signature** — add `full_permissions: bool` as the last argument. Update every call and every test in `remote.rs` that currently calls `start_script(..., false)` so they pass a sixth arg. When `full_permissions` is true, the inner `exec` line must contain the Claude/Codex/Grok flags from Task 1 (assert in a new test `start_script_full_permissions_embeds_flags`).

**service `list_dirs(host, os, path)`:** connect, run posix or win script, parse. Expand nothing; caller expands `~`.

**TUI NewCwd:**
- State: `dir_listing: Option<DirListing>`, `dir_idx: usize`, keep `cwd_input`.
- On `begin_new`, list `cwd_input` (after expanding if it is already absolute/home). Recents = unique `session.cwd` values, shown above the listing.
- Keys: `j/k` move in the combined list; `Enter` on `..` or a child **navigates** (updates `cwd_input`, re-lists); `Enter` on a **recent** navigates to that path; `s` starts the session in current `cwd_input` (same `start_session` path as today's Enter); `Tab` re-lists current input; typing still edits `cwd_input`. Esc back to sessions.
- Footer: Chinese/English via Chrome.

**TUI `p` on Sessions (and NewCwd):** toggle `config::set_full_permissions`, status shows 完全权限 / 需确认.

**TUI `G` on Hosts:** confirm screen (will write `~/.config/gh/hosts.yml` and register an SSH key). Enter runs `github::sync_to_host`, shows report or diagnosis. Never display the token.

**CLI:**

```
GithubSync { #[arg(long)] host: String }
```

Print the report in the configured language.

**App attach.rs:** `agent.launch_argv(session_id.as_deref(), faragent_core::config::full_permissions())`.

**App commands:** `list_dirs(host, path)`, `github_sync(host)`, `get_full_permissions`, `set_full_permissions`. Register in `lib.rs`.

**App NewSessionDialog:** path input + list of dirs (fetch `list_dirs` when path changes) + checkbox bound to `full_permissions`. Hosts page: button 同步 GitHub.

If `src/lib/ipc.ts` does not exist, create a minimal `ipc.ts` with `invoke` wrappers for the new commands **and** the existing ones `pages.tsx` already imports, enough for TypeScript to typecheck those files. Do not invent a new visual design system.

- [ ] **Step 1: Failing test `start_script` sixth argument + flag embedding** (in `remote.rs` tests)
- [ ] **Step 2: Implement start_script + session ensure**
- [ ] **Step 3: TUI picker + keys + chrome strings; add unit tests for any pure helpers (e.g. recents unique, join navigation)**
- [ ] **Step 4: CLI github-sync**
- [ ] **Step 5: App commands + attach argv**
- [ ] **Step 6: user-guide zh+en**
- [ ] **Step 7: `cargo test --workspace` green**
- [ ] **Step 8: Commit** `tui: directory picker, permission toggle, github-sync`

---

## Self-review

- Spec §1 flags → Task 1 + Task 4 start_script.
- Spec §1 default on → Task 1 serde default_true.
- Spec §1 Pi exception → Task 1 tests.
- Spec §1 Codex flag order → Task 1 tests.
- Spec §2 listing → Task 2; UI → Task 4.
- Spec §3 sync → Task 3 helpers + Task 4 CLI/TUI/App.
- No token in logs/argv → Task 3 constraints.
- No placeholders left.

# Session permissions, directory picker, GitHub sync

Approved 2026-09-14. Three independent features sharing the session-start path.

## 1. Full permissions (default on)

New and idle-resume agent processes start with that agent's bypass / full-permission flag. Live tmux attach does not re-exec, so flags do not apply to an already-running pane.

`~/.faragent/config.json` field `full_permissions` defaults to `true` when absent. TUI and App can turn it off; the value is global.

| Agent | `launch_argv(session_id, true)` |
| --- | --- |
| Claude new | `claude --permission-mode bypassPermissions` |
| Claude resume | `claude --resume <id> --permission-mode bypassPermissions` |
| Codex new | `codex --dangerously-bypass-approvals-and-sandbox` |
| Codex resume | `codex --dangerously-bypass-approvals-and-sandbox resume <id>` (flag **before** subcommand) |
| Grok new | `grok --always-approve` |
| Grok resume | `grok --resume <id> --always-approve` |
| Pi | unchanged (`pi` / `pi --session <id>`). Vanilla Pi has no permission prompts; `--yolo` is not a core flag and would crash stock `pi`. |

`new_argv()` / `resume_argv()` stay bare (existing tests). All start/attach call sites switch to `launch_argv`.

## 2. Remote directory picker

New-session UI lists remote directories instead of requiring a fully typed path. Typed paths remain valid.

- Protocol `FARAGENT_DIRS_V1` on POSIX (bash) and Windows (PowerShell).
- Lists **directories only** in one level of `path`.
- Emits `cwd`, `parent`, and `dir` names. `/` and `C:\` parent as themselves.
- TUI: keep `cwd>` input; list recents (unique session cwds) then `..` then children. `Enter` on `..`/child **navigates**; `s` **starts** in the current path. Tab refreshes. `~` still expands against remote home.
- App: same browser inside `NewSessionDialog`.
- Missing directory still uses the existing mkdir confirm screen. Listing never creates directories.

## 3. GitHub credential sync (local login → remote disk)

Not SSH agent forwarding (ControlMaster key persist is 10 minutes; forwarding dies with it).

Once per host, from the laptop:

1. Local `gh auth token` + `gh api user --jq .login`. If not logged in, tell the user to run `gh auth login` on this machine (browser stays local).
2. SSH: write `~/.config/gh/hosts.yml` (mode 0600) with the oauth token; `ssh-keygen -t ed25519` if no key; print pubkey.
3. Local `gh ssh-key add` of that pubkey titled `faragent-<host>`. Already-exists is success.
4. Remote: `git config --global url.git@github.com:.insteadOf https://github.com/`. If `gh` is on PATH, also `gh auth setup-git`.

Token never appears in argv, logs, or `config.json`. stdin / file only.

CLI: `faragent github-sync --host <alias>`. TUI: `G` on the hosts list (distinct from `g` auth mode), with a confirm screen. App: same action on the hosts page.

## Surfaces

TUI + CLI are the complete product. Tauri commands are wired the same way. App webview (`NewSessionDialog`, hosts page) is updated; if `apps/faragent-app/src/lib/` is missing, create the ipc wrappers this feature needs (do not rebuild the whole app).

## Out of scope

Windows session persistence, App visual redesign, copying API keys back to the laptop, SSH agent forwarding as the GitHub mechanism.

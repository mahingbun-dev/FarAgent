# User guide

`everywhere` is a local TUI. It SSHs into a machine you already use, finds Claude Code / Codex / Grok Build / Pi, and attaches their **native** terminal UI. Model calls use the **remote** login and config.

Chinese version: [用户手册](zh/user-guide.md)

## Requirements

### On your laptop

- macOS or Linux (Windows as a *client* is not supported yet)
- OpenSSH (`ssh`)
- A concrete `Host` entry in `~/.ssh/config` (see below)
- Key or `ssh-agent` login — **BatchMode**. Password, OTP, and jump hosts are out of scope for v0.1

### On the remote machine

| Need | Notes |
| --- | --- |
| `sshd` | Normal SSH server |
| `tmux` | everywhere will **not** install it |
| `python3` | Probe and session listing |
| At least one agent | `claude`, `codex`, `grok`, or `pi` on the **login-shell** PATH |
| Agent already authenticated | everywhere does not complete OAuth for you |

**Windows remotes:** SSH into **WSL2** (`sshd` inside the distro). Native Win32 OpenSSH + ConPTY is not a v0.1 target.

Install the agents with their official installers on the remote, then log in once there (`claude`, `codex login`, `grok login --device-auth`, `pi` `/login`, etc.).

## Install everywhere

You need a Rust toolchain (1.80+) on the laptop only.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone https://github.com/mahingbun-dev/everywhere-to-agent.git
cd everywhere-to-agent
cargo install --path .
everywhere --help
```

From a local checkout while developing:

```bash
cargo build
./target/debug/everywhere
```

Nothing is installed on the remote except a helper script under `~/.everywhere/` the first time you probe (tmux config + `remote.py`). No apt/brew packages.

## SSH config

The picker reads **non-pattern** `Host` names. `Host *`, `Host *.github.com`, and `?` globs are skipped.

```ssh-config
Host home-mac
    HostName 192.168.1.8
    User alex
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

Host gpu-box
    HostName gpu.example.com
    User coder
```

Check before opening the TUI:

```bash
ssh home-mac true
everywhere doctor
everywhere doctor --host home-mac
```

`doctor` without `--host` lists aliases it can see. With `--host` it prints remote `PATH`, tmux, and each agent’s version.

If `doctor` says an agent is missing but you can run it after `ssh -t host`, the login shell PATH is the usual culprit (nvm, Homebrew, `~/.local/bin`). everywhere always probes with `bash -lc`.

## Everyday flow

```bash
everywhere
```

| Screen | What you do |
| --- | --- |
| **Hosts** | Choose a `Host`. Enter runs a probe. |
| **Agents** | Installed agents show a version; others say `not installed`. Enter opens sessions. |
| **Sessions** | `[live]` is a tmux pane still running. `[idle]` is a transcript on disk. |
| **New cwd** | `n` — type a remote directory that already exists, Enter to start. |

Keys (manager TUI):

| Key | Action |
| --- | --- |
| `j` / `k` or arrows | Move |
| Enter | Probe / open / attach or resume |
| `n` | New session (remote cwd) |
| `r` | Refresh |
| `?` | Short help |
| `q` or Esc | Back / quit |
| `Ctrl-c` | Quit |

Once the native agent fills the screen:

| Key | Action |
| --- | --- |
| **`Ctrl-g` then `d`** | Detach. Agent **keeps running** on the remote. You return to the session list. |
| Agent `/quit` (or equivalent) | Ends the agent; the tmux session goes away; the row becomes idle. |

Prefix is **`Ctrl-g`**, not tmux’s usual `Ctrl-b`, so it fights less with agent bindings. This applies only to the isolated tmux socket named `everywhere` — your default tmux server is not modified.

### Live vs idle

- **live** — tmux still has that session. everywhere **only attaches**. It will not run `codex resume` / `claude --resume` / … on a live pane (that is how people get two agents editing one repo).
- **idle** — no tmux pane. everywhere starts a new pane with the agent’s resume command in the session’s working directory.

### New session

1. Open the agent’s session list.
2. Press `n`.
3. Confirm a directory that **already exists** on the remote (`test -d`). everywhere does not create project folders.
4. Enter — a new tmux session starts `claude` / `codex` / `grok` / `pi` with a login shell.

## CLI (no TUI)

```bash
everywhere                  # same as: everywhere tui
everywhere tui
everywhere doctor
everywhere doctor --host home-mac
everywhere probe --host home-mac
everywhere sessions --host home-mac --agent grok
```

`probe` and `sessions` print JSON (automation / debugging). Agent names: `claude`, `codex`, `grok`, `pi`.

## Agents

| Product | Binary | New | Resume idle | Sessions on disk |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `claude --resume <id>` | `~/.claude/projects/**/*.jsonl` |
| Codex | `codex` | `codex` | `codex resume <id>` | `~/.codex/sessions/**/*.jsonl` |
| Grok Build | `grok` | `grok` | `grok --resume <id>` | `~/.grok/sessions/<cwd-encoded>/<id>/` |
| Pi | `pi` | `pi` | `pi --session <id>` | `~/.pi/agent/sessions/` |

Auth files (hint only, never copied locally): e.g. `~/.grok/auth.json`, `~/.codex/auth.json`. If the native TUI asks you to log in, do it **on that remote**. Device-code flows (`grok login --device-auth`) are the usual headless path.

## Detach, disconnect, come back

1. `Ctrl-g d` — clean detach, manager TUI returns.
2. Kill the local app or drop Wi-Fi — the remote tmux pane **stays**.
3. Run `everywhere` again, same host + agent, open the `[live]` row.

Do not SSH in by hand and `codex resume` the same id while the pane is live.

## Terminal quality

everywhere forwards your `TERM` / `COLORTERM` through `ssh -tt`. The dedicated tmux config enables mouse, truecolor (`RGB`), and OSC 52 clipboard.

Use a terminal with 256 colors and mouse (Ghostty, iTerm2, Kitty, WezTerm, Windows Terminal over SSH from Linux/macOS clients). If Grok’s `/doctor` complains about clipboard, its own `grok wrap ssh` is optional; everywhere does not require it.

Resize the window: OpenSSH sends `SIGWINCH`; the agent TUI should relayout.

## Security model

- SSH is system OpenSSH. Keys stay in your agent / `IdentityFile`.
- Remote helper lives in `~/.everywhere/` on the **remote** account you SSH as.
- tmux listens on a private socket (`-L everywhere`), not a TCP port.
- No API keys are written to the laptop.
- everywhere never `apt`/`brew` installs software on the host.

Treat SSH access as full access to that user’s agents and repos — because it is.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Host list empty | Add a non-wildcard `Host` to `~/.ssh/config` |
| `Permission denied` / hangs on password | Set up keys; BatchMode cannot prompt |
| Agent `not installed` but works in SSH | Login PATH: nvm, Homebrew, `~/.local/bin`. `everywhere doctor --host X` prints `PATH` |
| `tmux_missing` | Install tmux on the remote yourself |
| `cwd_missing` | Directory must exist; everywhere will not `mkdir` a project |
| Probe JSON missing / `python3` error | Install Python 3 on the remote |
| Garbled TUI | Truecolor terminal; detach and reattach after resize |
| Two agents on one repo | You resumed a **live** session by hand. Use attach only |
| macOS remote cannot read Desktop/Documents | Grant Full Disk Access to `sshd` (TCC). everywhere cannot bypass this |
| `ControlMaster` feels stuck | `ssh -O exit -o ControlPath=~/.everywhere/cm/%r@%h:%p host` then retry |

## What v0.1 does not do

Password SSH, OTP, `ProxyJump`, installing tmux/agents for you, a custom chat UI, session delete/rename/fork, phone or browser clients, native Windows OpenSSH, copying remote credentials to the laptop.

## See also

- [Development](development.md) — architecture and contributing
- [计划书](../plans/2026-09-12-everywhere-to-agent.md) — original scope

# User guide

**English** · [中文](../zh/user-guide.md)

**FarSSH** (`farssh`) is a local TUI. It SSHs into a machine you already use, finds Claude Code / Codex / Grok Build / Pi, and attaches their **native** terminal UI. Model calls use the **remote** login and config.

Contents:

- [Requirements](#requirements)
- [Developer mode](#developer-mode)
- [Using a packaged binary on this machine](#using-a-packaged-binary-on-this-machine)
- [Moving the binary to another computer](#moving-the-binary-to-another-computer)
- [SSH config](#ssh-config)
- [Language](#language)
- [Everyday flow](#everyday-flow)
- [Install, upgrade, uninstall](#install-upgrade-uninstall)
- [CLI (no TUI)](#cli-no-tui)
- [Agents](#agents)
- [Detach, disconnect, come back](#detach-disconnect-come-back)
- [Troubleshooting](#troubleshooting)

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
| `bash` | Login shell; farssh probes with `bash -lc` |
| `tmux` | Required to attach. If missing, FarSSH can install it (brew, or sudo + apt/dnf/yum/pacman/apk) |
| At least one agent | `claude`, `codex`, `grok`, or `pi` on the **login-shell** PATH. Missing agents can be installed from the TUI |
| Agent already authenticated | farssh does not complete OAuth for you |

**Windows remotes (v0.1):** SSH into **WSL2** (`sshd` inside the distro). Native Win32 OpenSSH is on the [roadmap](roadmap.md).

You can install agents from the TUI (official `curl | bash` into the user directory, no sudo) or run those installers yourself on the remote, then log in once there (`claude`, `codex login`, `grok login --device-auth`, `pi` `/login`, etc.).

The laptop never copies API keys. Probe and session listing run in Rust locally; the remote runs bash, tmux, and the official installers you confirm. First session start still writes `~/.farssh/tmux.conf`. No python3, no farssh binary on the target.

There are three ways to run the laptop side: **hack on the source**, **use a release binary here**, or **copy that binary to another computer**. The remote machine that holds your agents does not need Rust or this repository.

## Developer mode

Use this when you are editing code, running tests, and launching the latest TUI from a git checkout. The laptop needs **Rust 1.80+** and Git.

### Clone and compile

```bash
# if rustup is missing
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

git clone https://github.com/mahingbun-dev/FarSSH.git
cd FarSSH
cargo build
```

The debug binary is `target/debug/farssh`.

### Everyday commands

`cargo run` builds if needed, then execs. Put `--` before farssh’s own flags so cargo does not swallow them:

```bash
cargo test
cargo fmt
cargo run -- --help
cargo run -- --version
cargo run                          # TUI
cargo run -- doctor
cargo run -- doctor --host home-mac
cargo run -- probe --host home-mac
cargo run -- sessions --host home-mac --agent grok
```

Or invoke the file directly:

```bash
./target/debug/farssh
./target/debug/farssh doctor --host home-mac
```

For panics:

```bash
RUST_BACKTRACE=1 cargo run -- doctor --host home-mac
```

After changing `src/`, `cargo build` or `cargo run` is enough. The laptop talks to the remote with `bash -lc`; there is no helper script to refresh.

The debug build is slower. For daily use, pack a **release** binary as in the next section.

How to change architecture or add an agent: [Development](development.md).

## Using a packaged binary on this machine

When you are not hacking, build **release**. Rust is only required on the machine that compiles; afterwards you can keep just the binary.

### Build release

From the repo root:

```bash
cd FarSSH
cargo build --release
./target/release/farssh --help
./target/release/farssh --version
```

The artifact is a single executable:

| OS | Path |
| --- | --- |
| macOS / Linux | `target/release/farssh` |

The laptop still needs system `ssh` (`command -v ssh`). farssh does **not** bundle OpenSSH; the destination machine must provide `ssh` too.

### Install onto PATH (recommended)

```bash
cargo install --path .
```

This writes `~/.cargo/bin/farssh`. If the shell cannot find it:

```bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc
which farssh
farssh --help
```

Upgrade (after `git pull` in the repo):

```bash
git pull
cargo install --path . --force
```

Uninstall:

```bash
cargo uninstall farssh
# or: rm ~/.cargo/bin/farssh
```

### Run the file without installing

```bash
./target/release/farssh
/absolute/path/farssh doctor --host home-mac
```

You still need [SSH config](#ssh-config) and a working `ssh <Host> true`.

## Moving the binary to another computer

A release build is **one file**. The other computer does **not** need Rust or the source tree. Copy `farssh`, plus that computer’s own SSH config and keys.

Do not relocate the remote box that already has claude/codex/grok/pi. The new laptop only has to SSH there.

### 1. Pack on the original machine

```bash
cd FarSSH
cargo build --release
uname -m          # arm64 or x86_64 — the destination must match
file target/release/farssh
```

| Built on | Destination must be |
| --- | --- |
| Apple Silicon Mac (`arm64`) | Apple Silicon |
| Intel Mac (`x86_64`) | Intel Mac |
| Linux x86_64 | Linux x86_64 (glibc should not be much older) |

v0.1 **cannot** run a macOS binary on Linux, and cannot run as a Windows client yet ([roadmap](roadmap.md)).

### 2. What to copy and what to leave

**Copy:**

- `target/release/farssh` (keep the executable bit)

**Do not ship in the same bundle:**

- The git repo, `target/debug/`, or build caches
- `~/.ssh/` private keys (move keys separately and safely; do not email them next to the binary)
- Remote `~/.farssh/`, agent transcripts, or API keys (those stay on the remote)

USB, AirDrop, or `scp`:

```bash
scp target/release/farssh other-laptop:~/bin/farssh
```

### 3. On the new computer

Need: macOS or Linux, system `ssh`, key-based access to the remote, concrete `Host` entries in `~/.ssh/config`.

```bash
chmod +x farssh
./farssh --help
./farssh --version
```

Optional PATH:

```bash
mkdir -p ~/.local/bin
mv farssh ~/.local/bin/
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
farssh doctor
```

Write `~/.ssh/config` on the new machine (same Host aliases help). Then:

```bash
ssh home-mac true
farssh doctor --host home-mac
farssh
```

The first session from the new laptop still writes `~/.farssh/tmux.conf` **on the remote**. Locally, `~/.farssh/cm/` is created for SSH ControlMaster sockets; you do not copy that directory from the old laptop.

### 4. After the move

Same as a packaged install: `farssh` for the TUI, or `farssh doctor --host …`. No `cargo`. Keep Rust and the repo only on the machine you develop on.

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
farssh doctor
farssh doctor --host home-mac
```

`doctor` without `--host` lists aliases it can see. With `--host` it prints remote `PATH`, tmux, and each agent’s version.

If `doctor` says an agent is missing but you can run it after `ssh -t host`, the login shell PATH is the usual culprit (nvm, Homebrew, `~/.local/bin`). farssh always probes with `bash -lc`.

## Language

The first TUI launch asks **中文** or **English**. The choice is written to `~/.farssh/config.json` on this machine and is not asked again.

```json
{
  "language": "en"
}
```

Values: `zh` or `en`. Change later with `L` on the host list, or by editing that file. This only affects the local UI, not remote agents.

## Everyday flow

```bash
farssh
```

| Screen | What you do |
| --- | --- |
| **Language** | First run (or `L`): 中文 / English |
| **Hosts** | Choose a `Host`. Enter runs a probe. |
| **Agents** | Installed agents show a version. Missing ones say **not installed · enter to install**. |
| **Confirm** | Exact commands for install / upgrade / uninstall. Enter runs them live over SSH PTY. |
| **Sessions** | `[live]` is a tmux pane still running. `[idle]` is a transcript on disk. |
| **New cwd** | `n` — type a remote directory that already exists, Enter to start. |

Keys (manager TUI):

| Key | Action |
| --- | --- |
| `j` / `k` or arrows | Move |
| Enter | Probe / open / attach, or **install** if the agent or tmux is missing |
| `U` | Upgrade the selected agent (agent list) |
| `X` | Uninstall the selected agent CLI (keeps `~/.claude` and similar config) |
| `n` | New session (remote cwd) |
| `r` | Refresh |
| `L` | Change UI language |
| `?` | Short help |
| `q` or Esc | Back / quit |
| `Ctrl-c` | Quit |

Once the native agent fills the screen:

| Key | Action |
| --- | --- |
| **`Ctrl-g` then `d`** | Detach. Agent **keeps running** on the remote. You return to the session list. |
| Agent `/quit` (or equivalent) | Ends the agent; the tmux session goes away; the row becomes idle. |

Prefix is **`Ctrl-g`**, not tmux’s usual `Ctrl-b`, so it fights less with agent bindings. This applies only to the isolated tmux socket named `farssh` — your default tmux server is not modified.

### Live vs idle

- **live** — tmux still has that session. farssh **only attaches**. It will not run `codex resume` / `claude --resume` / … on a live pane (that is how people get two agents editing one repo).
- **idle** — no tmux pane. farssh starts a new pane with the agent’s resume command in the session’s working directory.

### New session

1. Open the agent’s session list.
2. Press `n`.
3. Confirm a directory that **already exists** on the remote (`test -d`). farssh does not create project folders.
4. Enter — a new tmux session starts `claude` / `codex` / `grok` / `pi` with a login shell.

## Install, upgrade, uninstall

From the **agent list** on a probed host:

| Situation | What happens |
| --- | --- |
| Agent not installed | Enter opens a confirm screen, then live-installs that agent |
| Agent installed, tmux missing | Enter plans a tmux install only |
| Agent + tmux present | Enter opens sessions as before |
| `U` | Upgrade that agent (or install if missing) |
| `X` | Uninstall that agent's CLI only |

The confirm screen lists every command that will run. Enter hands your tty to `ssh -tt` so you see the installer (and can type a sudo password). After the remote command exits, FarSSH returns to the agent list and probes again. It does **not** log you in and does **not** start a session.

Commands FarSSH will run (hardcoded; the remote never supplies the script):

| Software | Install | Notes |
| --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | Upgrade: `claude update` (falls back to the installer) |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | Upgrade re-runs the installer |
| Grok Build | `curl -fsSL https://x.ai/cli/install.sh \| bash` | Upgrade: `grok update` |
| Pi | `curl -fsSL https://pi.dev/install.sh \| sh` | If Node is missing, nvm + Node LTS first |
| tmux / curl | `brew install …` or `sudo apt-get` / `dnf` / `yum` / `pacman` / `apk` | Only these package managers. No synopkg/Entware guess |
| Node (Pi) | nvm official script, then `nvm install --lts` | User directory, no sudo |

Uninstall removes the CLI (`claude uninstall` / `rm` of the binary / `npm uninstall -g` / `brew uninstall`) and **keeps** `~/.claude`, `~/.codex`, `~/.grok`, `~/.pi` and API keys. A live tmux session is a warning, not a block.

If the host has no curl and no known package manager, the confirm screen is blocked and shows copy-paste commands. Agent install can still proceed without tmux; attaching a session still needs tmux.

## CLI (no TUI)

```bash
farssh                  # same as: farssh tui
farssh tui
farssh doctor
farssh doctor --host home-mac
farssh probe --host home-mac
farssh sessions --host home-mac --agent grok
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
3. Run `farssh` again, same host + agent, open the `[live]` row.

Do not SSH in by hand and `codex resume` the same id while the pane is live.

## Terminal quality

farssh forwards your `TERM` / `COLORTERM` through `ssh -tt`. The dedicated tmux config enables mouse, truecolor (`RGB`), and OSC 52 clipboard.

Use a terminal with 256 colors and mouse (Ghostty, iTerm2, Kitty, WezTerm, Windows Terminal over SSH from Linux/macOS clients). If Grok’s `/doctor` complains about clipboard, its own `grok wrap ssh` is optional; farssh does not require it.

Resize the window: OpenSSH sends `SIGWINCH`; the agent TUI should relayout.

## Security model

- SSH is system OpenSSH. Keys stay in your agent / `IdentityFile`.
- Remote helper lives in `~/.farssh/` on the **remote** account you SSH as.
- tmux listens on a private socket (`-L farssh`), not a TCP port.
- No API keys are written to the laptop.
- Agent installers are the official `curl | bash` URLs, shown on a confirm screen, user directory, no sudo.
- tmux and curl may use `sudo` plus brew/apt/dnf/yum/pacman/apk. FarSSH does not guess NAS package managers.

Treat SSH access as full access to that user’s agents and repos — because it is.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Host list empty | Add a non-wildcard `Host` to `~/.ssh/config` |
| `Permission denied` / hangs on password | Set up keys; BatchMode cannot prompt |
| Agent `not installed` but works in SSH | Login PATH: nvm, Homebrew, `~/.local/bin`. `farssh doctor --host X` prints `PATH` |
| `tmux_missing` | Enter on the agent list to install tmux, or copy the commands from the confirm screen |
| `cwd_missing` | Directory must exist; farssh will not `mkdir` a project |
| Probe stuck then a red error | The red footer is the real reason; fix SSH and press Enter to retry |
| Probe missing `FARSSH_PROBE` / bash error | Remote needs bash; try `ssh host -- bash -lc 'echo ok'` |
| Garbled TUI | Truecolor terminal; detach and reattach after resize |
| Two agents on one repo | You resumed a **live** session by hand. Use attach only |
| macOS remote cannot read Desktop/Documents | Grant Full Disk Access to `sshd` (TCC). farssh cannot bypass this |
| `ControlMaster` feels stuck | `ssh -O exit -o ControlPath=~/.farssh/cm/%r@%h:%p host` then retry |

## What v0.1 does not do

Password SSH, OTP, `ProxyJump`, session delete/rename/fork, copying remote credentials to the laptop, compiling tmux from source, Entware/synopkg.

Native Windows (no WSL) and a styled app frontend are planned: [roadmap](roadmap.md).

## See also

- [Development](development.md) — architecture and contributing
- [Roadmap](roadmap.md) — native Windows and app frontend


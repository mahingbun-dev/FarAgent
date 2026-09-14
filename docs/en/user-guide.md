# User guide

**English** · [中文](../zh/user-guide.md)

**FarAgent** (`faragent`) is a local TUI. It SSHs into a machine you already use, finds Claude Code / Codex / Grok Build / Pi, and attaches their **native** terminal UI. Model calls use the **remote** login and config.

Contents:

- [Requirements](#requirements)
- [Developer mode](#developer-mode)
- [Using a packaged binary on this machine](#using-a-packaged-binary-on-this-machine)
- [Moving the binary to another computer](#moving-the-binary-to-another-computer)
- [SSH config](#ssh-config)
- [SSH access (LAN / public IP / domain / Tailscale)](ssh-access.md)
- [Language](#language)
- [Everyday flow](#everyday-flow)
- [Install, upgrade, uninstall](#install-upgrade-uninstall)
- [CLI (no TUI)](#cli-no-tui)
- [Agents](#agents)
- [Detach, disconnect, come back](#detach-disconnect-come-back)
- [Troubleshooting](#troubleshooting)

## Requirements

### On your laptop

- macOS, Linux, or **Windows 11**
- OpenSSH (`ssh`) — Windows ships it (Optional feature: OpenSSH Client)
- A concrete `Host` entry in `~/.ssh/config` (see below)
- **A working path to the host.** Keys or `ssh-agent` by default (`BatchMode`); when the server only takes an account password, macOS/Linux support one interactive login (nothing stored) and Windows asks for the password in the TUI and keeps it in memory for that run only — see [SSH access · password-only servers](ssh-access.md#password-only-servers-optional) and [Windows client notes](ssh-access.md#windows-client-notes)
- The laptop must actually reach the remote: same LAN, a public IP/domain, or [Tailscale](ssh-access.md) (recommended behind home NAT / from a café)

### On the remote machine

| Need | Notes |
| --- | --- |
| `sshd` | Normal SSH server — Win32 OpenSSH counts on Windows 11 |
| `bash` (Linux/macOS) | Login shell; faragent probes with `bash -lc` |
| `tmux` (Linux/macOS) | Required to attach. If missing, FarAgent can install it (brew, or sudo + apt/dnf/yum/pacman/apk) |
| At least one agent | `claude`, `codex`, `grok`, or `pi` on the **login-shell** PATH. Missing agents can be installed from the TUI |
| Agent already authenticated | faragent does not complete OAuth for you |

**Windows remotes (native):** Windows 11 with Win32 OpenSSH (`sshd` from Optional Features, port 22 open in the firewall), keep the default **cmd** shell. There is no tmux on Windows: sessions run in the **foreground** — quitting the agent (or losing the connection) ends it, and the next `enter` restores the conversation through `claude --resume` / `codex resume`. Sessions that look like they are already running elsewhere are marked `[running]` and ask before opening ([codex#30424](https://github.com/openai/codex/issues/30424)). WSL2 also still works — it is just a Linux host. Setup walkthrough: [SSH access · Windows remote](ssh-access.md#windows-remote-native).

You can install agents from the TUI (on Linux/macOS: official `curl | bash` into the user directory, no sudo; on Windows: the official PowerShell installers, also no admin) or run those installers yourself on the remote, then log in once there (`claude`, `codex login`, `grok login`, `pi` `/login`, etc.).

The laptop never copies API keys. Probe and session listing run in Rust locally; the remote runs bash (or PowerShell on Windows), tmux, and the official installers you confirm. First session start on a Linux/macOS remote still writes `~/.faragent/tmux.conf`. No python3, no faragent binary on the target.

There are three ways to run the laptop side: **hack on the source**, **use a release binary here**, or **copy that binary to another computer**. The remote machine that holds your agents does not need Rust or this repository.

## Developer mode

Use this when you are editing code, running tests, and launching the latest TUI from a git checkout. The laptop needs **Rust 1.80+** and Git.

### Clone and compile

```bash
# if rustup is missing
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

git clone https://github.com/mahingbun-dev/FarAgent.git
cd FarAgent
cargo build
```

The debug binary is `target/debug/faragent`.

### Everyday commands

`cargo run` builds if needed, then execs. Put `--` before faragent’s own flags so cargo does not swallow them:

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
./target/debug/faragent
./target/debug/faragent doctor --host home-mac
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
cd FarAgent
cargo build --release
./target/release/faragent --help
./target/release/faragent --version
```

The artifact is a single executable:

| OS | Path |
| --- | --- |
| macOS / Linux | `target/release/faragent` |

The laptop still needs system `ssh` (`command -v ssh`). faragent does **not** bundle OpenSSH; the destination machine must provide `ssh` too.

### Install onto PATH (recommended)

```bash
cargo install --path .
```

This writes `~/.cargo/bin/faragent`. If the shell cannot find it:

```bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc
which faragent
faragent --help
```

Upgrade (after `git pull` in the repo):

```bash
git pull
cargo install --path . --force
```

Uninstall:

```bash
cargo uninstall faragent
# or: rm ~/.cargo/bin/faragent
```

### Run the file without installing

```bash
./target/release/faragent
/absolute/path/faragent doctor --host home-mac
```

You still need [SSH config](#ssh-config) and a working `ssh <Host> true`.

## Moving the binary to another computer

A release build is **one file**. The other computer does **not** need Rust or the source tree. Copy `faragent`, plus that computer’s own SSH config and keys.

Do not relocate the remote box that already has claude/codex/grok/pi. The new laptop only has to SSH there.

### 1. Pack on the original machine

```bash
cd FarAgent
cargo build --release
uname -m          # arm64 or x86_64 — the destination must match
file target/release/faragent
```

| Built on | Destination must be |
| --- | --- |
| Apple Silicon Mac (`arm64`) | Apple Silicon |
| Intel Mac (`x86_64`) | Intel Mac |
| Linux x86_64 | Linux x86_64 (glibc should not be much older) |

A binary **cannot** cross OSes or architectures (macOS ≠ Linux ≠ Windows; `arm64` ≠ `x86_64`) — copy the matching build, or `cargo install --path .` on the target machine.

### 2. What to copy and what to leave

**Copy:**

- `target/release/faragent` (keep the executable bit)

**Do not ship in the same bundle:**

- The git repo, `target/debug/`, or build caches
- `~/.ssh/` private keys (move keys separately and safely; do not email them next to the binary)
- Remote `~/.faragent/`, agent transcripts, or API keys (those stay on the remote)

USB, AirDrop, or `scp`:

```bash
scp target/release/faragent other-laptop:~/bin/faragent
```

### 3. On the new computer

Need: macOS or Linux, system `ssh`, key-based access to the remote, concrete `Host` entries in `~/.ssh/config`.

```bash
chmod +x faragent
./faragent --help
./faragent --version
```

Optional PATH:

```bash
mkdir -p ~/.local/bin
mv faragent ~/.local/bin/
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
faragent doctor
```

Write `~/.ssh/config` on the new machine (same Host aliases help). Then:

```bash
ssh home-mac true
faragent doctor --host home-mac
faragent
```

The first session from the new laptop still writes `~/.faragent/tmux.conf` **on the remote**. Locally, `~/.faragent/cm/` is created for SSH ControlMaster sockets; you do not copy that directory from the old laptop.

### 4. After the move

Same as a packaged install: `faragent` for the TUI, or `faragent doctor --host …`. No `cargo`. Keep Rust and the repo only on the machine you develop on.

## SSH config

The picker reads **non-pattern** `Host` names. `Host *`, `Host *.github.com`, and `?` globs are skipped.

`HostName` may be a LAN IP, a public IP, a DNS name, or a Tailscale `100.x` / MagicDNS name. FarAgent does not punch NAT: if system OpenSSH can log in with **keys and no prompt**, the TUI can too. Step-by-step (home NAT, CGNAT, Tailscale tutorial): **[SSH access: LAN, public IP, domain, Tailscale](ssh-access.md)**.

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
faragent doctor
faragent doctor --host home-mac
```

`doctor` without `--host` lists aliases it can see. With `--host` it prints remote `PATH`, tmux, and each agent’s version.

If `doctor` says an agent is missing but you can run it after `ssh -t host`, the login shell PATH is the usual culprit (nvm, Homebrew, `~/.local/bin`). faragent always probes with `bash -lc`.

## Language

The first TUI launch asks **中文** or **English**. The choice is written to `~/.faragent/config.json` on this machine and is not asked again.

```json
{
  "language": "en"
}
```

Values: `zh` or `en`. Change later with `L` on the host list, or by editing that file. This only affects the local UI, not remote agents.

## Everyday flow

```bash
faragent
```

| Screen | What you do |
| --- | --- |
| **Language** | First run (or `L`): 中文 / English |
| **Hosts** | Choose a `Host`. Enter runs a probe. |
| **Agents** | Installed agents show a version. Missing ones say **not installed · enter to install**. |
| **Confirm** | Exact commands for install / upgrade / uninstall. Enter runs them live over SSH PTY. |
| **Sessions** | `[live]` is a tmux pane still running. `[idle]` is a transcript on disk. |
| **New session** | `n` — pick from recents / `..` / children (Enter navigates, `s` starts). If the path is missing, FarAgent asks before creating it. |

Keys (manager TUI):

| Key | Action |
| --- | --- |
| `j` / `k` or arrows | Move |
| Enter | Probe / open / attach, or **install** if the agent or tmux is missing |
| `U` | Upgrade the selected agent (agent list) |
| `X` | Uninstall the selected agent CLI (keeps `~/.claude` and similar config) |
| `n` | New session (remote cwd) |
| `p` | Toggle full permissions / confirm required (session list and new-session screen; stored in `~/.faragent/config.json`) |
| `G` | Sync this machine's `gh` login onto the host (hosts list; asks first). Lowercase `g` still cycles SSH auth |
| `r` | Refresh |
| `L` | Change UI language |
| `?` | Short help |
| `q` or Esc | Back / quit |
| `Ctrl-c` | Quit |

Each host row is tagged with its sign-in mode: `[key only]` / `[password]`; no tag means the default `auto`. Press `g` on the host list to cycle `auto` -> `key` -> `password`.

When a connection fails, FarAgent switches to an **error screen** holding the raw ssh output, the cause, and copy-pasteable fixes:

| Key | Action |
| --- | --- |
| `j` / `k`, `PgUp` / `PgDn` | Scroll the report |
| `a` | Password hosts: one interactive login on macOS/Linux (the password goes straight to OpenSSH, nothing stored), or the in-memory password prompt on Windows |
| `r` | Retry the step that failed, once you fixed something |
| `y` | Copy cause + raw error + steps to the clipboard |
| `Esc` / `q` | Back |

The full raw-error -> cause -> fix table lives in [SSH access](ssh-access.md#when-it-fails-error-cause-fix).

Once the native agent fills the screen:

| Key | Action |
| --- | --- |
| **`Ctrl-g` then `d`** | Detach. Agent **keeps running** on the remote. You return to the session list. |
| Agent `/quit` (or equivalent) | Ends the agent; the tmux session goes away; the row becomes idle. |

Prefix is **`Ctrl-g`**, not tmux’s usual `Ctrl-b`, so it fights less with agent bindings. This applies only to the isolated tmux socket named `faragent` — your default tmux server is not modified.

### Live vs idle

- **live** — tmux still has that session. faragent **only attaches**. It will not run `codex resume` / `claude --resume` / … on a live pane (that is how people get two agents editing one repo).
- **idle** — no tmux pane. faragent starts a new pane with the agent’s resume command in the session’s working directory.

### New session

1. Open the agent’s session list.
2. Press `n`.
3. The `cwd>` field is still there — type to edit (`~` expands against the remote home). Below it: **recent working directories** (unique `cwd` values from the current session list), `..`, then child directories of the current path.
4. `j` / `k` move in that list; **Enter navigates** into a recent / `..` / child (re-lists, does not start).
5. **`s` starts** in the current `cwd>` (the old Enter-to-start binding). Tab re-lists the path in the input.
6. Directory exists → starts `claude` / `codex` / `grok` / `pi` in a login shell there.
7. Directory missing → FarAgent switches to a confirmation screen that **shows the exact `mkdir -p`**; Enter creates it and starts, Esc goes back to the path.

Listing **never** creates directories. Nothing is written on the remote until you press Enter on that confirmation screen.

`p` toggles **full permissions** (on by default: Claude `bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, Grok `--always-approve`; Pi unchanged) and **confirm required**. Flags apply to new sessions and idle resumes only; a live tmux attach does not re-exec the agent.

### Sync GitHub login

On the hosts list press **`G`** (lowercase `g` still cycles SSH auth). After a confirm screen, FarAgent copies this machine's `gh auth token` onto the remote `~/.config/gh/hosts.yml` (mode 0600), creates an ed25519 key if needed, registers the public key with GitHub (title `faragent-<host>`), and rewrites remote `https://github.com/` to `git@github.com:`. If this laptop is not logged in, run `gh auth login` here first. **The token is never shown in the UI or logs.**

CLI equivalent: `faragent github-sync --host <alias>`.

## Install, upgrade, uninstall

From the **agent list** on a probed host:

| Situation | What happens |
| --- | --- |
| Agent not installed | Enter opens a confirm screen, then live-installs that agent |
| Agent installed, tmux missing | Enter plans a tmux install only |
| Agent + tmux present | Enter opens sessions as before |
| `U` | Upgrade that agent (or install if missing) |
| `X` | Uninstall that agent's CLI only |

The confirm screen lists every command that will run. Enter hands your tty to `ssh -tt` so you see the installer (and can type a sudo password). After the remote command exits, FarAgent returns to the agent list and probes again. It does **not** log you in and does **not** start a session.

Commands FarAgent will run (hardcoded; the remote never supplies the script):

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
faragent                  # same as: faragent tui
faragent tui
faragent doctor
faragent doctor --host home-mac
faragent probe --host home-mac
faragent sessions --host home-mac --agent grok
faragent auth --host home-mac                  # print this host's sign-in mode
faragent auth --host home-mac --mode password  # auto | key | password
faragent login --host home-mac                 # one interactive login (password / host key), reused afterwards
faragent github-sync --host home-mac           # copy this machine's gh login onto the remote
```

`probe` and `sessions` print JSON (automation / debugging). Agent names: `claude`, `codex`, `grok`, `pi`. When a connection fails they print the same report the TUI shows (raw ssh output + cause + fixes) and exit non-zero.

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
3. Run `faragent` again, same host + agent, open the `[live]` row.

Do not SSH in by hand and `codex resume` the same id while the pane is live.

## Terminal quality

faragent forwards your `TERM` / `COLORTERM` through `ssh -tt`. The dedicated tmux config enables mouse, truecolor (`RGB`), and OSC 52 clipboard.

Use a terminal with 256 colors and mouse (Ghostty, iTerm2, Kitty, WezTerm, or Windows Terminal — the officially supported terminal on Windows 11). If Grok’s `/doctor` complains about clipboard, its own `grok wrap ssh` is optional; faragent does not require it.

Resize the window: OpenSSH sends `SIGWINCH`; the agent TUI should relayout.

## Security model

- SSH is system OpenSSH. Keys stay in your agent / `IdentityFile`.
- Remote helper lives in `~/.faragent/` on the **remote** account you SSH as.
- tmux listens on a private socket (`-L faragent`), not a TCP port.
- No API keys are written to the laptop.
- Agent installers are the official `curl | bash` URLs, shown on a confirm screen, user directory, no sudo.
- tmux and curl may use `sudo` plus brew/apt/dnf/yum/pacman/apk. FarAgent does not guess NAS package managers.

Treat SSH access as full access to that user’s agents and repos — because it is.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| Host list empty | Add a non-wildcard `Host` to `~/.ssh/config` |
| `Permission denied (publickey)` | The key is not set up: see the [error table](ssh-access.md#when-it-fails-error-cause-fix); press `r` to retry after fixing |
| `Permission denied (publickey,password)` | The server only takes passwords: `faragent auth --host X --mode password`, then `faragent login --host X` (or `a` on the TUI error screen) |
| Asked for a password again and again | Run `faragent login --host X` once; later commands ride the multiplexed connection |
| Want to leave password mode | `faragent auth --host X --mode key` (keys only) or `--mode auto` (default) |
| Café cannot reach home `192.168.x` | That is a LAN address. Use [Tailscale](ssh-access.md#tailscale-for-nat-traversal-recommended) or a public IP / domain |
| Agent `not installed` but works in SSH | Login PATH: nvm, Homebrew, `~/.local/bin`. `faragent doctor --host X` prints `PATH` |
| `tmux_missing` | Enter on the agent list to install tmux, or copy the commands from the confirm screen |
| `cwd_missing` | The working directory is missing: press Enter on the confirm screen to create it, or Esc to edit the path |
| `mkdir_failed` | Creating the directory failed on the remote (permissions / read-only mount); the red line carries the raw mkdir output |
| Probe switched to the error screen | The page has the raw ssh output and the fixes; `a` interactive login, `r` retry, `y` copy, `Esc` back |
| Probe missing `FARAGENT_PROBE` / bash error | Remote needs bash; try `ssh host -- bash -lc 'echo ok'` |
| Garbled TUI | Truecolor terminal; detach and reattach after resize |
| Two agents on one repo | You resumed a **live** session by hand. Use attach only |
| macOS remote cannot read Desktop/Documents | Grant Full Disk Access to `sshd` (TCC). faragent cannot bypass this |
| `ControlMaster` feels stuck | `ssh -O exit -o ControlPath=~/.faragent/cm/%r@%h:%p host` then retry |

## What FarAgent does not do

OTP, `ProxyJump`, session delete/rename/fork, copying remote credentials to the laptop, compiling tmux from source, Entware/synopkg, keeping sessions alive on a Windows remote (a tmux-equivalent session host is planned).

A Windows session host (keep-alive without WSL) and a styled app frontend are planned: [roadmap](roadmap.md).

## See also

- [SSH access: LAN, public IP, domain, Tailscale](ssh-access.md)
- [Development](development.md) — architecture and contributing
- [Roadmap](roadmap.md) — Windows session host and app frontend

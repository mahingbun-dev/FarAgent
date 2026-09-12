# Development

**English** · [中文](../zh/development.md)

How `everywhere` is put together, how to hack on it, and how to add another agent. For end users see the [user guide](user-guide.md).

## Repo layout

```
everywhere-to-agent/
├── Cargo.toml
├── src/
│   ├── main.rs          CLI (clap): tui / doctor / probe / sessions
│   ├── tui.rs           ratatui picker (hosts → agents → sessions)
│   ├── ssh.rs           Parse ~/.ssh/config; exec system `ssh`
│   ├── probe.rs         Deserialize remote probe JSON
│   ├── runtime.rs       Install helper, list/start tmux sessions
│   ├── pty.rs           Drop the TUI, `ssh -tt`, restore
│   ├── agents.rs        Agent ids, tmux names, resume argv (docs + tests)
│   ├── doctor.rs        Human-readable diagnostics
│   └── remote.py        Runs *on the SSH target* (python3)
├── docs/                All product documentation
│   ├── README.md        Docs hub
│   ├── assets/          Images
│   ├── en/              English guides
│   └── zh/              中文文档
└── plans/               Original scope (interview plan)
```

Binary name: `everywhere`. Edition 2021, Rust 1.80+.

## Architecture

```
laptop                          SSH                         remote account
┌─────────────────────┐         ControlMaster         ┌──────────────────────────┐
│ ratatui picker      │--------- exec bash -lc ------►│ python3 ~/.everywhere/   │
│                     │                               │   remote.py probe|list   │
│                     │                               │   |start|doctor          │
│ restore tty         │========= ssh -tt ===========►│ tmux -L everywhere      │
│                     │         PTY + SIGWINCH        │   eta-<agent>-<shortid>  │
└─────────────────────┘                               │   exec claude|codex|…    │
                                                      └──────────────────────────┘
```

**SSH is never reimplemented.** Flags always include `BatchMode=yes`, `ControlMaster=auto`, `ControlPath=~/.everywhere/cm/%r@%h:%p`, `ControlPersist=600`.

**Coding UI is never reimplemented.** After attach, bytes are a raw PTY to the vendor TUI.

**tmux isolation:** `-L everywhere` so we do not share the user’s default server. Config is `~/.everywhere/tmux.conf` (prefix `C-g`, mouse, RGB). `-f` is ignored if that socket’s server already exists; creating the first session starts it with our file.

## Remote helper

`src/remote.py` is `include_str!` into the binary. On probe, the laptop SHA-256s the script and compares with `~/.everywhere/remote.py` on the host; mismatch → stdin write via python3, no package manager.

Commands (JSON on stdout):

| argv | Role |
| --- | --- |
| `probe` | tmux + four agents: found, version, path, auth_hint |
| `list --agent <id>` | Disk sessions + live tmux names |
| `start --agent --cwd --tmux [--session-id]` | `has-session` → exists; else `new-session -d` |
| `has --tmux` | live? |
| `ensure` | mkdir `~/.everywhere`, write tmux.conf |
| `doctor` | probe + notes |

Login shell: every remote invocation is `ssh … bash -lc '…'` so nvm/Homebrew PATH matches an interactive SSH.

### Tmux naming

```
eta-<agent>-<shortid>
```

`shortid` is the last 12 alphanumeric characters of the vendor session id (Rust `agents::short_id`, same rule in `remote.py`). New sessions get a fresh 12-char id and start the binary **without** resume.

**Invariant:** if `tmux has-session` is true, `start` must not spawn another agent process.

## Module notes

| File | Tests / contracts |
| --- | --- |
| `ssh.rs` | Wildcard Hosts skipped; `Match` stops parsing; BatchMode in `base_args` |
| `agents.rs` | Resume argv table must stay aligned with `remote.py` |
| `runtime.rs` | Helper hash length; `py_compile` on `remote.py` |
| `tui.rs` | Live row → attach only; idle → `ensure_tmux_session(..., Some(id))` |

PTY attach: `ratatui::restore()`, then `ssh -tt bash -lc 'exec tmux -L everywhere attach -t …'`. Detach ends ssh; the picker calls `ratatui::init()` again.

## Develop

```bash
rustup toolchain install stable
cargo test
cargo fmt
cargo build
./target/debug/everywhere doctor
```

There is no remote mock in CI yet. Unit tests cover config parsing, argv, helper syntax. Manual path: [user guide checklist](user-guide.md) against a real Host.

Do not commit `target/`, `__pycache__/`, or a remote `~/.everywhere` dump.

## Adding an agent

1. `AgentKind` in `src/agents.rs` (`slug`, `title`, `resume_argv`).
2. `AGENTS` and `agent_argv` / disk scanner in `src/remote.py`.
3. Tests for resume argv and a `REMOTE_PY.contains` assertion if you add a distinctive string.
4. User-guide table (EN + ZH).

Prefer a vendor CLI that can **resume by id** and stores transcripts under the home directory. If it has no interactive TUI, it does not belong in this product’s attach path.

## Roadmap vs not now

Planned next (see [roadmap.md](roadmap.md)):

1. Native Windows remote and client (OpenSSH + ConPTY, no WSL required)
2. A styled application frontend around host / agent / session management

Do not add without a separate plan:

- An OpenClaw-style gateway
- Password / keyboard-interactive SSH
- Installing tmux or agents over SSH
- Binding agent protocol ports on `0.0.0.0`
- Copying API keys to the laptop

## Release sketch

v0.1 is source-only (`cargo install --path .`). A later release can attach `cargo dist` or GitHub Actions for macOS/Linux binaries. Keep the helper script and tmux conf backward compatible: bump the hashed `remote.py` so old hosts refresh on next probe.

## License

MIT. See [LICENSE](../../LICENSE).

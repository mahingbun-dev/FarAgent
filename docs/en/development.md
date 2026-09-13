# Development

**English** · [中文](../zh/development.md)

How `farssh` is put together, how to hack on it, and how to add another agent. For end users see the [user guide](user-guide.md).

## Repo layout

```
farssh/
├── Cargo.toml
├── src/
│   ├── main.rs          CLI (clap): tui / doctor / probe / sessions
│   ├── tui.rs           ratatui picker (hosts → agents → confirm → sessions)
│   ├── ssh.rs           Parse ~/.ssh/config; exec system `ssh`
│   ├── probe.rs         Deserialize remote probe JSON
│   ├── install.rs       Official install/upgrade/uninstall plans + preflight
│   ├── runtime.rs       List/start tmux sessions
│   ├── pty.rs           Drop the TUI, `ssh -tt`, restore
│   ├── agents.rs        Agent ids, tmux names, resume argv (docs + tests)
│   ├── doctor.rs        Human-readable diagnostics
│   └── remote.rs        Probe/list/start scripts + parsers (runs on the laptop)
├── docs/                All product documentation
│   ├── README.md        Docs hub
│   ├── assets/          Images
│   ├── en/              English guides
│   └── zh/              中文文档
└── plans/               Local notes (gitignored)
```

Binary name: `farssh`. Edition 2021, Rust 1.80+.

## Architecture

```
laptop                          SSH                         remote account
┌─────────────────────┐         ControlMaster         ┌──────────────────────────┐
│ ratatui picker      │--------- exec bash -lc ------►│ bash: which/find/tmux│
│ (Rust parses JSONL) │                               │   + tmux -L farssh     │
│ restore tty         │========= ssh -tt ===========►│ tmux -L farssh      │
│                     │         PTY + SIGWINCH        │   farssh-<agent>-<shortid>  │
└─────────────────────┘                               │   exec claude|codex|…    │
                                                      └──────────────────────────┘
```

**SSH is never reimplemented.** Flags always include `BatchMode=yes`, `ControlMaster=auto`, `ControlPath=~/.farssh/cm/%r@%h:%p`, `ControlPersist=600`.

**Coding UI is never reimplemented.** After attach, bytes are a raw PTY to the vendor TUI.

**tmux isolation:** `-L farssh` so we do not share the user’s default server. Config is `~/.farssh/tmux.conf` (prefix `C-g`, mouse, RGB). `-f` is ignored if that socket’s server already exists; creating the first session starts it with our file.

## Remote side (no python3)

Logic lives in `src/remote.rs` on the **laptop**. The SSH target only runs `bash -lc` (which, find, tmux) and, on first start, receives `~/.farssh/tmux.conf` via stdin. We do **not** upload a farssh binary: a macOS build cannot run on Linux.

| Local parser | Remote bash |
| --- | --- |
| `probe` | `command -v`, `--version`, auth file `-s` |
| `list` | `find` session files + `tmux list-sessions`; JSON/JSONL parsed here |
| `start` | `tmux has-session` / `new-session -d` |
| `ensure` | write `tmux.conf` |
| `preflight` / `install` | detect curl/node/tmux/pkg manager; run confirmed official installers over `ssh -tt` |

Login shell: every remote invocation is `ssh … bash -lc '…'` so nvm/Homebrew PATH matches an interactive SSH.

### Tmux naming

```
farssh-<agent>-<shortid>
```

`shortid` is the last 12 alphanumeric characters of the vendor session id (`agents::short_id`). New sessions get a fresh 12-char id and start the binary **without** resume.

**Invariant:** if `tmux has-session` is true, `start` must not spawn another agent process.

## Module notes

| File | Tests / contracts |
| --- | --- |
| `ssh.rs` | Wildcard Hosts skipped; `Match` stops parsing; BatchMode in `base_args` |
| `agents.rs` | Resume argv table must stay aligned with `remote.rs` start_script |
| `remote.rs` | Probe/list/start text protocol; JSONL meta; no `python` in scripts |
| `install.rs` | Official URL constants; plan_for fixtures; `bash_login_command` keeps `|` quoted |
| `tui.rs` | Live row → attach only; idle → `ensure_tmux_session(..., Some(id))` |

PTY: `ratatui::restore()`, then `ssh -tt bash -lc '…'` (tmux attach or a confirmed install script). When ssh exits the picker calls `ratatui::init()` again.

## Develop

```bash
rustup toolchain install stable
cargo test
cargo fmt
cargo build
./target/debug/farssh doctor
```

There is no remote mock in CI yet. Unit tests cover config parsing, argv, helper syntax. Manual path: [user guide checklist](user-guide.md) against a real Host.

Do not commit `target/` or a remote `~/.farssh` dump.

## Adding an agent

1. `AgentKind` in `src/agents.rs` (`slug`, `title`, `resume_argv`).
2. Disk scanner branch in `src/remote.rs` `list_script` / `row_from_file`.
3. Tests for resume argv and the probe/list parsers.
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

v0.1 is source-only (`cargo install --path .`). A later release can attach `cargo dist` or GitHub Actions for macOS/Linux binaries. `tmux.conf` on the remote is rewritten from the embedded template on each start.

## License

MIT. See [LICENSE](../../LICENSE).

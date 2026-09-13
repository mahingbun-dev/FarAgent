# Development

**English** · [中文](../zh/development.md)

How `faragent` is put together, how to hack on it, and how to add another agent. For end users see the [user guide](user-guide.md).

## Repo layout

```
faragent/
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

Binary name: `faragent`. Edition 2021, Rust 1.80+.

## Architecture

```
laptop                          SSH                         remote account
┌─────────────────────┐         ControlMaster         ┌──────────────────────────┐
│ ratatui picker      │--------- exec bash -lc ------►│ bash: which/find/tmux│
│ (Rust parses JSONL) │                               │   + tmux -L faragent     │
│ restore tty         │========= ssh -tt ===========►│ tmux -L faragent      │
│                     │         PTY + SIGWINCH        │   faragent-<agent>-<shortid>  │
└─────────────────────┘                               │   exec claude|codex|…    │
                                                      └──────────────────────────┘
```

**SSH is never reimplemented.** Flags always include `ControlMaster=auto` and `ControlPath=~/.faragent/cm/%r@%h:%p`. `args_for()` picks the auth bundle from `AuthMode`: `key` is `BatchMode=yes` with publickey only, `password` allows prompts and reuses the multiplexed master afterwards. The password only ever goes into system OpenSSH — FarAgent never reads or stores it.

**Coding UI is never reimplemented.** After attach, bytes are a raw PTY to the vendor TUI.

**tmux isolation:** `-L faragent` so we do not share the user’s default server. Config is `~/.faragent/tmux.conf` (prefix `C-g`, mouse, RGB). `-f` is ignored if that socket’s server already exists; creating the first session starts it with our file. List/attach still query the pre-rename socket `-L farssh` so live `farssh-*` sessions survive an upgrade; new sessions are only created on `faragent`.

## Remote side (no python3)

Logic lives in `src/remote.rs` on the **laptop**. The SSH target only runs `bash -lc` (which, find, tmux) and, on first start, receives `~/.faragent/tmux.conf` via stdin. We do **not** upload a faragent binary: a macOS build cannot run on Linux.

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
faragent-<agent>-<shortid>
```

`shortid` is the last 12 alphanumeric characters of the vendor session id (`agents::short_id`). New sessions get a fresh 12-char id and start the binary **without** resume.

**Invariant:** if `tmux has-session` is true, `start` must not spawn another agent process.

## Module notes

| File | Tests / contracts |
| --- | --- |
| `ssh.rs` | Wildcard Hosts skipped; `Match` stops parsing; `args_for`/`Flavor` pick auth flags; `SshError` keeps the verbatim output |
| `diagnose.rs` | Raw output → `Problem` (ordered matching) → wording + fix commands; `diagnosis_of` decides whether the TUI opens the error screen |
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
./target/debug/faragent doctor
```

There is no remote mock in CI yet. Unit tests cover config parsing, argv, helper syntax. Manual path: [user guide checklist](user-guide.md) against a real Host.

Do not commit `target/` or a remote `~/.faragent` dump.

## Adding an agent

1. `AgentKind` in `src/agents.rs` (`slug`, `title`, `resume_argv`).
2. Disk scanner branch in `src/remote.rs` `list_script` (POSIX) **and** `src/win.rs` `list_script` (Windows).
3. Tests for resume argv and the probe/list parsers.
4. User-guide table (EN + ZH).

Prefer a vendor CLI that can **resume by id** and stores transcripts under the home directory. If it has no interactive TUI, it does not belong in this product’s attach path.

## The Windows dialect

`src/win.rs` is the Windows counterpart of `src/remote.rs`’s POSIX scripts. Ground rules:

- cmd.exe is the outer shell (sshd’s default); PowerShell 5.1 does the work.
- Scripts are **ASCII-only** and travel on stdin (`powershell -File -`); dynamic values ride base64 `$args`. Nothing on the ssh command line needs cmd quoting, and cmd’s ~8k command-line limit does not apply. Interactive launchers use `-EncodedCommand` instead because stdin belongs to the tty — keep those short.
- Every script starts by forcing UTF-8 output (`[Console]::OutputEncoding`).
- The `FARAGENT_*_V1` markers and tab-separated line shapes are shared with the POSIX side; parsers in `remote.rs` never care which dialect produced the bytes.
- The remote dialect is detected once (`echo FARAGENT_OS_V1 %OS% "$env:OS"`) and cached per host in `~/.faragent/config.json`; `probe_host` self-heals the cache and retries once with the other dialect.

Windows clients have no ControlMaster (Win32 OpenSSH): `ssh::mux_capable()` detects that and omits the mux options. The in-memory password path lives in `src/askpass.rs` — read its module docs before touching ssh env plumbing.

## Roadmap vs not now

Planned next (see [roadmap.md](roadmap.md)):

1. Windows session host: ConPTY + named-pipe attach/detach for tmux-equivalent keep-alive without WSL
2. A styled application frontend around host / agent / session management
3. Auth modes: `auto` / `key` / `password` ship today; keychain integration and a smoother jump-host flow are candidates

Do not add without a separate plan:

- An OpenClaw-style gateway
- Binding agent protocol ports on `0.0.0.0`
- Copying API keys to the laptop

## Release sketch

Tagged releases build on GitHub Actions (ubuntu/macos/windows) and attach per-OS archives; `cargo install --path .` still works. `tmux.conf` on a POSIX remote is rewritten from the embedded template on each start.

## License

MIT. See [LICENSE](../../LICENSE).

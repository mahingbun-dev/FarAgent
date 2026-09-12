# Contributing

Thanks for looking. `everywhere` is a small Rust TUI plus a Python helper that runs on the SSH target.

1. Read **[Development](docs/development.md)** (or [开发者文档](docs/zh/development.md)).
2. `cargo test` and `cargo fmt` before you send a change.
3. Keep SSH as system `ssh`. Do not add a custom SSH stack or bind agent ports on `0.0.0.0`.
4. Live tmux sessions must **attach only** — never `resume` a running vendor id.
5. User-facing behavior belongs in [docs/user-guide.md](docs/user-guide.md) and [docs/zh/user-guide.md](docs/zh/user-guide.md).

Issues and pull requests: GitHub. MIT licensed.

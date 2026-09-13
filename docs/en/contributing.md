# Contributing

**English** · [中文](../zh/contributing.md)

Thanks for looking. `faragent` is a small Rust TUI plus a Python helper that runs on the SSH target.

1. Read **[Development](development.md)** (or [开发者文档](../zh/development.md)).
2. `cargo test` and `cargo fmt` before you send a change.
3. Keep SSH as system `ssh`. Do not add a custom SSH stack or bind agent ports on `0.0.0.0`.
4. Live tmux sessions must **attach only** — never `resume` a running vendor id.
5. User-facing behavior belongs in [user-guide.md](user-guide.md) and [用户手册](../zh/user-guide.md).

Issues and pull requests: GitHub. MIT licensed.

# 参与贡献

[English](../en/contributing.md) · **中文**

感谢关注。`faragent` 是一个小的 Rust TUI，外加在 SSH 对端运行的 Python 助手。

1. 先读 **[开发者文档](development.md)**（[Development](../en/development.md)）。
2. 提交前跑 `cargo test` 和 `cargo fmt`。
3. SSH 必须走系统 `ssh`。不要自研 SSH 协议栈，也不要把 agent 端口绑到 `0.0.0.0`。
4. live 的 tmux 会话 **只能 attach** — 不要对正在跑的厂商 session id 再 `resume`。
5. 用户能感知的行为请同步写进 [user-guide.md](user-guide.md) 和 [User guide](../en/user-guide.md)。

Issue 和 Pull Request 走 GitHub。MIT 许可。

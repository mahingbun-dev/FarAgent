# 开发者文档

本文说明 everywhere 怎么组成、怎么改、怎么加一家 agent。日常使用请看 [用户手册](user-guide.md)。English: [Development](../development.md)

## 仓库结构

```
everywhere-to-agent/
├── Cargo.toml
├── src/
│   ├── main.rs          clap：tui / doctor / probe / sessions
│   ├── tui.rs           ratatui 选择器（主机 → agent → 会话）
│   ├── ssh.rs           解析 ~/.ssh/config，调用系统 ssh
│   ├── probe.rs         远程探测 JSON
│   ├── runtime.rs       安装助手、列/建 tmux 会话
│   ├── pty.rs           放下 TUI，ssh -tt，再恢复
│   ├── agents.rs        agent id、tmux 名、resume 参数（文档和测试）
│   ├── doctor.rs        给人看的诊断
│   └── remote.py        在 SSH 对端用 python3 执行
├── docs/                产品 / 用户 / 开发者文档
└── plans/               原始范围
```

二进制名：`everywhere`。Rust 1.80+，edition 2021。

## 架构

```
本机                            SSH                         远程用户
┌─────────────────────┐         ControlMaster         ┌──────────────────────────┐
│ ratatui 选择器      │--------- exec bash -lc ------►│ python3 ~/.everywhere/   │
│                     │                               │   remote.py probe|list   │
│ 恢复 tty            │========= ssh -tt ===========►│ tmux -L everywhere      │
│                     │         PTY + SIGWINCH        │   eta-<agent>-<shortid>  │
└─────────────────────┘                               │   exec 原生 TUI          │
                                                      └──────────────────────────┘
```

**不自己实现 SSH。** 固定带 `BatchMode=yes`、`ControlMaster=auto`、`ControlPath=~/.everywhere/cm/%r@%h:%p`。

**不自己实现 coding UI。** attach 之后就是厂商 TUI 的字节流。

**tmux 隔离：** `-L everywhere`，不占用用户默认 server。配置在 `~/.everywhere/tmux.conf`（前缀 `C-g`、鼠标、truecolor）。该 socket 上已有 server 时 `-f` 会被忽略；第一次 `new-session` 会带上我们的配置文件。

## 远程助手

`src/remote.py` 通过 `include_str!` 打进二进制。探测时对本机嵌入脚本做 SHA-256，和远程 `~/.everywhere/remote.py` 比较；不一致就用 python3 从 stdin 写过去，不用包管理器。

| 命令 | 作用 |
| --- | --- |
| `probe` | tmux + 四家 agent：是否存在、版本、路径、auth_hint |
| `list --agent <id>` | 磁盘会话 + live tmux 名 |
| `start --agent --cwd --tmux [--session-id]` | 已有 session 则 exists，否则 `new-session -d` |
| `has --tmux` | 是否 live |
| `ensure` | 创建 `~/.everywhere` 并写 tmux.conf |
| `doctor` | 探测 + 说明 |

全部经 `ssh … bash -lc`，PATH 和交互式 SSH 一致。

### tmux 命名

```
eta-<agent>-<shortid>
```

`shortid` 是厂商 session id 去掉非字母数字后的最后 12 位（Rust `agents::short_id` 与 `remote.py` 同一规则）。新建会话用随机 12 位，启动命令 **不带** resume。

**不变量：** `tmux has-session` 为真时，`start` 不得再拉起一个 agent 进程。

## 模块与测试

| 文件 | 约定 |
| --- | --- |
| `ssh.rs` | 通配 Host 跳过；遇到 `Match` 停止；`base_args` 含 BatchMode |
| `agents.rs` | resume 参数表与 `remote.py` 对齐 |
| `runtime.rs` | helper hash；对 `remote.py` 做 `py_compile` |
| `tui.rs` | live 只 attach；idle 才 `ensure_tmux_session(..., Some(id))` |

PTY：先 `ratatui::restore()`，再 `ssh -tt bash -lc 'exec tmux -L everywhere attach …'`。detach 后选择器重新 `ratatui::init()`。

## 本地开发

```bash
rustup toolchain install stable
cargo test
cargo fmt
cargo build
./target/debug/everywhere doctor
```

CI 里还没有远程 mock。单测覆盖 config 解析、argv、助手语法。真机路径见用户手册里的验收清单。

不要提交 `target/`、`__pycache__/`，也不要提交远程 `~/.everywhere` 的转储。

## 增加一家 agent

1. `src/agents.rs` 的 `AgentKind`（`slug`、`title`、`resume_argv`）
2. `src/remote.py` 的 `AGENTS`、`agent_argv` 和磁盘扫描
3. resume argv 测试；如有特征字符串，补 `REMOTE_PY.contains`
4. 更新中英用户手册表格

需要能按 id resume、家目录里有会话文件、并且有交互式 TUI。没有原生 TUI 的不要接到 attach 路径上。

## 没有新计划就不要做的事

- 统一 ACP / app-server 聊天 UI（已明确推迟）
- OpenClaw 式网关
- 密码 / 键盘交互 SSH
- 经 SSH 安装 tmux 或 agent
- 把协议端口绑到 `0.0.0.0`

## 发布

v0.1 只提供源码（`cargo install --path .`）。以后可以用 `cargo dist` 或 GitHub Actions 出 macOS/Linux 二进制。助手脚本用 hash 更新：旧远程会在下次探测时被覆盖。

## 许可证

MIT，见 [LICENSE](../../LICENSE)。

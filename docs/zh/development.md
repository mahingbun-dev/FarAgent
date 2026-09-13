# 开发者文档

[English](../en/development.md) · **中文**

本文说明 faragent 怎么组成、怎么改、怎么加一家 agent。日常使用请看 [用户手册](user-guide.md)。

## 仓库结构

```
faragent/
├── Cargo.toml
├── src/
│   ├── main.rs          clap：tui / doctor / probe / sessions
│   ├── tui.rs           ratatui 选择器（主机 → agent → 确认 → 会话）
│   ├── ssh.rs           解析 ~/.ssh/config，调用系统 ssh
│   ├── probe.rs         远程探测 JSON
│   ├── install.rs       官方安装/升级/卸载计划 + preflight
│   ├── runtime.rs       列/建 tmux 会话
│   ├── pty.rs           放下 TUI，ssh -tt，再恢复
│   ├── agents.rs        agent id、tmux 名、resume 参数（文档和测试）
│   ├── doctor.rs        给人看的诊断
│   └── remote.rs        探测/列会话/启动（逻辑在本机）
├── docs/                全部产品文档
│   ├── README.md        文档中心
│   ├── assets/          图片
│   ├── en/              English
│   └── zh/              中文
└── plans/               本地笔记（已 gitignore）
```

二进制名：`faragent`。Rust 1.80+，edition 2021。

## 架构

```
本机                            SSH                         远程用户
┌─────────────────────┐         ControlMaster         ┌──────────────────────────┐
│ ratatui 选择器      │--------- exec bash -lc ------►│ bash: which/find/tmux│
│ （Rust 解析 JSONL）  │                               │   + tmux -L faragent     │
│ 恢复 tty            │========= ssh -tt ===========►│ tmux -L faragent      │
│                     │         PTY + SIGWINCH        │   faragent-<agent>-<shortid>  │
└─────────────────────┘                               │   exec 原生 TUI          │
                                                      └──────────────────────────┘
```

**不自己实现 SSH。** 固定带 `BatchMode=yes`、`ControlMaster=auto`、`ControlPath=~/.faragent/cm/%r@%h:%p`。

**不自己实现 coding UI。** attach 之后就是厂商 TUI 的字节流。

**tmux 隔离：** `-L faragent`，不占用用户默认 server。配置在 `~/.faragent/tmux.conf`（前缀 `C-g`、鼠标、truecolor）。该 socket 上已有 server 时 `-f` 会被忽略；第一次 `new-session` 会带上我们的配置文件。列表/attach 仍会查升级前的 `-L farssh`，所以 live 的 `farssh-*` 会话不会丢；新建只走 `faragent`。

## 远程侧（不用 python3）

逻辑在本机 `src/remote.rs`。SSH 对端只跑 `bash -lc`（which、find、tmux），第一次开会话时用 stdin 写入 `~/.faragent/tmux.conf`。**不会**上传 faragent 二进制：macOS 编出来的文件没法在 Linux 上跑。

| 本机解析 | 远程 bash |
| --- | --- |
| `probe` | `command -v`、`--version`、auth 文件 `-s` |
| `list` | `find` 会话文件 + `tmux list-sessions`；JSON/JSONL 在本机解析 |
| `start` | `tmux has-session` / `new-session -d` |
| `ensure` | 写 `tmux.conf` |
| `preflight` / `install` | 检测 curl/node/tmux/包管理器；确认后用 `ssh -tt` 跑官方安装器 |

全部经 `ssh … bash -lc`，PATH 和交互式 SSH 一致。

### tmux 命名

```
faragent-<agent>-<shortid>
```

`shortid` 是厂商 session id 去掉非字母数字后的最后 12 位（`agents::short_id`）。新建会话用随机 12 位，启动命令 **不带** resume。

**不变量：** `tmux has-session` 为真时，`start` 不得再拉起一个 agent 进程。

## 模块与测试

| 文件 | 约定 |
| --- | --- |
| `ssh.rs` | 通配 Host 跳过；遇到 `Match` 停止；`base_args` 含 BatchMode |
| `agents.rs` | resume 参数表与 `remote.rs` start_script 对齐 |
| `remote.rs` | 探测/列表/启动文本协议；JSONL 元数据；脚本里不能有 python |
| `install.rs` | 官方 URL 常量；plan_for 夹具；`bash_login_command` 必须把 `|` 引起来 |
| `tui.rs` | live 只 attach；idle 才 `ensure_tmux_session(..., Some(id))` |

PTY：先 `ratatui::restore()`，再 `ssh -tt bash -lc '…'`（attach tmux 或跑安装脚本）。结束后选择器重新 `ratatui::init()`。

## 本地开发

```bash
rustup toolchain install stable
cargo test
cargo fmt
cargo build
./target/debug/faragent doctor
```

CI 里还没有远程 mock。单测覆盖 config 解析、argv、助手语法。真机路径见用户手册里的验收清单。

不要提交 `target/`，也不要提交远程 `~/.faragent` 的转储。

## 增加一家 agent

1. `src/agents.rs` 的 `AgentKind`（`slug`、`title`、`resume_argv`）
2. `src/remote.rs` 的 `list_script` / `row_from_file` 磁盘扫描
3. resume argv 测试，以及 probe/list 解析测试
4. 更新中英用户手册表格

需要能按 id resume、家目录里有会话文件、并且有交互式 TUI。没有原生 TUI 的不要接到 attach 路径上。

## 后续计划 vs 现在不要做

已列入后续（见 [roadmap.md](roadmap.md)）：

1. Windows 原生远程和客户端（OpenSSH + ConPTY，不依赖 WSL）
2. 围绕主机 / agent / 会话的 App 前端样式

没有单独立项就不要做：

- OpenClaw 式网关
- 密码 / 键盘交互 SSH
- 经 SSH 安装 tmux 或 agent
- 把协议端口绑到 `0.0.0.0`
- 把 API key 拷到笔记本

## 发布

v0.1 只提供源码（`cargo install --path .`）。以后可以用 `cargo dist` 或 GitHub Actions 出 macOS/Linux 二进制。远程的 `tmux.conf` 每次 start 都会用嵌入模板覆盖。

## 许可证

MIT，见 [LICENSE](../../../LICENSE)。

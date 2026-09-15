# 开发者文档

[English](../en/development.md) · **中文**

本文说明 faragent 怎么组成、怎么改、怎么加一家 agent。日常使用请看 [用户手册](user-guide.md)。

## 仓库结构

```
faragent/
├── Cargo.toml                 虚拟 workspace 根
├── crates/
│   ├── faragent-core/         词汇表：agents、config、paths、引用工具、Lang
│   ├── faragent-transport/    Transport trait + 系统 OpenSSH 实现、askpass
│   ├── faragent-remote/       远端脚本（POSIX + Windows）与解析器
│   ├── faragent-service/      probe / 会话 / doctor / 诊断
│   ├── faragent-install/      官方安装/升级/卸载计划 + preflight
│   ├── faragent-tui/          ratatui 选择器 + 本地 tty 交接（放 TUI，ssh -tt）
│   └── faragent-cli/          `faragent` 二进制（clap：tui / doctor / probe / sessions / auth / login）
├── docs/                      全部产品文档
│   ├── README.md              文档中心
│   ├── assets/                图片
│   ├── en/                    English
│   └── zh/                    中文
└── plans/                     本地笔记（已 gitignore）
```

依赖方向严格单向：CLI → TUI → service → transport/remote/install → core。新增功能 = 新增 crate（或 core 模块）；新增前端只依赖 service 层。

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

**不自己实现 SSH。** 固定带 `ControlMaster=auto`、`ControlPath=~/.faragent/cm/%r@%h:%p`；`args_for()` 按 `AuthMode` 选认证参数：`key` 是 `BatchMode=yes` + 公钥，`password` 允许交互提示并在登录后复用同一条多路复用连接。密码只进系统 ssh，FarAgent 不读不存。

**不自己实现 coding UI。** attach 之后就是厂商 TUI 的字节流。

**tmux 隔离：** `-L faragent`，不占用用户默认 server。配置在 `~/.faragent/tmux.conf`（前缀 `C-g`、鼠标、truecolor）。该 socket 上已有 server 时 `-f` 会被忽略；第一次 `new-session` 会带上我们的配置文件。列表/attach 仍会查升级前的 `-L farssh`，所以 live 的 `farssh-*` 会话不会丢；新建只走 `faragent`。

## 远程侧（不用 python3）

逻辑在本机 `crates/faragent-remote`。SSH 对端只跑 `bash -lc`（which、find、tmux），第一次开会话时用 stdin 写入 `~/.faragent/tmux.conf`。**不会**上传 faragent 二进制：macOS 编出来的文件没法在 Linux 上跑。

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

| crate（模块） | 约定 |
| --- | --- |
| `faragent-transport`（`ssh.rs`） | 通配 Host 跳过；遇到 `Match` 停止；`args_for`/`Flavor` 决定认证参数；`TransportError` 保留原始输出 |
| `faragent-service`（`diagnose.rs`） | 原始报错 → `Problem`（有序匹配）→ 文案与修复命令，`diagnosis_of` 决定 TUI 是否开报错页 |
| `faragent-core`（`agents.rs`） | resume 参数表与远端 start 脚本对齐 |
| `faragent-remote`（`remote.rs`、`win.rs`） | 探测/列表/启动文本协议；JSONL 元数据；脚本里不能有 python |
| `faragent-install` | 官方 URL 常量；plan_for 夹具；`bash_login_command` 必须把 `|` 引起来 |
| `faragent-tui`（`tui.rs`） | live 只 attach；idle 才 `ensure_tmux_session(..., Some(id))` |

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

1. `crates/faragent-core/src/agents.rs` 的 `AgentKind`（`slug`、`title`、`resume_argv`）
2. 磁盘扫描：`crates/faragent-remote/src/remote.rs` 的 `list_script`（POSIX）**和** `crates/faragent-remote/src/win.rs` 的 `list_script`（Windows）
3. resume argv 测试，以及 probe/list 解析测试
4. 更新中英用户手册表格
5. 对话视图适配器：`apps/faragent-app/src/lib/chat/adapters/` 下一个 `(records, firstIndex) => ChatEvent[]` 函数，外加该目录注册表里的一行——前提是这个 agent 的 transcript 要能在对话视图里画出来。**照真实 transcript 写，不要照格式文档写**；量不到的形状，在字段上和 fixture 里标 `unverified`，而不是编一个看起来合理的出来

有两件事容易混为一谈，但它们不是同一个问题：

- **读** transcript 需要适配器。`adapterFor` 返回 `null` 是一个真实的答案——它表示这个 tab 没有对话视图、继续显示终端，在记录形状被弄懂之前这正是对的
- **在启动时命名**一个新会话的 transcript 文件，取决于 `AgentKind::may_accept_session_id`（`crates/faragent-core/src/agents.rs`）。CLI 自己挑 session id 的 agent，在 rail 扫描磁盘之前算不出路径；见 `apps/faragent-app/src/lib/chat/transcript-path.ts`，它正是对这类 agent 返回 `null`，并写明了原因

需要能按 id resume、家目录里有会话文件、并且有交互式 TUI。没有原生 TUI 的不要接到 attach 路径上。

## Windows 方言

`crates/faragent-remote/src/win.rs` 是该 crate `remote.rs` POSIX 脚本在 Windows 上的对应物。基本规则：

- 外壳是 cmd.exe（sshd 默认），干活的都是 PowerShell 5.1。
- 脚本**全 ASCII**、经 stdin 交付（`powershell -File -`）；动态值走 base64 `$args`。上 ssh 命令行的内容完全不需要 cmd 引号处理，也不受 cmd ~8k 命令行上限约束。交互式 launcher 用 `-EncodedCommand`（stdin 要留给 tty），保持简短。
- 每个脚本开头强制 UTF-8 输出（`[Console]::OutputEncoding`）。
- `FARAGENT_*_V1` 标记与 tab 分隔协议和 POSIX 侧共用；`remote.rs` 的解析器不关心字节来自哪个方言。
- 远端方言只探测一次（`echo FARAGENT_OS_V1 %OS% "$env:OS"`），按主机缓存在 `~/.faragent/config.json`；`probe_host` 会自愈缓存，并用另一方言重试一次。

Windows 客户端没有 ControlMaster（Win32 OpenSSH）：`ssh::mux_capable()` 探测后整体省略复用参数。内存密码路径在 `crates/faragent-transport/src/askpass.rs`——改 ssh 环境变量相关代码前先读它的模块文档。

## 后续计划 vs 现在不要做

已列入后续（见 [roadmap.md](roadmap.md)）：

1. Windows 会话托管：ConPTY + 命名管道 attach/detach，不用 WSL 也能有 tmux 等价保活
2. 围绕主机 / agent / 会话的 App 前端样式
3. 认证模式：`auto` / `key` / `password` 已支持；之后可考虑系统钥匙串与更省事的跳板机体验

没有单独立项就不要做：

- OpenClaw 式网关
- 把协议端口绑到 `0.0.0.0`
- 把 API key 拷到笔记本

## 发布

打 tag 后由 GitHub Actions（ubuntu/macos/windows）出各平台产物并附到 Release；`cargo install --path crates/faragent-cli` 依旧可用。POSIX 远程的 `tmux.conf` 每次 start 都会用嵌入模板覆盖。

## 许可证

MIT，见 [LICENSE](../../../LICENSE)。

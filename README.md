# everywhere

通过本机 SSH 直连远程 Linux / macOS（Windows 用 WSL），发现并使用已经装在那台机器上的 coding agent：

- Claude Code (`claude`)
- Codex (`codex`)
- Grok Build (`grok`)
- Pi (`pi`)

本机只做 **主机 / agent / 会话** 管理。真正 coding 时把 tty 交给远程 **原生 TUI**（tmux 保活）。模型请求、文件、MCP、密钥都留在远程。

v1 不做自有网关，也不做统一聊天 UI。

## 前置

**本机**

- macOS 或 Linux
- OpenSSH 客户端
- `~/.ssh/config` 里有具体 `Host`（通配 `*` / `?` 会被忽略）
- 对该 Host **密钥或 ssh-agent 免密**（BatchMode，不弹密码）

**远程**

- OpenSSH 服务
- `tmux`
- `python3`（探测和列会话）
- 至少一个 coding agent，且已在远程登录
- Windows 只支持 SSH 进 **WSL2**，不支持原生 Win32 OpenSSH ConPTY

本工具 **不会** 在远程安装 tmux 或任何 agent。

## 安装

```bash
cargo install --path .
everywhere --help
```

开发：

```bash
cargo build
cargo test
./target/debug/everywhere
```

## 用法

```bash
everywhere                  # 管理 TUI
everywhere doctor           # 列出本机 SSH Host
everywhere doctor --host devbox
everywhere probe --host devbox
everywhere sessions --host devbox --agent grok
```

TUI 路径：选 Host → 看四家版本 → 选会话或 `n` 新建 → 进入远程原生 TUI。

| 键 | 作用 |
| --- | --- |
| `j` / `k` 或方向键 | 移动 |
| Enter | 探测 / 打开 / attach |
| `n` | 新建会话（输入远程 cwd） |
| `r` | 刷新 |
| `q` | 返回 / 退出 |
| **在 agent 里 `C-g d`** | detach，agent 继续跑，回到列表 |

独立 tmux socket 名：`everywhere`（不碰你日常的 tmux 会话）。prefix 是 `C-g`，避免和 agent 快捷键抢 `C-b`。

**live** 会话只 attach，不会再 `resume` 出一个第二进程（避免 Codex 断线双开）。

## 手工验收

在一台已免密、已装 tmux 和至少一家已登录 agent 的远程 Linux 或 macOS 上：

1. [ ] `everywhere doctor --host <alias>` 能看到版本
2. [ ] TUI 选 host → 看到已装 agent 的版本、未装显示 `not installed`
3. [ ] 新建会话，原生 TUI 出现；做一个只读任务
4. [ ] 在 **远程原生 UI** 里点一次写文件/bash 权限，行为与本地一致
5. [ ] `C-g d` detach，列表该行为 `live`
6. [ ] 杀掉本机 `everywhere`，再 attach 同一条：画面还在，不是新 resume
7. [ ] 无 tmux 时不能进入透传，并提示自行安装

Windows 仅测 WSL，或标明未测。

## 不做（v1）

- OpenClaw 式网关 / 目标机常驻本工具 daemon
- ACP / app-server 统一 coding UI
- SSH 密码、OTP、ProxyJump
- 远程自动安装软件
- 把远程 API key 拷到本机
- 会话删除 / 重命名 / fork

计划书：[plans/2026-09-12-everywhere-to-agent.md](plans/2026-09-12-everywhere-to-agent.md)

<p align="center">
  <img src="docs/assets/logo.jpg" width="120" height="120" alt="faragent">
</p>

<h1 align="center">FarAgent</h1>

<p align="center"><a href="README.md">English</a> · <strong>中文</strong></p>

<p align="center">
  <strong>远在你家机器上的 coding agent，用 SSH 接上原生 TUI。</strong><br>
  命令：<code>faragent</code>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/zh/README.md">文档中心</a> ·
  <a href="docs/zh/user-guide.md">用户手册</a> ·
  <a href="docs/zh/development.md">开发者文档</a>
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-0f766e">
  <img alt="rust" src="https://img.shields.io/badge/rust-1.80%2B-b45309">
  <img alt="ssh" src="https://img.shields.io/badge/transport-OpenSSH-334155">
  <img alt="agents" src="https://img.shields.io/badge/agents-claude%20%7C%20codex%20%7C%20grok%20%7C%20pi-0891b2">
</p>

---

**FarAgent**（命令 `faragent`）把你的终端接到 **已经装在自己机器上** 的 Claude Code、Codex、Grok Build、Pi。它不是 Herdr/ccmux 那种本地 mux，也不是把密钥隧道回本机：推理仍走远程配置。（曾用名 FarSSH。）

大模型、项目文件、MCP、API 密钥都留在远程。合上笔记本不会杀掉 agent——它在 tmux 里继续跑。之后再打开 `faragent`，attach 同一个窗格即可。

## 为什么需要它

| 你现在已经在做的事 | 没有 faragent | 有 faragent |
| --- | --- | --- |
| `ssh devbox` 再自己记 `tmux attach` | 容易在同一仓库再拉起第二个 Codex/Claude | 主机 → agent → 会话，**live 只 attach** |
| Claude / ChatGPT / Grok 订阅在家里那台机器上 | 把密钥拷到咖啡馆笔记本很危险 | 密钥不离开远程 |
| 要原生 TUI（slash、鼠标、权限确认） | 官方桌面远程往往只服务一家 | Claude Code、Codex、Grok Build、Pi 同一个选择器 |

它不是新的 coding agent，不是云 IDE，也不是要在每台机器上安装的网关。

## 工作方式

```mermaid
flowchart LR
  You[你的笔记本<br/>faragent TUI] -->|OpenSSH BatchMode<br/>ControlMaster| Probe[远程登录壳]
  Probe --> List[探测 claude / codex / grok / pi<br/>列出磁盘会话]
  You -->|ssh -tt PTY| Tmux[tmux socket: faragent]
  Tmux --> Agent[原生 TUI<br/>权限、slash、鼠标]
```

1. 从 `~/.ssh/config` 选一个具体 `Host`（`*` 通配会被忽略）。
2. 用远程 **登录壳** 探测，这样 nvm / Homebrew / `~/.local/bin` 仍然有效。
3. 选择 agent 和会话，或在远程目录里新建。
4. 在独立 tmux socket `faragent` 上创建或复用会话（不碰你日常的 tmux）。
5. 本机终端变成远程 agent。用 **`Ctrl-g d`** detach。以后再 attach；不要对 live 进程再 `resume`。

## 功能

- **四家 agent，一个选择器** — Claude Code、Codex、Grok Build、Pi；未安装显示「未安装 · 回车安装」。
- **原生 vibe coding** — 不是自研聊天界面。slash、diff、权限提示都是该 agent 自己的。
- **会话列表** — 磁盘上的 idle 记录，加上 **live** 的 tmux 窗格。
- **安全重连** — live 只 attach，避免两个 Codex 同时改同一仓库（[openai/codex#30424](https://github.com/openai/codex/issues/30424)）。
- **远程仍是你的** — 官方安装器在你确认命令之后跑在那台机器上；API key 留在远程；不对外监听；流量走 SSH。
- **安装 / 升级 / 卸载** — 确认屏列出每条命令，然后 `ssh -tt` 直播过程。agent：官方 `curl | bash`，用户目录，不用 sudo。tmux/curl 可用 sudo + brew/apt/dnf/yum/pacman/apk。
- **Doctor** — `faragent doctor --host devbox` 打印 PATH、tmux 和各 agent 版本。

```
┌ FarAgent · home-mac · Grok Build ──────────────────────────┐
│ sessions  [live]=tmux still running                          │
│ ▸ [live]  SSH passthrough TUI   (/Users/you/code/app)        │
│   [idle]  Fix flaky tests       (/Users/you/code/app)        │
│   [idle]  (no sessions — press n to start one)               │
├──────────────────────────────────────────────────────────────┤
│ enter attach/resume · n new · r refresh · q back             │
│ agent detach: C-g d                                          │
└──────────────────────────────────────────────────────────────┘
```

## 快速开始

**本机：** macOS 或 Linux，OpenSSH，对该 Host **密钥免密**（BatchMode，不能弹密码）。

**远程：** `sshd` 和 `bash`。缺 tmux 或缺 agent 可从 TUI 代装。请在那台机器上登录一次 agent。不需要 python3。Windows 主机：SSH 进 **WSL2**，不要走 Win32 OpenSSH。

```bash
git clone https://github.com/mahingbun-dev/FarAgent.git
cd FarAgent
cargo install --path .
```

```ssh-config
# ~/.ssh/config  — 选择器会忽略 Host * 这类通配
# HostName：局域网 IP、公网 IP、域名，或 Tailscale 的 100.x / MagicDNS
Host home-mac
    HostName 192.168.1.8
    User you
    IdentityFile ~/.ssh/id_ed25519
```

```bash
ssh home-mac true          # 必须免密成功
faragent doctor --host home-mac
faragent                 # TUI：主机 → agent → 会话
```

在 agent TUI 里用 **`Ctrl-g` 再按 `d`** detach。进程继续在远程跑。

完整步骤见 [用户手册](docs/zh/user-guide.md)（开发者模式、打包二进制、迁到另一台电脑）。家里机器在 NAT 后面：见 [SSH 连接](docs/zh/ssh-access.md)（局域网、公网 IP、域名、Tailscale）。

## 文档

| 主题 | English | 中文 |
| --- | --- | --- |
| 文档中心 | [docs/](docs/README.md) | [docs/zh/](docs/zh/README.md) |
| 产品介绍 | [README](README.md) | [README.zh-CN.md](README.zh-CN.md) |
| 使用说明 | [User guide](docs/en/user-guide.md) | [用户手册](docs/zh/user-guide.md) |
| SSH（局域网 / 公网 / 域名 / Tailscale） | [SSH access](docs/en/ssh-access.md) | [SSH 连接](docs/zh/ssh-access.md) |
| 架构与开发 | [Development](docs/en/development.md) | [开发者文档](docs/zh/development.md) |
| 参与贡献 | [Contributing](docs/en/contributing.md) | [参与贡献](docs/zh/contributing.md) |
| 安全 | [Security](docs/en/security.md) | [安全说明](docs/zh/security.md) |
| 后续计划 | [Roadmap](docs/en/roadmap.md) | [后续计划](docs/zh/roadmap.md) |

## 现状

v0.1 适合已经习惯 SSH 的人。接下来要做：**Windows 原生（不使用 WSL）**，以及 **App 前端样式**。详见 [后续开发计划](docs/zh/roadmap.md)。

当前计划之外：密码 SSH、ProxyJump。

## 许可证

[MIT](LICENSE)

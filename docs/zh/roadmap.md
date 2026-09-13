# 后续开发计划

[English](../en/roadmap.md) · **中文**

v0.1 是 Linux / macOS / Windows **WSL** 上的 SSH 选择器 + 原生 TUI 透传。下面两项是明确要做的后续工作，不在当前版本里。

## 1. 支持 Windows 原生（不使用 WSL）

把 Windows 同时当作 **客户端** 和 **远程主机** 用，不再依赖 WSL2。

| 方面 | 目标 |
| --- | --- |
| 远程 | 直接对接 Win32 OpenSSH + ConPTY（`claude` / `codex` / `grok` / `pi` 的 Windows 原生程序） |
| 保活 | 不依赖 Linux `tmux` 也能保住会话（Windows 原生会话托管或等价方案） |
| 客户端 | `faragent` 可在 Windows Terminal / PowerShell 上运行，不只是 macOS 和 Linux |
| PATH / 探测 | 识别用户 PATH、`AppData`，以及 `%USERPROFILE%` 下的 `.claude` / `.codex` / `.grok` / `.pi` |

WSL 仍然支持。原生 Windows 是增量能力。

## 2. 增加 App 前端样式

做真正的 **应用前端** 和视觉设计，而不只是现在的终端选择器。

| 方面 | 目标 |
| --- | --- |
| 外壳 | 主机列表、agent 版本、会话列表用有设计的界面（版式、字体、颜色、空态/错误态） |
| 终端 | 内嵌或弹出远程 agent TUI，vibe coding 仍走各家原生界面 |
| 体验 | 更接近桌面产品，而不是裸 SSH 封装；模型密钥仍然留在远程 |

管理界面可以演进；远程执行和凭据仍在那台机器上。

## 在另立项之前仍不做

OpenClaw 式网关、源码编译 tmux、Entware/synopkg、把 API key 拷到笔记本。（密码 / 键盘交互登录已支持，见 [SSH 连接](ssh-access.md#服务端只让用密码可选)。）

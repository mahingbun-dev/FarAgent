# 后续开发计划

[English](../en/roadmap.md) · **中文**

v0.2 已支持 Linux / macOS / **Windows 11** 上的 SSH 选择器 + 原生 TUI 透传 —— Windows 既能当客户端，也能当远程主机（resume 模式，不使用 WSL）。WSL 仍然支持（它就是一台 Linux 主机）。下面是明确要做的后续工作。

## 1. Windows 会话托管（不用 WSL 的 tmux 等价保活）

v0.2 的 Windows 远程是**前台运行**：退出 agent（或断开连接）即结束，下次经 `resume` 恢复上下文。下一步做真正的保活。

| 方面 | 目标 |
| --- | --- |
| 托管 | faragent 的隐藏子命令用 ConPTY 托管 agent，断线后会话仍存活 |
| 接入 | 命名管道 attach/detach，`C-g d` 前缀与 tmux 行为一致 |
| live | Windows 远程也有 `[live]`；进程扫描的 `[running]` 启发式保留给其他来源的进程 |
| 上传 | 首次使用时经用户确认上传到远端；无需管理员、不写注册表 |

## 2. 增加 App 前端样式

做真正的 **应用前端** 和视觉设计，而不只是现在的终端选择器。

| 方面 | 目标 |
| --- | --- |
| 外壳 | 主机列表、agent 版本、会话列表用有设计的界面（版式、字体、颜色、空态/错误态） |
| 终端 | 内嵌或弹出远程 agent TUI，vibe coding 仍走各家原生界面 |
| 体验 | 更接近桌面产品，而不是裸 SSH 封装；模型密钥仍然留在远程 |

管理界面可以演进；远程执行和凭据仍在那台机器上。

## 在另立项之前仍不做

OpenClaw 式网关、源码编译 tmux、Entware/synopkg、把 API key 拷到笔记本。（密码 / 键盘交互登录已支持，见 [SSH 连接](ssh-access.md#服务端只让用密码可选)；Windows 只支持 11，不支持 Windows 10。）

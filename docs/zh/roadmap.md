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

## 2. App 前端 —— 除了一块，其余已落地

**应用前端** 在 v0.2 已经做出来了：有设计的窗口，而不只是终端选择器。剩下的只有「对话」这一块。

| 方面 | 现状 |
| --- | --- |
| 外壳 | **已落地。** 主机 / agent 选择器，以及按会话所在工作区分组的会话列表。 |
| 面板 | **已落地。** 只读的文件树 / 预览 / 改动 / Git 视图，通过远端 helper 通道读取（`git.diff`、`git.branches`、push 触发刷新）。按设计不做任何 Git 写操作。 |
| 终端 | **已落地。** 远程 agent 自己的 TUI，直接嵌在应用里 attach，vibe coding 仍走各家原生界面。 |
| 对话 | **尚未做。** 用 agent 自己的会话记录渲染出对话视图，同时保留终端作为兜底。 |

管理界面可以演进；远程执行和凭据仍在那台机器上。

## 在另立项之前仍不做

OpenClaw 式网关、源码编译 tmux、Entware/synopkg、把 API key 拷到笔记本。（密码 / 键盘交互登录已支持，见 [SSH 连接](ssh-access.md#服务端只让用密码可选)；Windows 只支持 11，不支持 Windows 10。）

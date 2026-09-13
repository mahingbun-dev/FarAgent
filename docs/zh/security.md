# 安全说明

[English](../en/security.md) · **中文**

`faragent` 是 SSH 客户端封装。能用它连上一台主机，就等于能跑该用户的 coding agent，从而读写对应仓库。不要把家里的 `sshd` 无必要地暴露在公网；出门连家用机器见 [SSH 连接 · Tailscale](ssh-access.md#用-tailscale-做内网穿透推荐)。

## 我们假定

- 你已经信任以该用户执行 `ssh <host>`。
- 认证默认是 **密钥 / ssh-agent**（`BatchMode`），SSH 本身不弹密码。服务端只让用账号密码时可以切到密码模式。macOS/Linux 上**密码只输入给系统 OpenSSH**，FarAgent 不读取、不转发、不写进配置或日志；登录成功后只留下一条 ControlMaster 多路复用 socket（`~/.faragent/cm/`，权限 `0700`，密码模式默认保留 4 小时）。Windows 客户端（自带 ssh 不支持复用）改由 FarAgent 自己询问密码，**只保留在本次运行的进程内存里**——退出即清零、绝不写盘——再经 `SSH_ASKPASS` 助手（把 faragent 自身再拉起一次）交给 OpenSSH，密码经回环 socket + 一次性令牌传递。`faragent auth --host X --mode key` 可随时退回只允许密钥。
- 远程命令以 SSH 用户身份运行：Linux/macOS 上是 `bash -lc` 加 tmux socket `faragent`；Windows 上经默认 cmd 外壳调 PowerShell，没有 tmux。确认过的 tmux/curl 步骤可能在直播 PTY 里调用 `sudo`（密码当场输入，FarAgent 不保存）；Windows 安装全部是用户级，从不需要管理员。

## 我们不会做的事

- 把 API key、`auth.json` 或 cookie 拷到笔记本
- 在 `0.0.0.0` 上监听，或发布网关
- 执行远程回传的安装脚本（安装器 URL 写死在本机）
- 除确认屏上的 tmux/curl（brew/apt/dnf/yum/pacman/apk）外使用 sudo
- 卸载时删除 agent 配置和密钥（`~/.claude`、`~/.codex`、`~/.grok`、`~/.pi`）
- 绕过 macOS TCC；若 `sshd` 读不了 `Documents`，请自行给它完全磁盘访问权限

## 报告漏洞

请在本仓库开 GitHub 非公开安全公告，或联系 GitHub 资料页上的维护者。在修复发布前，请不要把凭据泄漏或远程助手 RCE 写成公开 Issue。

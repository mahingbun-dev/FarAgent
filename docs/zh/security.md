# 安全说明

[English](../en/security.md) · **中文**

`faragent` 是 SSH 客户端封装。能用它连上一台主机，就等于能跑该用户的 coding agent，从而读写对应仓库。

## 我们假定

- 你已经信任以该用户执行 `ssh <host>`。
- 认证只有 **密钥 / ssh-agent**（`BatchMode`）。SSH 本身不会弹密码。
- 远程命令（`bash -lc`、tmux socket `faragent`）以 SSH 用户身份运行。确认过的 tmux/curl 步骤可能在直播 PTY 里调用 `sudo`（密码当场输入，FarAgent 不保存）。

## 我们不会做的事

- 把 API key、`auth.json` 或 cookie 拷到笔记本
- 在 `0.0.0.0` 上监听，或发布网关
- 执行远程回传的安装脚本（安装器 URL 写死在本机）
- 除确认屏上的 tmux/curl（brew/apt/dnf/yum/pacman/apk）外使用 sudo
- 卸载时删除 agent 配置和密钥（`~/.claude`、`~/.codex`、`~/.grok`、`~/.pi`）
- 绕过 macOS TCC；若 `sshd` 读不了 `Documents`，请自行给它完全磁盘访问权限

## 报告漏洞

请在本仓库开 GitHub 非公开安全公告，或联系 GitHub 资料页上的维护者。在修复发布前，请不要把凭据泄漏或远程助手 RCE 写成公开 Issue。

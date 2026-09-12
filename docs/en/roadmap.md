# Roadmap

**English** · [中文](../zh/roadmap.md)

v0.1 is the SSH picker plus native TUI passthrough on Linux, macOS, and Windows **WSL**. The items below are committed follow-up work, not v0.1 scope.

## 1. Native Windows (no WSL)

Use Windows as both a **client** and a **remote host** without requiring WSL2.

| Area | Intent |
| --- | --- |
| Remote | Talk to Win32 OpenSSH + ConPTY directly (`claude` / `codex` / `grok` / `pi` as native Windows binaries) |
| Persistence | Keep sessions alive without relying on Linux `tmux` (Windows-native session host or equivalent) |
| Client | `farssh` itself runs on Windows Terminal / PowerShell, not only macOS and Linux |
| PATH / probe | Honor user-level PATH, `AppData`, and `%USERPROFILE%\.claude` / `.codex` / `.grok` / `.pi` |

WSL remains supported. Native Windows is additive.

## 2. App frontend styling

Add a real **application frontend** with a designed visual language, instead of only the current terminal picker.

| Area | Intent |
| --- | --- |
| Shell | Host list, agent versions, and sessions in a styled app UI (layout, typography, color, empty/error states) |
| Terminal | Embed or pop the remote agent TUI so vibe coding still uses the vendor interface |
| Feel | Closer to a desktop product than a raw SSH wrapper, without moving model keys off the remote machine |

The manager UI can evolve; remote execution and credentials stay on the host.

## Still out of scope until separately planned

Password / OTP SSH, ProxyJump, an OpenClaw-style gateway, auto-installing tmux or agents, copying API keys to the laptop.

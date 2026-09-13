# Roadmap

**English** · [中文](../zh/roadmap.md)

v0.2 ships the SSH picker plus native TUI passthrough on Linux, macOS, and **Windows 11** — both as a client and as a remote host (resume mode, no WSL). WSL remains supported; it is just a Linux host. The items below are committed follow-up work.

## 1. Windows session host (tmux-equivalent keep-alive, no WSL)

v0.2's Windows remote runs agents in the **foreground**: quitting the agent (or losing the connection) ends it, and the conversation comes back through `resume`. The next step is real persistence.

| Area | Intent |
| --- | --- |
| Host | A hidden faragent subcommand hosts the agent under a ConPTY; the session survives disconnects |
| Attach | Named-pipe attach/detach with the `C-g d` prefix, the way tmux behaves |
| Live | `[live]` works on Windows remotes; the process-scan `[running]` heuristic stays for foreign processes |
| Upload | Shipped to the remote on first use, with the user's confirmation; no admin rights, nothing in the registry |

## 2. App frontend styling

Add a real **application frontend** with a designed visual language, instead of only the current terminal picker.

| Area | Intent |
| --- | --- |
| Shell | Host list, agent versions, and sessions in a styled app UI (layout, typography, color, empty/error states) |
| Terminal | Embed or pop the remote agent TUI so vibe coding still uses the vendor interface |
| Feel | Closer to a desktop product than a raw SSH wrapper, without moving model keys off the remote machine |

The manager UI can evolve; remote execution and credentials stay on the host.

## Still out of scope until separately planned

An OpenClaw-style gateway, compiling tmux from source, Entware/synopkg, copying API keys to the laptop. (Password / keyboard-interactive login ships — see [SSH access](ssh-access.md#password-only-servers-optional); Windows 10 is not supported, Windows 11 only.)

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

## 2. App frontend — shipped, apart from one piece

The **application frontend** landed in v0.2: a designed window rather than only the terminal picker. What is left is the conversation itself.

| Area | State |
| --- | --- |
| Shell | **Shipped.** Host and agent switchers, and a session rail grouped by the workspace each session runs in. |
| Panel | **Shipped.** A read-only file tree / preview / changes / Git view, reading the remote over a helper channel (`git.diff`, `git.branches`, push-driven refresh). No Git writes, by design. |
| Terminal | **Shipped.** The remote agent's own TUI, attached inside the app, so vibe coding still uses the vendor interface. |
| Conversation | **Not yet.** Rendering one conversation per agent from the agent's own transcript, with the terminal kept as the escape hatch. |

The manager UI can evolve; remote execution and credentials stay on the host.

## Still out of scope until separately planned

An OpenClaw-style gateway, compiling tmux from source, Entware/synopkg, copying API keys to the laptop. (Password / keyboard-interactive login ships — see [SSH access](ssh-access.md#password-only-servers-optional); Windows 10 is not supported, Windows 11 only.)

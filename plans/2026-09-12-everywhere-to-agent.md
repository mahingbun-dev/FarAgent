# 可执行计划书：FarSSH（本机 SSH 直连 + 原生 TUI 透传）

> 产品已更名为 **FarSSH**（命令/仓库 `farssh`）。下文历史名称已尽量替换。

> 生成：2026-09-12 ｜ 修订：2026-09-12（交互形态改为 PTY 透传）｜ 状态：开发中（`dev/ssh-pty-passthrough`）

## 1. 一句话目标

做一个本机终端 TUI：从 `~/.ssh/config` 选出远程 Linux / macOS（Windows 走 WSL）主机，探测 Claude Code / Codex / Grok Build / Pi 的安装与版本，列出并选择会话，然后 **SSH PTY 透传远程该 agent 的原生全屏 TUI** 做 vibe coding。agent 进程、文件、shell、MCP、模型密钥一律留在远程；SSH 断开后由远程 tmux 保住进程，重连只 attach，不拉起第二份 agent。

**成功标准：** 在一台已免密 SSH、已安装 `tmux` 和至少一个目标 agent 且已登录的远程 Linux/macOS 上，从本机能完成「选主机 → 看到版本 → 选/新建会话 → 进入与本地几乎一样的原生 TUI → 权限/快捷键/鼠标按该 agent 自己的方式工作 → detach 或断线后重连仍在同一 tmux 窗格」。全程不把远程 API key 拷到本机，也不在远程安装任何软件。

## 2. 背景

仓库 `farssh` 目前几乎为空（MIT，README：work with your personal agent in farssh）。触发点是人在别处，agent 和项目、订阅、MCP 配在家里的 PC / Mac / Linux 箱上，希望远程用起来接近本地。

**架构修订：** 访谈中先选过「统一本地 TUI + ACP/app-server」。落地成本高（四套协议、权限流、热重连状态机）。后改为 **先透传原生 TUI**：本机只做主机/agent/会话管理，coding 交给远程已经存在的 `claude` / `codex` / `grok` / `pi`。统一 UI 留作后续，不进 v1。

也曾考虑 OpenClaw 式网关，已否决。v1 **只做本机 SSH 直连**。

同类方案对照：

| 方案 | 模型请求在哪 | 与本目标 |
| --- | --- | --- |
| pi-ssh-remote / ai-coding-ssh / Clide | 本地 agent 或本地密钥 | 相反 |
| Claude Desktop SSH / Codex App SSH | 远程 engine + 官方 GUI | 方向对，但是闭套、不统一四家 |
| Herdr / Claude Code Studio | tmux 保活 + PTY | **最接近**：本工具是轻量版，只管这四家 coding agent 的发现、会话列表和 attach |
| 本工具 v1 | 远程原生 TUI，经 SSH PTY + tmux | 选定 |

## 3. 访谈结论（已确认决策）

| 维度 | 结论 |
| --- | --- |
| 目标 | 本机管理 TUI + 远程原生 TUI 透传；LLM 走远程配置；体验接近在那台机器上本地打开 agent |
| 范围 | 见第 5 节。四个 agent 的 **coding 透传同等对待**（不再因协议成熟度把 Claude/Pi 降为 preview）。会话列表仍按各家磁盘/CLI 适配，完整度可以不同 |
| 约束 | 系统 OpenSSH + `~/.ssh/config` 具体 Host + 密钥/ssh-agent；远程可建 tmux 并在其中启动 agent CLI，**不安装**软件；不引入自有网关；不自研 coding UI |
| 资源 | 本地：Rust + ratatui（仅管理界面）+ 系统 `ssh -t`。远程：用户已装的 agent 与 tmux |
| 优先级 | 1) SSH 探测 2) tmux + PTY 透传一条 agent 3) 会话列表与 resume/热 attach 4) 四家启动命令对齐 5) TERM/鼠标/doctor |
| 验收标准 | 第 1 节成功标准 + 第 6 节；权限确认发生在 **远程原生 TUI 内**（透传过来），本机不重做权限 UI |
| 交互形态 | **PTY 透传远程原生 TUI**。管理界面只到会话列表；选中后交出 tty 给 `ssh -t … tmux attach` |
| 断线 | 远程 tmux 托管 **agent 交互进程**；掉线不杀；重连 attach 同一 tmux session。live 时禁止再 `resume` 出第二个进程 |
| 远程 OS | v1：Linux、macOS；Windows 只保证 WSL2（SSH 进 WSL sshd） |
| 客户端 | 仅本机终端。不做手机、不做 Web |
| vibe coding | 等于该 agent 在远程本地的能力（slash、plan、鼠标、权限都走原生）。本工具不复刻这些 |
| SSH | 非通配 Host；`BatchMode=yes`；不要密码、OTP、ProxyJump |
| 会话操作 | 列表（id、标题/摘要、cwd、时间、live/idle）+ 新建 + resume 磁盘会话 + 热 attach 已有 tmux。不做删除/重命名/fork |
| 远程写入 | 可创建/复用 named tmux，在其中 `cd` 并启动 agent。不改远程密钥、config、MCP |
| 实现 | Rust 单二进制，exec 本机 `ssh`，不自己实现 SSH 协议 |
| 网关 | **不做** |
| 统一协议 UI | **v1 不做**（曾选后撤销，改为透传） |

## 4. 待定项与默认假设

| 待定项 | 默认假设 | 再确认时机 / 负责人 |
| --- | --- | --- |
| 二进制名 | `farssh` | 实现 CLI 骨架时 |
| 管理 TUI 语言 | 英文界面 + 中文 README/计划书 | 第一次能跑选择器时 |
| 本地客户端 OS | macOS + Linux；Windows 客户端延后 | 需要时再开任务 |
| cwd 选择器 | 历史会话出现过的目录 + 手动输入，`test -d` 校验 | 做新建会话时 |
| 远程未登录 | 探测标 `installed, unauthenticated`；attach 后让原生 TUI 自己走登录流（或提示先在远程 `grok login --device-auth` 等）。工具不代登录 | 联调未登录主机时 |
| 非登录 shell PATH | 探测、tmux 启动命令都经登录壳，吃 nvm / Homebrew / `~/.local/bin` | 探测脚本里写死 |
| tmux 命名 | 每个 **coding 会话** 一个 tmux session：`farssh-<agent>-<shortid>`（例如 `farssh-grok-a1b2`）。live = 该 tmux session 存在且 pane 里还是对应进程 | 实现 runtime 时 |
| 退出透传回管理界面 | `tmux detach`（默认前缀 `C-b d`）结束 `ssh -t`，管理 TUI 恢复。agent `/quit` 则 tmux session 结束，列表里该条变为 idle | 做 PTY 循环时；可在状态行提示 detach 键 |
| tmux 前缀冲突 | 不改用户全局 `~/.tmux.conf`。本工具创建的 session 用 `-f` 指定一份最小配置（mouse on、truecolor、合理 prefix），只作用于这些 session | 实现 runtime 时若默认 prefix 难用再改 |
| TERM 转发 | `ssh -t` 继承本机 `TERM`/`COLORTERM`；tmux 配 `terminal-features` RGB。Grok 剪贴板走 OSC 52；必要时 doctor 提示 `grok wrap ssh` | 手测花屏时 |
| 四家启动命令 | 新建：`claude` / `codex` / `grok` / `pi`（已 `cd` 到 cwd）。恢复：`claude --resume <id>`、`codex resume <id>`、`grok --resume <id>`、`pi --session <id>` | 某家 CLI 变了再改对照表 |
| OpenClaw 网关 / 统一 ACP UI | v1 都不做 | 用户再次提出时单独立项 |

## 5. 范围

**做：**

- 解析 `~/.ssh/config`，列出具体 Host，探测免密连通
- 远程探测四 agent：是否在 PATH、版本、tmux 是否存在
- 管理 TUI：主机 → agent → 会话列表
- 按会话新建或 resume：在远程 tmux 里用登录壳启动对应 CLI
- `ssh -t` 把本机 tty 交给该 tmux session（真 PTY：键盘、鼠标、alt-screen、resize/`SIGWINCH`）
- live 则只 `tmux attach`；idle 的磁盘会话才 `resume` 进新 tmux
- detach / SSH 断开后 agent 继续跑；再选同一条则 attach，不双开
- 缺 tmux、缺二进制、SSH 失败、花屏相关的可读错误与 `farssh doctor --host X`

**不做（v1）：**

- 自研统一 coding UI、ACP / Codex app-server 适配器、本机权限模态
- OpenClaw 式网关 / 目标机常驻本工具 daemon
- 手机 / 浏览器
- 原生 Windows OpenSSH + ConPTY（不经 WSL）
- SSH 密码、OTP、ProxyJump
- 在远程安装或升级软件
- 把远程 API key 同步到本机
- 会话删除、重命名、fork
- 多 pane 同时看多个 agent（v1 同一时刻只透传一个 tty）
- 代为 OAuth 登录

## 6. 任务分解

| # | 任务 | 依赖 | 产出 | 验收标准 |
| --- | --- | --- | --- | --- |
| 1 | Cargo 骨架：binary `farssh`，模块 `ssh` / `probe` / `sessions` / `runtime` / `pty` / `tui` | — | 可 `cargo build`；README 写 build/run 与 SSH 前置 | `cargo test` 过；`--help` 能跑 |
| 2 | OpenSSH 控制面：解析 config、ControlMaster、远程 exec | 1 | `connect` / `exec` / `exec_login_shell` | 免密 Host 上 `uname -s` 成功；第二次 exec 复用 ControlMaster；BatchMode 下需密码的主机立刻失败并可读报错 |
| 3 | 远程探测（登录壳）：四 agent + tmux | 2 | JSON：`{agent, found, version, path, tmux}` | 只装 grok 时只显示 grok 版本；nvm/Homebrew 路径能找到；无 tmux 明确标出 |
| 4 | PTY 透传循环 | 2 | 管理进程让出 tty → `ssh -tt host -- tmux attach -t <name>` → 子进程退出后恢复 | 对远程 `tmux new -s farssh-test` 跑 `top`：全屏、能操作、resize 窗格跟着变、detach 后回到调用方且 `tmux ls` 仍有该 session |
| 5 | tmux runtime：每 coding 会话一个 named session | 3, 4 | 创建：`tmux new-session -d -s farssh-<agent>-<id> -c <cwd> -- <login-shell -lc agent-cmd>`；live 检测：`tmux has-session` | 无 tmux → 拒绝 attach 并提示自行安装。新建 grok 会话后远程能 `tmux ls` 看到 `farssh-grok-*`。同一 id 再进只 attach，`pgrep -c grok` 不增加 |
| 6 | 会话列表适配器 | 3, 5 | 统一 `SessionSummary { id, title, cwd, mtime, live }`；live 优先看 tmux 名 | Grok：`grok sessions list` + 对得上的 `farssh-grok-*`。Codex：扫 `~/.codex/sessions/**/*.jsonl`。Claude：`~/.claude/projects/**/*.jsonl`。Pi：`~/.pi/agent/sessions/`。live 行可一键 attach |
| 7 | 四家启动命令 | 5, 6 | 一张命令表：new / resume / attach | 四家凡远程已安装即可：新建进入原生 TUI；resume 带上 id；live attach 画面还在。未安装的不出现在可启动列表 |
| 8 | 管理 TUI | 3, 6, 7 | ratatui：Host → Agent（版本）→ Sessions → 回车进入透传 | 键盘走完主路径；透传结束（detach 或 agent 退出）回到会话列表并刷新 live 状态 |
| 9 | 终端保真：TERM、truecolor、鼠标、doctor | 4, 8 | tmux 最小配置；`farssh doctor --host X` | Grok 或 Claude 全屏不乱码、鼠标点选在至少一种本机终端（iTerm2/Ghostty/Windows Terminal 任选）可用。doctor 检查 SSH、tmux、agent、`tmux show -g terminal-features` / mouse |
| 10 | 端到端手测记录 | 8, 9 | README 或 `plans/` 里勾选清单 | 至少 1 台 Linux 或 macOS 远程：Grok 或 Claude 跑通新建、权限操作、detach、断 SSH 再 attach。第二家 agent 若已安装则同样跑通。Windows 仅 WSL 或标明未测 |

建议顺序：1 → 2 → 3 → 4 → 5 → 7（先一家 agent）→ 8 → 6 补全四家列表 → 7 补全四家 → 9 → 10。

**先打通的 agent：** 远程哪家已登录就先用哪家；开发机默认优先 Grok（本环境资料最多），没有 grok 就用 `claude`。

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 非交互 SSH 找不到 nvm/Homebrew | 误报未安装、tmux 里 command not found | 探测与 tmux 启动都用登录壳；doctor 打印远程 `command -v` 与 `PATH` |
| 透传花屏 / 无鼠标 / 无 truecolor | 「不像本地」 | 继承 `TERM`/`COLORTERM`；工具自带最小 tmux conf（mouse、RGB）；Grok 用 `/doctor`；文档写推荐终端 |
| tmux 默认前缀与 agent 快捷键冲突 | 误 detach 或按键被吞 | 最小 conf 可设 prefix 为 `C-g`（少占用）；状态行提示；不改用户全局 tmux.conf |
| Codex 断线后误 resume 双开 | 两个 agent 改同一仓库 | live 只 attach；只有 `tmux has-session` 为假才 `codex resume`（openai/codex#30424） |
| `ssh -t` 从 ratatui 手里抢 tty 失败 | 花屏、卡死 | 进入透传前 `disable_raw_mode` + 退 alt-screen；结束后再启用；用 `Command::status` 等子进程，不要在 raw mode 下 spawn |
| 窗口 resize | agent TUI 布局错 | 本机 tty 的 SIGWINCH 由 OpenSSH 转给远程 PTY；测一次拉窗口 |
| macOS 远程 TCC | Codex/Claude 读 Documents 失败 | doctor 提示给 sshd 完全磁盘访问 |
| ControlMaster 僵死 | 后续 exec 挂 | socket 放 `~/.farssh/cm/`；超时 `-O exit` 重建 |
| 把透传理解成还要做统一聊天 UI | 范围膨胀 | README 写清：v1 是 session picker + ssh/tmux attach |

## 8. 验证方式

**自动：**

- `ssh` 参数拼装：stub `ssh` 断言出现 `-o BatchMode=yes`、ControlMaster、`-tt`
- 探测 JSON fixtures（四家全有 / 全无 / 只有一家）
- tmux 命名与 live 判定纯函数测试
- 启动命令表：给定 agent+id+cwd → 精确 argv

**手工（必做）：**

1. 本机 `ssh <host> true` 已通；远程有 tmux 和至少一家已登录 agent
2. `farssh` → 选 host → 看到版本
3. 新建会话，原生 TUI 出现；做一个只读任务
4. 触发一次写文件/bash 权限，在 **远程原生 UI** 里允许或拒绝，行为与本地一致
5. `C-g d`（或文档写明的 prefix）detach，回到会话列表，该行是 live
6. 杀掉本机进程（模拟合盖），再打开同一条：画面还在，远程 `pgrep` 仍是原来的 pid（或同一 tmux pane，不是新 resume）
7. 未安装的 agent 显示 not installed；无 tmux 时不能进入透传

## 9. 下一步（第一个动作）

- 动作：任务 1 骨架 + 任务 2 最小切片（真实 Host 上 `exec("uname -s")` + ControlMaster）。紧接着任务 4：对远程临时 tmux 透传 `top`，验证 detach 回到进程。不要先做协议层或聊天 UI。
- 时间 / 负责人：执行本计划的人，第一个工作块。

## 10. 信息来源

- 访谈（2026-09-12）：SSH 直连、tmux 保活、Linux/macOS + Windows/WSL、会话 list/new/resume/reattach、远程可启 tmux 不装软件、Rust+系统 OpenSSH、否决网关；**后改为 PTY 透传以便落地**
- Claude Code 会话与磁盘：<https://code.claude.com/docs/en/sessions.md> ；`~/.claude/projects/<slug>/<uuid>.jsonl`
- Codex resume / 双 agent：<https://developers.openai.com/codex/cli/features> ；<https://github.com/openai/codex/issues/30424> ；会话 `~/.codex/sessions/YYYY/MM/DD/`
- Grok：`grok --resume`、`grok sessions list`、`~/.grok/active_sessions.json`；tmux/SSH：本地 `21-terminal-support.md`（truecolor、mouse、OSC 52、`grok wrap ssh`）
- Pi：`pi --version`、`pi -c` / `--session`、`~/.pi/agent/sessions/`；<https://pi.dev/docs>
- OpenClaw Gateway（否决）：<https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md>
- 透传对照：Herdr、Claude Code Studio（SSH + tmux + 真 PTY）

# 用户手册

[English](../en/user-guide.md) · **中文**

**FarAgent**（命令 `faragent`）是一个跑在你笔记本上的终端应用。它 SSH 进你已经在用的那台机器，找出 Claude Code / Codex / Grok Build / Pi，然后把终端 **透传** 给它们的原生 TUI。大模型请求使用 **远程** 上的登录态和配置。

**只要能 SSH 上去就能用，包括那些不让你装任何东西的机器。** 远程不装我们任何东西：没有 faragent 二进制、没有常驻服务、不需要 Python。远程只用 `bash`、`find`、`tmux`，外加首次启动会话时写入的 `~/.faragent/tmux.conf`。全部占用就这些。

远程可以是 Linux、macOS、WSL2，也可以是 **原生 Windows 11**（Win32 OpenSSH、默认 cmd 外壳、不用 WSL）。Windows 上没有 tmux，会话行为不一样——动手前先读 [SSH 连接 · Windows 远程](ssh-access.md#windows-远程原生)。

目录：

- [需要什么](#需要什么)
- [开发者模式](#开发者模式)
- [打包二进制并在本机使用](#打包二进制并在本机使用)
- [把成品迁到另一台电脑](#把成品迁到另一台电脑)
- [配置 SSH](#配置-ssh)
- [SSH 怎么连（局域网 / 公网 / 域名 / Tailscale）](ssh-access.md)
- [界面语言](#界面语言)
- [日常用法](#日常用法)
- [安装、升级、卸载](#安装升级卸载)
- [不用 TUI 的命令](#不用-tui-的命令)
- [四家 agent](#四家-agent)
- [断开与重连](#断开与重连)
- [排障](#排障)

## 需要什么

### 本机（你打开 faragent 的那台）

- macOS、Linux，或 **Windows 11**
- OpenSSH（`ssh`）—— Windows 自带（可选功能「OpenSSH 客户端」）
- `~/.ssh/config` 里有具体的 `Host`（见下文）
- **能连上这台机器**：默认用密钥或 ssh-agent 免密（`BatchMode`）；服务端只让用账号密码时，macOS/Linux 支持交互式登录一次（密码不落盘），Windows 由 TUI 自己询问并只在本次运行的进程内存里保留，见 [SSH 连接 · 服务端只让用密码](ssh-access.md#服务端只让用密码可选) 与 [Windows 客户端说明](ssh-access.md#windows-客户端说明)
- 本机能真正 SSH 到远程：同一局域网、公网 IP/域名，或 [Tailscale](ssh-access.md)（家宽 NAT / 出门连家用机器时推荐）

### 远程（agent 真正跑的那台）

| 需要 | 说明 |
| --- | --- |
| `sshd` | 普通 SSH 服务 —— Windows 11 上就是 Win32 OpenSSH |
| `bash`（Linux/macOS） | 登录壳；faragent 用 `bash -lc` 探测 |
| `tmux`（Linux/macOS） | attach 需要。缺失时 FarAgent 可用 brew，或 sudo + apt/dnf/yum/pacman/apk 代装 |
| 至少一个 agent | 登录壳 PATH 上能找到 `claude` / `codex` / `grok` / `pi`。未安装可从 TUI 代装 |
| agent 已登录 | faragent 不代做 OAuth |

**Windows 远程（原生）：** Windows 11 装 Win32 OpenSSH（可选功能里的 `sshd`，防火墙放行 22 端口），保持默认的 **cmd** 外壳。Windows 上没有 tmux：会话**前台运行**——退出 agent（或断开连接）即结束，下次回车经 `claude --resume` / `codex resume` 恢复上下文。疑似已在别处运行的会话会标 `[running]` 并先询问（[codex#30424](https://github.com/openai/codex/issues/30424)）。WSL2 也仍然支持——它就是一台 Linux 主机。安装步骤见 [SSH 连接 · Windows 远程](ssh-access.md#windows-远程原生)。

可在 TUI 里代装 agent（Linux/macOS 用官方 `curl | bash` 装到用户目录、不用 sudo；Windows 用官方 PowerShell 安装器、也不用管理员），也可自己在远程安装，然后在那台机器上登录（例如 `grok login`）。

本机不拷 API key。探测和列会话在本机 Rust 里完成；远程跑 bash、tmux，以及你确认过的官方安装器。

下面三种用法对应三种身份：**改代码**、**本机当成品用**、**拷到另一台电脑用**。远程那台装 agent 的机器不需要 Rust，也不需要这份源码。

## 开发者模式

适合在仓库里改代码、跑测试、随时启动最新 TUI。本机需要 **Rust 1.80+** 和 Git。

### 拉代码并编译

```bash
# 若还没有 rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

git clone https://github.com/mahingbun-dev/FarAgent.git
cd FarAgent
cargo build
```

调试版二进制在 `target/debug/faragent`。

### 日常命令

`cargo run` 会先编译再执行。子命令前面要加 `--`，否则会被 cargo 吃掉：

```bash
cargo test
cargo fmt
cargo run -- --help
cargo run -- --version
cargo run                          # 打开 TUI
cargo run -- doctor
cargo run -- doctor --host home-mac
cargo run -- probe --host home-mac
cargo run -- sessions --host home-mac --agent grok
```

也可以直接跑编好的文件：

```bash
./target/debug/faragent
./target/debug/faragent doctor --host home-mac
```

排错时：

```bash
RUST_BACKTRACE=1 cargo run -- doctor --host home-mac
```

改 `src/` 后重新 `cargo build` 或 `cargo run` 即可。本机用 `bash -lc` 跟远程说话，没有要同步的助手脚本。

开发版带调试符号，比发布版慢，日常当产品用请走下一节的 **release** 包。

改架构、加 agent 的说明见 [开发者文档](development.md)。

## 打包二进制并在本机使用

不改代码、只想在这台电脑上稳定使用时，打 **release** 包。仍然只在本机需要 Rust；用完可以卸掉工具链，只留二进制。

### 编译发布版

在仓库根目录：

```bash
cd FarAgent
cargo build --release
./target/release/faragent --help
./target/release/faragent --version
```

产物是单个可执行文件：

| 系统 | 路径 |
| --- | --- |
| macOS / Linux | `target/release/faragent` |

确认本机已有 `ssh`（`command -v ssh`）。faragent **不把 OpenSSH 打进包里**，目标电脑也必须自带 `ssh`。

### 装进 PATH（推荐）

```bash
cargo install --path .
```

默认安装到 `~/.cargo/bin/faragent`。若终端里找不到命令：

```bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc   # 或 ~/.bashrc
source ~/.zshrc
which faragent
faragent --help
```

升级（在仓库里拉最新代码后再装）：

```bash
git pull
cargo install --path . --force
```

卸载：

```bash
cargo uninstall faragent
# 或：rm ~/.cargo/bin/faragent
```

### 不装 PATH，只跑文件

```bash
./target/release/faragent
/绝对路径/faragent doctor --host home-mac
```

本机使用前仍需 [配置 SSH](#配置-ssh)，并保证 `ssh <Host> true` 免密成功。

## 把成品迁到另一台电脑

发布版是 **一个二进制**。另一台电脑 **不必安装 Rust、不必拷源码**。要拷的是 `faragent` 文件，以及那台电脑自己的 SSH 配置和密钥。

远程开发机（装着 claude/codex/grok/pi 的那台）不用搬；新笔记本只要能 SSH 上去即可。

### 1. 在原电脑打好包

```bash
cd FarAgent
cargo build --release
uname -m          # arm64 或 x86_64，迁入机器必须同类
file target/release/faragent
```

| 原电脑 | 迁入电脑必须 |
| --- | --- |
| Apple Silicon Mac（`arm64`） | 也是 Apple Silicon |
| Intel Mac（`x86_64`） | 也是 Intel Mac |
| Linux x86_64 | 也是 Linux x86_64（glibc 不宜过旧） |

二进制**不能**跨系统或跨架构（macOS ≠ Linux ≠ Windows；`arm64` ≠ `x86_64`）——拷对应平台的产物，或在目标机器上 `cargo install --path .`。

### 2. 拷走什么、不要拷什么

**拷：**

- `target/release/faragent`（可改名，执行权限保留）

**不要拷进「成品包」里：**

- 整个仓库、`target/debug/`、`Cargo.lock` 以外的构建缓存
- `~/.ssh/` 私钥（用 U 盘或密码管理器单独、安全地迁移密钥，不要和二进制捆在一起发人）
- 远程机器上的 `~/.faragent/`、agent 会话、API key（那些必须留在远程）

可用 U 盘、AirDrop、或 `scp`：

```bash
scp target/release/faragent 另一台:~/bin/faragent
```

### 3. 在新电脑上落地

新电脑需要：macOS 或 Linux、系统 `ssh`、能免密登录远程的密钥、`~/.ssh/config` 里的具体 `Host`。

```bash
chmod +x faragent
./faragent --help
./faragent --version
```

放到 PATH，例如：

```bash
mkdir -p ~/.local/bin
mv faragent ~/.local/bin/
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
faragent doctor
```

然后在新电脑写好 `~/.ssh/config`（Host 别名可以和旧电脑一样，方便沿用习惯），确认：

```bash
ssh home-mac true
faragent doctor --host home-mac
faragent
```

第一次从新电脑开会话时，仍会在 **远程** 写入 `~/.faragent/tmux.conf`。本机会创建 `~/.faragent/cm/` 存放 SSH ControlMaster 套接字，这是空目录，不用从旧电脑拷。

### 4. 迁完后怎么用

和本机打包后的用法相同：`faragent` 打开 TUI，或 `faragent doctor --host …`。不需要 `cargo`。源码和 Rust 可以只留在你用来开发的那台机器上。

## 配置 SSH

选择器只列出 **非通配** 的 `Host`。`Host *`、`Host *.github.com` 这类会被跳过。

`HostName` 可以是局域网 IP、公网 IP、域名，或 Tailscale 的 `100.x` / MagicDNS 名。FarAgent 不自己做穿透：**判定标准就是 `ssh <Host> true` 能不能通**（默认密钥，服务端只给密码时用密码模式）。逐步说明（含家里 NAT、CGNAT、Tailscale 教程、密码登录、报错对照表）见 **[SSH 连接：局域网、公网 IP、域名、Tailscale](ssh-access.md)**。

```ssh-config
Host home-mac
    HostName 192.168.1.8
    User alex
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

Host gpu-box
    HostName gpu.example.com
    User coder
```

打开 TUI 之前先确认：

```bash
ssh home-mac true
faragent doctor
faragent doctor --host home-mac
```

不带 `--host` 的 `doctor` 列出能识别的别名。带上之后会打印远程 `PATH`、tmux 和各 agent 版本。

若 SSH 进去能跑 `grok`，但 doctor 显示未安装：多半是登录壳 PATH（nvm、Homebrew、`~/.local/bin`）。faragent 一律用 `bash -lc` 探测。

## 界面语言

第一次打开 TUI 会先问 **中文** 还是 **English**。选定后写入本机 `~/.faragent/config.json`，以后不再询问。

```json
{
  "language": "zh"
}
```

`zh` 或 `en`。换语言：主机列表按 `L`，或直接改这个文件。这只影响本机界面，不影响远程 agent。

## 日常用法

```bash
faragent
```

| 界面 | 做什么 |
| --- | --- |
| **语言** | 仅首次（或按 `L`）：选中文 / English |
| **Hosts** | 选 Host，回车探测 |
| **Agents** | 已安装显示版本；未安装显示「未安装 · 回车安装」 |
| **确认屏** | 列出安装/升级/卸载的完整命令。回车后 SSH PTY 直播 |
| **Sessions** | `[live]` 是还在跑的 tmux；`[idle]` 是磁盘上的历史会话 |
| **新建会话** | 按 `n`，从最近目录 / `..` / 子目录里选（回车进入，`s` 启动）。不存在时问你是否创建 |

管理界面快捷键：

| 键 | 作用 |
| --- | --- |
| `j` / `k` 或方向键 | 移动 |
| Enter | 探测 / 进入 / attach；agent 或 tmux 缺失时进入 **安装** |
| `g` | 切换该主机的登录方式：`auto` → `key` → `password`（主机列表） |
| `G` | 把本机 `gh` 登录同步到该主机（主机列表；会先确认） |
| `U` | 升级当前 agent（助手列表） |
| `X` | 卸载当前 agent 的 CLI（保留 `~/.claude` 等配置） |
| `n` | 新建会话 |
| `p` | 切换完全权限 / 需确认（会话列表、新建会话；写入 `~/.faragent/config.json`） |
| `r` | 刷新 |
| `L` | 重新选择界面语言 |
| `?` | 短帮助 |
| `q` 或 Esc | 返回 / 退出 |
| `Ctrl-c` | 退出 |

主机列表里每台机器后面会标出登录方式：`[仅密钥]` / `[密码登录]`，没标就是默认 `auto`。

连不上时 FarAgent 会切到 **报错页**，上面列出「ssh 原始输出 + 原因 + 可复制的修复命令」：

| 键 | 作用 |
| --- | --- |
| `j` / `k`、`PgUp` / `PgDn` | 滚动报错页 |
| `a` | 密码主机：macOS/Linux 走交互式登录一次（密码只给系统 ssh，不保存）；Windows 弹内存密码输入 |
| `r` | 修好之后重试刚才那步 |
| `y` | 把「结论 + 原始报错 + 处理步骤」整段复制到剪贴板 |
| `Esc` / `q` | 返回上一层 |

完整的「原始报错 → 原因 → 解决」对照表见 [SSH 连接](ssh-access.md#连不上时原始报错--原因--解决)。

进入 agent 全屏之后：

| 键 | 作用 |
| --- | --- |
| **`Ctrl-g` 再按 `d`** | detach。远程 agent **继续跑**，回到会话列表 |
| agent 自己的退出（如 `/quit`） | agent 结束，tmux 会话消失，该行变为 idle |

tmux 前缀是 **`Ctrl-g`**，不是默认的 `Ctrl-b`，减少和 agent 抢键。这只作用于独立 socket `faragent`，不会改你日常的 tmux。

### live 和 idle

- **live**：tmux 里还有这个会话。faragent **只 attach**，不会再执行 `codex resume` / `claude --resume`，以免两个 agent 同时改一个仓库。
- **idle**：没有 tmux 窗格。faragent 用该 agent 的 resume 命令在对应目录拉起新窗格。

### 新建会话

1. 进入某个 agent 的会话列表
2. 按 `n`
3. 上方仍是 `cwd>`，可直接改路径（`~` 按远程家目录展开）。下方列出 **最近用过的工作目录**（当前会话列表里去重后的 `cwd`）、`..`、以及当前路径的子目录
4. `j` / `k` 在列表里移动；**回车进入** 选中的最近目录 / `..` / 子目录（只刷新列表，不启动）
5. **`s` 在当前 `cwd>` 启动**（以前回车启动的行为改到了 `s`）。Tab 按当前输入重新列目录
6. 目录已存在 → 登录壳里启动 `claude` / `codex` / `grok` / `pi`
7. 目录不存在 → 会切到确认屏，**显示将要执行的 `mkdir -p`**；回车创建并开始，Esc 返回改路径

列目录**不会**创建文件夹。只有确认屏上按了回车，FarAgent 才会 `mkdir -p`。

`p` 切换 **完全权限**（默认开：Claude `bypassPermissions`、Codex `--dangerously-bypass-approvals-and-sandbox`、Grok `--always-approve`；Pi 不变）和 **需确认**。只作用于新会话和 idle 恢复；已经在跑的 tmux 窗格只 attach，不会带这些 flag 再 exec 一遍。

### 同步 GitHub 登录

在主机列表按 **`G`**（小写 `g` 仍是切换 SSH 登录方式）。确认后 FarAgent 用本机 `gh auth token` 写入远程 `~/.config/gh/hosts.yml`（0600），必要时生成 ed25519 密钥并把公钥登记到 GitHub（标题 `faragent-<host>`），再把远程 `https://github.com/` 改写成 `git@github.com:`。本机未登录时请先在这台电脑运行 `gh auth login`。**界面和日志里都不会出现 token。**

命令行等价：`faragent github-sync --host <alias>`。

## 安装、升级、卸载

在已探测主机的 **助手列表**：

| 情况 | 行为 |
| --- | --- |
| agent 未安装 | 回车打开确认屏，直播安装该 agent |
| agent 已装、缺 tmux | 回车只规划安装 tmux |
| agent 和 tmux 都在 | 回车进入会话列表（和以前一样） |
| `U` | 升级该 agent（未安装则改为安装） |
| `X` | 只卸载该 agent 的 CLI |

确认屏列出将要执行的每条命令。回车把本机 tty 交给 `ssh -tt`，你能看到安装器输出，需要时输入 sudo 密码。远程命令结束后回到助手列表并重新探测。 **不代登录，不自动开会话。**

FarAgent 会跑的命令写死在本机（远程不能指定脚本）：

| 软件 | 安装 | 说明 |
| --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | 升级：`claude update`（失败则重跑安装器） |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | 升级即重跑安装器 |
| Grok Build | `curl -fsSL https://x.ai/cli/install.sh \| bash` | 升级：`grok update` |
| Pi | `curl -fsSL https://pi.dev/install.sh \| sh` | 没有 Node 时先装 nvm + LTS |
| tmux / curl | `brew install …` 或 `sudo apt-get` / `dnf` / `yum` / `pacman` / `apk` | 只认这些包管理器，不猜 synopkg/Entware |
| Node（Pi） | nvm 官方脚本，然后 `nvm install --lts` | 用户目录，不用 sudo |

卸载只删 CLI（`claude uninstall` / 删二进制 / `npm uninstall -g` / `brew uninstall`），**保留** `~/.claude`、`~/.codex`、`~/.grok`、`~/.pi` 和密钥。若还有 live tmux，确认屏会警告，但仍允许继续。

没有 curl 也没有已知包管理器时，确认屏不可执行，并给出可复制命令。没有 tmux 仍可装 agent；要进会话则必须先有 tmux。

## 不用 TUI 的命令

```bash
faragent
faragent tui
faragent doctor
faragent doctor --host home-mac
faragent probe --host home-mac
faragent sessions --host home-mac --agent grok
faragent auth --host home-mac                  # 看该主机的登录方式
faragent auth --host home-mac --mode password  # auto | key | password
faragent login --host home-mac                 # 交互式登录一次（密码/指纹），之后复用
faragent github-sync --host home-mac           # 把本机 gh 登录写到远程
```

`probe` 和 `sessions` 输出 JSON。agent 名：`claude`、`codex`、`grok`、`pi`。连不上时这些命令会打印和 TUI 相同的报错说明并以非零码退出。

## 四家 agent

| 产品 | 命令 | 新建 | 恢复 idle | 会话位置 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `claude --resume <id>` | `~/.claude/projects/**/*.jsonl` |
| Codex | `codex` | `codex` | `codex resume <id>` | `~/.codex/sessions/**/*.jsonl` |
| Grok Build | `grok` | `grok` | `grok --resume <id>` | `~/.grok/sessions/<编码后的cwd>/<id>/` |
| Pi | `pi` | `pi` | `pi --session <id>` | `~/.pi/agent/sessions/` |

凭证只在远程检查是否存在，不会拷到本机。原生 TUI 若要求登录，请在 **那台远程** 上完成。

### 对话视图

在应用里，会话打开时显示的是对话——内容读自该 agent 写在远端的会话记录——终端只隔一次点击；当读不出对话时，会话就打开在终端上。四家 agent 都有这个视图。

有两件事值得知道，它们都不是缺陷：

- **刚在 Codex 或 Pi 上开的会话，打开的是终端而不是对话。** `claude` 和 `grok` 可以被告知用哪个 session id，所以应用在 agent 还没写入文件之前就知道文件在哪。`codex` 和 `pi` 自己挑 id 且不告诉你，因此在会话列表扫描远端、找到那个文件之前，路径无从得知。从列表里重新打开这个会话，对话就在了。
- **四家里，Pi 的对话视图是证据最弱的一个。** 它的适配器是照 Pi 自己的格式文档写的，而不是照真实会话文件——开发时拿不到 Pi 样例。如果 Pi 的对话渲染得不对，那是最该先看的地方。

这个视图读的就是终端会话写的那份记录文件；它自己不产生网络请求，也不回传任何东西。

## 断开与重连

1. `Ctrl-g d`：正常 detach，回到管理界面
2. 杀掉本机进程或断网：远程 tmux **还在**
3. 再开 `faragent`，同一 Host + agent，选 `[live]` 即可

不要在 live 时另外 SSH 进去对同一 id 再 `resume`。

## 终端效果

通过 `ssh -tt` 转发 `TERM` / `COLORTERM`。独立 tmux 配置打开鼠标、truecolor、OSC 52 剪贴板。

推荐 Ghostty、iTerm2、Kitty、WezTerm，Windows 11 上用 Windows Terminal（官方支持）。窗口缩放由 OpenSSH 转发 `SIGWINCH`。

## 安全

- 使用系统 OpenSSH，密钥留在 ssh-agent / `IdentityFile`
- 远程助手写在你 SSH 的那个用户的 `~/.faragent/`
- tmux 用私有 socket（`-L faragent`），不监听 TCP
- 不把 API key 写到笔记本
- agent 安装器是官方 `curl | bash`，确认屏展示，装到用户目录，不用 sudo
- tmux / curl 可以用 sudo + brew/apt/dnf/yum/pacman/apk。不猜 NAS 包管理器

能 SSH 进这台机器，就等于能用这个用户的 agent 和代码。按这个标准保护 SSH。

## 排障

| 现象 | 处理 |
| --- | --- |
| Host 列表是空的 | 在 `~/.ssh/config` 加非通配 `Host` |
| `Permission denied (publickey)` | 公钥没配好：见 [报错对照表](ssh-access.md#连不上时原始报错--原因--解决)；改完按 `r` 重试 |
| `Permission denied (publickey,password)` | 服务端只认密码：`faragent auth --host X --mode password`，再 `faragent login --host X`（或 TUI 报错页按 `a`） |
| 反复要密码 / 每次都弹指纹 | 先 `faragent login --host X` 做一次，之后走多路复用连接就不问了 |
| 想改用/退出密码模式 | `faragent auth --host X --mode key`（只用密钥）或 `--mode auto`（默认） |
| 咖啡馆连不上家里的 `192.168.x` | 那是局域网地址，出不了你家。改用 [Tailscale](ssh-access.md#用-tailscale-做内网穿透推荐) 或公网 IP / 域名 |
| 显示未安装但 SSH 里能跑 | 检查登录 PATH；看 `faragent doctor --host X` |
| `tmux_missing` | 在助手列表回车代装 tmux，或从确认屏复制命令 |
| `cwd_missing` | 工作目录不存在：确认屏回车创建，或 Esc 改路径 |
| `mkdir_failed` | 远程创建目录失败（权限 / 只读挂载）；红字里是 mkdir 的原始输出 |
| 探测失败切到报错页 | 页面上有 ssh 原始报错和处理步骤；`a` 交互式登录、`r` 重试、`y` 复制全文、`Esc` 返回 |
| 探测失败提到 bash / FARAGENT_PROBE | 远程需要 bash；`ssh host -- bash -lc 'echo ok'` |
| 花屏 | 换 truecolor 终端；缩放后重新 attach |
| 两个 agent 改同一仓库 | live 时不要手动 resume |
| macOS 远程读不了文稿/桌面 | 给 sshd 完全磁盘访问权限（TCC） |
| ControlMaster 僵住 | `ssh -O exit -o ControlPath=~/.faragent/cm/%r@%h:%p host` |

## FarAgent 明确不做

删除/重命名/fork 会话、把远程密钥或密码拷到本机、源码编译 tmux、Entware/synopkg、在 Windows 远程上保活会话（tmux 等价的会话托管已列入计划）。

Windows 会话托管（不用 WSL 的保活）与 App 前端样式已列入 [后续计划](roadmap.md)。

## 另见

- [SSH 连接：局域网、公网 IP、域名、Tailscale](ssh-access.md)
- [开发者文档](development.md)
- [后续计划](roadmap.md) — Windows 会话托管与 App 前端样式

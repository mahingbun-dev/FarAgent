# 用户手册

[English](../en/user-guide.md) · **中文**

`everywhere` 是一个跑在你笔记本上的终端应用。它 SSH 进你已经在用的那台机器，找出 Claude Code / Codex / Grok Build / Pi，然后把终端 **透传** 给它们的原生 TUI。大模型请求使用 **远程** 上的登录态和配置。

目录：

- [需要什么](#需要什么)
- [开发者模式](#开发者模式)
- [打包二进制并在本机使用](#打包二进制并在本机使用)
- [把成品迁到另一台电脑](#把成品迁到另一台电脑)
- [配置 SSH](#配置-ssh)
- [日常用法](#日常用法)
- [不用 TUI 的命令](#不用-tui-的命令)
- [四家 agent](#四家-agent)
- [断开与重连](#断开与重连)
- [排障](#排障)

## 需要什么

### 本机（你打开 everywhere 的那台）

- macOS 或 Linux（暂不支持把 Windows 当作客户端）
- OpenSSH（`ssh`）
- `~/.ssh/config` 里有具体的 `Host`（见下文）
- **密钥或 ssh-agent 免密**。v0.1 不支持密码、OTP、跳板机

### 远程（agent 真正跑的那台）

| 需要 | 说明 |
| --- | --- |
| `sshd` | 普通 SSH 服务 |
| `tmux` | everywhere **不会替你安装** |
| `python3` | 探测和列会话 |
| 至少一个 agent | 登录壳 PATH 上能找到 `claude` / `codex` / `grok` / `pi` |
| agent 已登录 | everywhere 不代做 OAuth |

**Windows 远程（v0.1）：** SSH 进 **WSL2** 里的 sshd。原生 Win32 OpenSSH 见 [后续计划](roadmap.md)。

请用各家官方方式在远程安装并登录 agent（例如远程执行 `grok login --device-auth`）。

远程不会被安装任何系统软件。第一次探测时会在远程用户目录写下 `~/.everywhere/`（tmux 配置和 `remote.py` 助手）。

下面三种用法对应三种身份：**改代码**、**本机当成品用**、**拷到另一台电脑用**。远程那台装 agent 的机器不需要 Rust，也不需要这份源码。

## 开发者模式

适合在仓库里改代码、跑测试、随时启动最新 TUI。本机需要 **Rust 1.80+** 和 Git。

### 拉代码并编译

```bash
# 若还没有 rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

git clone https://github.com/mahingbun-dev/everywhere-to-agent.git
cd everywhere-to-agent
cargo build
```

调试版二进制在 `target/debug/everywhere`。

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
./target/debug/everywhere
./target/debug/everywhere doctor --host home-mac
```

排错时：

```bash
RUST_BACKTRACE=1 cargo run -- doctor --host home-mac
```

改 `src/` 或 `src/remote.py` 后重新 `cargo build` 或 `cargo run` 即可。`remote.py` 嵌在二进制里，下次探测远程时若 hash 变了会自动覆盖远程的 `~/.everywhere/remote.py`。

开发版带调试符号，比发布版慢，日常当产品用请走下一节的 **release** 包。

改架构、加 agent 的说明见 [开发者文档](development.md)。

## 打包二进制并在本机使用

不改代码、只想在这台电脑上稳定使用时，打 **release** 包。仍然只在本机需要 Rust；用完可以卸掉工具链，只留二进制。

### 编译发布版

在仓库根目录：

```bash
cd everywhere-to-agent
cargo build --release
./target/release/everywhere --help
./target/release/everywhere --version
```

产物是单个可执行文件：

| 系统 | 路径 |
| --- | --- |
| macOS / Linux | `target/release/everywhere` |

确认本机已有 `ssh`（`command -v ssh`）。everywhere **不把 OpenSSH 打进包里**，目标电脑也必须自带 `ssh`。

### 装进 PATH（推荐）

```bash
cargo install --path .
```

默认安装到 `~/.cargo/bin/everywhere`。若终端里找不到命令：

```bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc   # 或 ~/.bashrc
source ~/.zshrc
which everywhere
everywhere --help
```

升级（在仓库里拉最新代码后再装）：

```bash
git pull
cargo install --path . --force
```

卸载：

```bash
cargo uninstall everywhere
# 或：rm ~/.cargo/bin/everywhere
```

### 不装 PATH，只跑文件

```bash
./target/release/everywhere
/绝对路径/everywhere doctor --host home-mac
```

本机使用前仍需 [配置 SSH](#配置-ssh)，并保证 `ssh <Host> true` 免密成功。

## 把成品迁到另一台电脑

发布版是 **一个二进制**。另一台电脑 **不必安装 Rust、不必拷源码**。要拷的是 `everywhere` 文件，以及那台电脑自己的 SSH 配置和密钥。

远程开发机（装着 claude/codex/grok/pi 的那台）不用搬；新笔记本只要能 SSH 上去即可。

### 1. 在原电脑打好包

```bash
cd everywhere-to-agent
cargo build --release
uname -m          # arm64 或 x86_64，迁入机器必须同类
file target/release/everywhere
```

| 原电脑 | 迁入电脑必须 |
| --- | --- |
| Apple Silicon Mac（`arm64`） | 也是 Apple Silicon |
| Intel Mac（`x86_64`） | 也是 Intel Mac |
| Linux x86_64 | 也是 Linux x86_64（glibc 不宜过旧） |

v0.1 **不能**把 macOS 二进制拿到 Linux 上跑，也还不能当 Windows 客户端（见 [后续计划](roadmap.md)）。

### 2. 拷走什么、不要拷什么

**拷：**

- `target/release/everywhere`（可改名，执行权限保留）

**不要拷进「成品包」里：**

- 整个仓库、`target/debug/`、`Cargo.lock` 以外的构建缓存
- `~/.ssh/` 私钥（用 U 盘或密码管理器单独、安全地迁移密钥，不要和二进制捆在一起发人）
- 远程机器上的 `~/.everywhere/`、agent 会话、API key（那些必须留在远程）

可用 U 盘、AirDrop、或 `scp`：

```bash
scp target/release/everywhere 另一台:~/bin/everywhere
```

### 3. 在新电脑上落地

新电脑需要：macOS 或 Linux、系统 `ssh`、能免密登录远程的密钥、`~/.ssh/config` 里的具体 `Host`。

```bash
chmod +x everywhere
./everywhere --help
./everywhere --version
```

放到 PATH，例如：

```bash
mkdir -p ~/.local/bin
mv everywhere ~/.local/bin/
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
everywhere doctor
```

然后在新电脑写好 `~/.ssh/config`（Host 别名可以和旧电脑一样，方便沿用习惯），确认：

```bash
ssh home-mac true
everywhere doctor --host home-mac
everywhere
```

第一次从新电脑探测某台远程时，仍会在 **远程** 写入 `~/.everywhere/`（若以前用过 everywhere，助手会按 hash 更新）。本机会创建 `~/.everywhere/cm/` 存放 SSH ControlMaster 套接字，这是空目录，不用从旧电脑拷。

### 4. 迁完后怎么用

和本机打包后的用法相同：`everywhere` 打开 TUI，或 `everywhere doctor --host …`。不需要 `cargo`。源码和 Rust 可以只留在你用来开发的那台机器上。

## 配置 SSH

选择器只列出 **非通配** 的 `Host`。`Host *`、`Host *.github.com` 这类会被跳过。

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
everywhere doctor
everywhere doctor --host home-mac
```

不带 `--host` 的 `doctor` 列出能识别的别名。带上之后会打印远程 `PATH`、tmux 和各 agent 版本。

若 SSH 进去能跑 `grok`，但 doctor 显示未安装：多半是登录壳 PATH（nvm、Homebrew、`~/.local/bin`）。everywhere 一律用 `bash -lc` 探测。

## 日常用法

```bash
everywhere
```

| 界面 | 做什么 |
| --- | --- |
| **Hosts** | 选 Host，回车探测 |
| **Agents** | 已安装的显示版本，否则 `not installed` |
| **Sessions** | `[live]` 是还在跑的 tmux；`[idle]` 是磁盘上的历史会话 |
| **New cwd** | 按 `n`，输入远程已存在的目录，回车开新会话 |

管理界面快捷键：

| 键 | 作用 |
| --- | --- |
| `j` / `k` 或方向键 | 移动 |
| Enter | 探测 / 进入 / attach 或 resume |
| `n` | 新建会话 |
| `r` | 刷新 |
| `?` | 短帮助 |
| `q` 或 Esc | 返回 / 退出 |
| `Ctrl-c` | 退出 |

进入 agent 全屏之后：

| 键 | 作用 |
| --- | --- |
| **`Ctrl-g` 再按 `d`** | detach。远程 agent **继续跑**，回到会话列表 |
| agent 自己的退出（如 `/quit`） | agent 结束，tmux 会话消失，该行变为 idle |

tmux 前缀是 **`Ctrl-g`**，不是默认的 `Ctrl-b`，减少和 agent 抢键。这只作用于独立 socket `everywhere`，不会改你日常的 tmux。

### live 和 idle

- **live**：tmux 里还有这个会话。everywhere **只 attach**，不会再执行 `codex resume` / `claude --resume`，以免两个 agent 同时改一个仓库。
- **idle**：没有 tmux 窗格。everywhere 用该 agent 的 resume 命令在对应目录拉起新窗格。

### 新建会话

1. 进入某个 agent 的会话列表
2. 按 `n`
3. 输入远程 **已经存在** 的目录（不会替你 `mkdir` 项目）
4. 回车，登录壳里启动 `claude` / `codex` / `grok` / `pi`

## 不用 TUI 的命令

```bash
everywhere
everywhere tui
everywhere doctor
everywhere doctor --host home-mac
everywhere probe --host home-mac
everywhere sessions --host home-mac --agent grok
```

`probe` 和 `sessions` 输出 JSON。agent 名：`claude`、`codex`、`grok`、`pi`。

## 四家 agent

| 产品 | 命令 | 新建 | 恢复 idle | 会话位置 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `claude --resume <id>` | `~/.claude/projects/**/*.jsonl` |
| Codex | `codex` | `codex` | `codex resume <id>` | `~/.codex/sessions/**/*.jsonl` |
| Grok Build | `grok` | `grok` | `grok --resume <id>` | `~/.grok/sessions/<编码后的cwd>/<id>/` |
| Pi | `pi` | `pi` | `pi --session <id>` | `~/.pi/agent/sessions/` |

凭证只在远程检查是否存在，不会拷到本机。原生 TUI 若要求登录，请在 **那台远程** 上完成。

## 断开与重连

1. `Ctrl-g d`：正常 detach，回到管理界面
2. 杀掉本机进程或断网：远程 tmux **还在**
3. 再开 `everywhere`，同一 Host + agent，选 `[live]` 即可

不要在 live 时另外 SSH 进去对同一 id 再 `resume`。

## 终端效果

通过 `ssh -tt` 转发 `TERM` / `COLORTERM`。独立 tmux 配置打开鼠标、truecolor、OSC 52 剪贴板。

推荐 Ghostty、iTerm2、Kitty、WezTerm 等。窗口缩放由 OpenSSH 转发 `SIGWINCH`。

## 安全

- 使用系统 OpenSSH，密钥留在 ssh-agent / `IdentityFile`
- 远程助手写在你 SSH 的那个用户的 `~/.everywhere/`
- tmux 用私有 socket（`-L everywhere`），不监听 TCP
- 不把 API key 写到笔记本
- 不在远程用包管理器装软件

能 SSH 进这台机器，就等于能用这个用户的 agent 和代码。按这个标准保护 SSH。

## 排障

| 现象 | 处理 |
| --- | --- |
| Host 列表是空的 | 在 `~/.ssh/config` 加非通配 `Host` |
| `Permission denied` / 卡在密码 | 配好密钥；BatchMode 不会出密码框 |
| 显示未安装但 SSH 里能跑 | 检查登录 PATH；看 `everywhere doctor --host X` |
| `tmux_missing` | 自己在远程安装 tmux |
| `cwd_missing` | 目录必须已存在 |
| 探测失败提到 python3 | 远程安装 Python 3 |
| 花屏 | 换 truecolor 终端；缩放后重新 attach |
| 两个 agent 改同一仓库 | live 时不要手动 resume |
| macOS 远程读不了文稿/桌面 | 给 sshd 完全磁盘访问权限（TCC） |
| ControlMaster 僵住 | `ssh -O exit -o ControlPath=~/.everywhere/cm/%r@%h:%p host` |

## v0.1 明确不做

密码 SSH、OTP、ProxyJump、代装 tmux/agent、删除/重命名/fork 会话、把远程密钥拷到本机。

Windows 原生（不使用 WSL）和 App 前端样式已列入 [后续计划](roadmap.md)。

## 另见

- [开发者文档](development.md)
- [后续计划](roadmap.md) — Windows 原生与 App 前端样式
- [计划书](../../../plans/2026-09-12-everywhere-to-agent.md)

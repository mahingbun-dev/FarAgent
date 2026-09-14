# 真机验收清单

[English](../en/acceptance.md) · **中文**

这份清单是**这个分支（应用外壳、只读面板、实时刷新、缓存、i18n 收口）中，只有在真机上才能确认的部分**。

写它的原因很直接：本分支的开发机是 macOS，工作面版（面板 / 文件树 / Git）是通过 `src/lib/mock/` 这套假后端验证的，`cargo test` 与 `node --test` 跑的是纯逻辑。下面这些条目**在开发机上无论如何都测不出来**，所以它们不是"待办"，而是"必须有人在真机器上做一次"。

> **状态标记的含义**
>
> - **未验证**：本分支没有条件跑。不要当成已通过。
> - **开发机已验（mock）**：逻辑与前端行为在假后端上是验证过的，真机要验的是"真 SSH / 真文件系统下是否一样"。

跑之前请先确认基线：

```bash
ssh -o BatchMode=yes <Host> true     # 零交互成功
cargo test -p faragent-service        # 76 项
cargo test -p faragent-app            # 17 项
cargo test -p faragent-helper         # 54 项（lib 30 + main 2 + protocol 22）
cd apps/faragent-app && npm test      # 211 项
```

---

## 1. helper 首次上传、校验、复用 —— 未验证

安装流程的三条分支（上传 / 命中 / 复用）在单测里是用 `HelperHost` 假实现驱动的，真机要确认的是**同一个 helper 二进制在真 SSH 上走完这三步**。

**怎么操作**

```bash
# 让远端处于"什么都没有"的干净状态
ssh <Host> 'rm -rf ~/.faragent'

# 第一次：远端没有 helper，应该上传
faragent <Host>            # 或桌面端里打开该主机的面板

# 第二次：远端已有同一份，应该直接复用、不再上传
ssh <Host> 'ls -l ~/.faragent/bin/faragent-helper'
faragent <Host>

# 制造"同平台但内容不同"：把远端那份改坏
ssh <Host> 'printf x >> ~/.faragent/bin/faragent-helper'
faragent <Host>            # 摘要不匹配 → 应重新上传并恢复可执行
```

**应该看到什么**

- 第一次：上传后远端出现 `~/.faragent/bin/faragent-helper`，权限可执行，紧接着能跑起来（不是 `126`）。
- 第二次：不再走上传，`HelperMode` 显示为原生模式（`HelperMode::Native`，即不做脚本降级）。
- 第三次：摘要不匹配 → 重新上传；上传后再次校验通过。

**什么算失败**

- 第二次仍然上传（每次都传几 MB，说明摘要比对没生效）。
- 上传"成功"但远端文件为空 / 权限不可执行。
- 上传后没有任何校验就宣布完成。

**怎么确认它真的复用了**：远端文件 mtime 不变即没有重写。

---

## 2. 多 MB 二进制通过 stdin 传输 —— 未验证

上传走的是 `ssh ... -- sh -c 'cat > ...'` 之类的 stdin 通道（不是 base64 参数），大文件下**参数长度、缓冲区、部分写入**都可能出问题。

**怎么操作**

```bash
ls -l apps/faragent-app/src-tauri/resources/helper/*/faragent-helper   # 看真实体积
ssh <Host> 'rm -rf ~/.faragent'
faragent <Host>
# 校验：远端 sha256 必须与本机一致
shasum -a 256 apps/faragent-app/src-tauri/resources/helper/<platform>/faragent-helper
ssh <Host> 'sha256sum ~/.faragent/bin/faragent-helper || shasum -a 256 ~/.faragent/bin/faragent-helper'
```

**应该看到什么**：两个摘要逐字节相同；远端文件大小与本机一致；随后 `faragent-helper` 能执行成功。

**什么算失败**：摘要不同、文件被截断、只在慢速链路上偶发失败（那更要记下来，是竞态）。

---

## 3. 真的 `noexec` 挂载点 —— 未验证

`FallbackReason::NotExecutable` 的分支在单测里只验证了"退出码 126 → 判定为不可执行"，没有真实的 `noexec` 文件系统。

**怎么操作**（需要 root / sudo 的 Linux 主机）

```bash
sudo mkdir -p /tmp/noexec-home
sudo mount -t tmpfs -o noexec,size=64m tmpfs /tmp/noexec-home
# 让远端的 HOME 落在 noexec 上（或直接把安装目录指过去）
ssh -t <Host> 'HOME=/tmp/noexec-home faragent-helper --version'   # 预期：126 / Permission denied
```

这个 126 来自挂载点本身，不是来自 `--version`：在可写挂载点上 `--version` 会直接打印并退出 0（见第 14 节），所以这里出现 126 是内核拒绝 exec 这个文件。

**应该看到什么**：面板 / TUI 显示"远端 helper 无法执行（退出码 126）：可能是 noexec 挂载点或架构不符，改用脚本模式。"，即 `HelperMode::ScriptFallback(FallbackReason::NotExecutable { .. })`，**并且会话仍然可用**（脚本模式兜底），不是直接失败。

**什么算失败**：报"文件不存在"或"上传失败"（说明判定错在别的原因上，用户会被引向错误的修法）；或者直接连不上、不给降级。

---

## 4. `$HOME` 不可写 —— 未验证

对应 `FallbackReason::UploadFailed { detail }`。单测里是假 host 抛错，没有真权限问题。

**怎么操作**

```bash
ssh <Host> 'rm -rf ~/.faragent && chmod a-w ~'          # 只读 home
faragent <Host>
ssh <Host> 'chmod u+w ~'                                # 恢复
```

**应该看到什么**：文案是"上传 helper 失败（{detail}），改用脚本模式。"，其中 `{detail}` 应当指出 home 不可写 / 只读这个原因；降级到脚本模式，会话照常可用。

**什么算失败**：把一个原始 shell 报错直接甩给用户（例如 `Permission denied` 加一段 stderr）；或者静默什么都不显示。

---

## 5. 远端既没有 `sha256sum` 也没有 `shasum` —— 未验证

`FallbackReason::NoChecksumTool`。判定逻辑（`parse_probe`）有单测，真机要确认的是**一台真的精简镜像**上的行为。

**怎么操作**（用一个精简容器最容易复现）

```bash
docker run --rm -it alpine:3.20 sh     # 里面默认没有 coreutils 的 sha256sum
# 把 FarAgent 指向这个容器暴露出来的 sshd，或在一台精简 VM 上：
ssh <Host> 'command -v sha256sum || command -v shasum || echo NONE'
```

**应该看到什么**：探测结果里 checksum 工具为"无"，面板 / TUI 显示"远端（Linux）缺少 sha256sum / shasum，无法校验上传，改用脚本模式"，**并且不尝试上传**（不能上传一份无法校验的东西）。

**什么算失败**：仍然上传；或者降级文案文不对题（例如报成平台不支持）。

---

## 6. 登录 shell 的 banner 出现在第一帧之前 —— 未验证

连接时跑的是 `bash -lc`（登录 shell），`/etc/motd`、conda、nvm 之类的输出会混进协议流。本地 mock 里没有 banner。

**怎么操作**

```bash
ssh <Host> 'echo "echo HELLO FROM MOTD" | sudo tee /etc/profile.d/faragent-banner.sh'
ssh -o BatchMode=yes <Host> true    # 确认手动 ssh 能看到 banner
faragent <Host>                     # 然后打开面板
```

**应该看到什么**：banner 文本**不会**出现在面板内容里（不会被当作文件内容或协议帧）；连接仍然成功。

**什么算失败**：文件预览里出现 banner 文本；协议解析错位导致 `not_found` / 乱码；或者连接失败。

---

## 7. 杀掉连接后，远端子进程被回收 —— 未验证

这是任务 8 的泄漏面（`ssh` 子进程）。开发机上只能验证前端侧的租约逻辑，**远端 `pgrep` 只能真机做**。

**怎么操作**

```bash
# 连上并做点事，让 helper 起效
faragent <Host>
# 然后"拔线"：在另一个终端里杀掉本机这一侧的 ssh
pkill -f 'ssh .*faragent-helper' || pkill -f 'ssh .*faragent'

# 立刻到远端查残留
ssh <Host> "pgrep -af 'faragent-helper'"
ssh <Host> "pgrep -af 'watch|inotifywait'"      # 看 watch 有没有留下子进程
```

**应该看到什么**：远端不再有 `faragent-helper` 进程；重复几次（连上 → 拔线）后数量**不累积**。

**什么算失败**：每次拔线都留下一个进程（泄漏）；或者留下 watch 子进程。

**再验一次"正常关闭"**：从 UI 里关掉面板 / 关掉会话，同样在远端 `pgrep` 一次，结果应为空。

---

## 8. 连接与订阅的回收（关面板 / 切标签 / 切主机） —— 开发机已验（mock）

本分支的重点。**订阅数**可以在 mock 上数（已验），**远端侧**只能真机确认。

**怎么操作**

```bash
# 远端侧数订阅：看 helper 有没有真的 unsubscri
ssh <Host> "ls /proc/\$(pgrep -f faragent-helper)/fd | wc -l"   # 粗看 fd 数有没有涨
# 更直接：helper 侧留日志（如果有），或看 inotify 实例数
ssh <Host> "pgrep -af 'inotifywait|fswatch'"
```

在 UI 上依次做：

1. 打开面板 → 关掉面板（**关面板**）
2. 打开面板 → 打开第二个会话标签 → 切回第一个（**切标签**）
3. 打开面板 → 切到另一台主机再切回来（**切主机**）
4. 在面板里点文件 → 改动 → Git 三个标签来回切（**切面板内标签**）

**应该看到什么**

- 1 / 2 / 3：每一次都会释放订阅 ── 在 mock 上已确认会发出一次 `watch.unsubscribe`，随后向旧主机再推 `fs.changed` 时**没有任何订阅收到**（即远端侧确实没了）。
- 4：**不**释放、也不重复订阅 ── 面板内标签切换不产生 `watch.subscribe` / `watch.unsubscribe` 往返（watch 挂在面板根目录上，三个标签共用）。
- 面板重开后，本地查询缓存被清掉：立刻切到一个远端**不存在**的目录，应当看到"不存在"的错误，而不是旧目录的缓存内容。

**什么算失败**：连开三次面板后远端留下多个订阅；切换标签时每次都要重新订阅；关掉面板后远端仍在推送。

---

## 9. 真实仓库上的面板（深度、大文件、二进制、大 diff） —— 部分开发机已验（mock）

**已在开发机（mock）验证的**

- **超过上限的大文件**：root 切到 `/var/log/faragent`，点开 `huge.log`（1.5 MiB，上限 1 MiB），界面显示"File is too large to preview"，没有把那 1.5 MiB 拉进来。
- **大 diff**：root 切到 `/srv/data`、Git 标签打开 `src/app.rs`、把 `git.diff` 的返回换成一段 3001 行的补丁 —— 界面显示"Long diff, showing the first 2000 of 3001 lines"，正文只渲染前 2000 行（第 1998 行之后的内容和最后一行都不在 DOM 里），英文界面同样成立。截图：`.superpowers/sdd/dazzling-strolling-flurry/shots/diff-truncated-en-light.png`（该目录被 gitignore，不进版本库）。

**没验的形状**：30 层深的目录树、真实二进制文件（夹具是 `/srv/app/docs/img/logo.png`）、620 个改动那个仓库（`/srv/monorepo`）在 UI 上的表现。

mock 里有对应的夹具，可以先在开发机上跑一遍再上真机（见 `src/lib/mock/helper.ts` 的 `HELPER_FIXTURES`）：

| 形状 | mock 夹具 |
| --- | --- |
| 五层深的目录树（带一个 symlink 和一个点目录） | `/srv/app` |
| 1.5 MiB 的日志 | `/var/log/faragent/huge.log` |
| `fs.read` 回 `binary` 的文件 | `/srv/app/docs/img/logo.png` |
| 14 个改动、覆盖每种状态字母的仓库 | `/srv/data` |
| **620** 个改动、超过 helper 500 条上限的仓库 | `/srv/monorepo` |
| 不是仓库的目录 | `/srv/scratch` |

真机要补的是**规模**（30 层、远超 1.5 MiB、真实链路延迟）和**真文件系统**的行为。

**怎么操作**

```bash
# 深目录
ssh <Host> 'mkdir -p /tmp/deep && cd /tmp/deep && for i in $(seq 1 30); do mkdir -p "d$i"; cd "d$i"; done && touch leaf.txt'
# 大文件（> 1MB 文本）
ssh <Host> 'head -c 3000000 /dev/urandom | base64 > /tmp/big.txt'
# 二进制
ssh <Host> 'head -c 2000000 /dev/urandom > /tmp/blob.bin'
# > 500 文件的改动
cd <repo> && for i in $(seq 1 600); do echo $i >> "gen/$i.txt"; done && git add -A
```

在面板里打开 `<repo>`（root 填 `/tmp/deep` 和仓库路径），依次：

- 展开到第 30 层
- 预览 `/tmp/big.txt`
- 预览 `/tmp/blob.bin`
- 打开"改动"标签，看 600 个文件

**应该看到什么**

- 深目录：能展开到底；展开父目录时**不重新拉整棵树**（只有该层在转圈）。
- `> 1MB` 文本：明确显示已截断（有一个大小/截断提示），不是静默只显示前一段；滚动不卡死。
- 二进制：明确说"这是二进制，不预览内容"，**不**把乱码画到屏幕上。
- 600 文件：列表可用（虚拟滚动或分页），不全量卡住；打开单个文件的 diff 只请求那一个文件的补丁。

**什么算失败**：预览显示了一半却不说明截断；二进制被当文本渲染；600 个文件时 UI 冻结；展开一层目录触发整棵树重拉。

---

## 10. 推送刷新与突发合并（真 `git checkout` / `npm install`） —— 开发机已验（mock）

在 mock 上已验证：单次 `fs.changed` 只失效该路径的父目录列表、该路径自身的列表、以及它的 `stat` 和 `read` —— 绝不是整个 `["panel"]`，所以不会有人 `npm install` 一下就把整棵树重拉一遍；20 次连续推送合并成 **1** 次往返；`git.changed` 只刷 `status / branches / log / diff`，不刷 `discover`。

真机要确认的是**推送到得对不对、量级扛不扛得住**：

```bash
# 突发一：npm install
ssh <Host> 'cd <repo> && npm install --no-audit --no-fund'

# 突发二：切分支
ssh <Host> 'cd <repo> && git checkout <other-branch>'

# 突发三：大范围写文件
ssh <Host> 'cd <repo> && touch src/**/*.ts'
```

**应该看到什么**

- 目录树/预览在 1 秒内自己变新，不需要手点刷新。
- 突发期间：面板不卡、SSH 连接数不暴涨（在远端 `ss -tn | grep :22 | wc -l` 看数量，应保持个位数）。
- `git checkout` 后 Git 标签的分支/提交/改动跟着变。

**什么算失败**：每次写文件都发一次远端请求（远端 CPU 被面板打满）；推送到了但界面不更新；`git checkout` 之后 Git 面板还是旧状态。

---

## 11. 会话列表轮询在窗口隐藏/失焦时暂停 —— 开发机已验（mock）

规则（`sessionPollInterval`）已单测：窗口隐藏**或**失焦时返回 `false`。

**怎么操作**

```bash
# 看 ssh 连接（会话列表走的是另一条通道，看本机到该主机的连接数即可）
lsof -i :22 | grep <Host> | wc -l
```

1. 面板打开着，让窗口获得焦点，等 35 秒 → 应当看到一次会话列表刷新（约每 30 秒一次）。
2. 切到别的应用（失焦）或最小化（隐藏），再等 60 秒 → **不应有新请求**。
3. 切回来 → 立刻恢复轮询（且回来时马上刷一次）。

**什么算失败**：隐藏 / 失焦后仍在每 30 秒发一次（应用挂着过夜会发 2880 次）；切回来要等满 30 秒才刷新。

---

## 12. 面板文案的中英双语完整性 —— 开发机已验（mock + 源码扫描）

`npm test` 里有一项扫描：组件里用到的每一个 key 都必须在 `lib/i18n.ts` 的**中英两张表**里都有；表里的每个 key 也必须真的被用到（没有死键）。已清掉 6 个死键（`panel.root`、`panel.scriptMode`、`panel.scriptModeHint`、`file.lines`、`changes.empty`、`changes.untracked`）。**时间超时那一句**（任务 8 漏掉的英文串）现在也进了字典，中英都有。

真机要确认的是**渲染出来没有漏词、没有串行**：

1. 设置页 → 语言切到 **English**，把面板三个标签、连接失败页、超时提示、设置页（磁盘缓存那一节）全部看一遍。
2. 切回 **中文**，同样看一遍。
3. 特别看：连接超时的那句话（拔掉网线或连一个黑洞地址触发）。
4. 特别看：磁盘缓存设置里那句写明了目录的说明。

**应该看到什么**：两种语言下都没有空白标签、没有 `undefined`、没有英文句子里夹中文（或反过来）；括号、数字占位符都被替换掉了（不是留着 `{path}`）。

**什么算失败**：出现 `{path}`、`{size}`、`{op}` 这类未替换的占位符；同一句里两种语言混排；某个按钮在英文下文字为空。

---

## 13. 磁盘缓存写到指定的目录 —— 未验证（本分支缺后端命令）

设计指定的目录是 **`~/.faragent/app-cache/`**，设置页里也照实写了这个路径。

**但本分支没有实现往这个目录写盘的 Tauri 命令**：`apps/faragent-app/src-tauri/` 不在本分支的改动范围内，仓库里也没有任何现成的"写文件"命令。所以当前的实现把数据放在 **webview 自己的本地存储（localStorage）** 里，键是 `faragent.appCache.bucket.v1`。设置页里那句说明把这个事实写清楚了（"本分支还没有写盘的后端命令，所以数据目前存在应用自己的本地存储里"），**不是把它当成已经写在 `~/.faragent/` 了**。

**怎么操作**

```bash
# 打开设置 → 磁盘缓存 → 打开开关
ls -la ~/.faragent/app-cache/ 2>&1     # 预期：不存在 —— 这就是上面那条未验证项
```

**应该看到什么（当前实现）**：开关默认**关**；打开后浏览面板，数据出现在 webview 的 localStorage 里；关闭开关或点"立即清空"后数据消失；"立即清空"**不会**把开关关掉。

**要验的下一件事（需要补后端命令之后）**

- 数据真的落在 `~/.faragent/app-cache/`，文件名可预期。
- 关掉开关之后目录里不再新增。
- **凭据绝不落盘**：`grep -ri 'password\|secret\|token\|id_rsa' ~/.faragent/app-cache/` 应当无命中。
- 缓存内容只是**明文**：目录列表、文件内容、Git 信息。打开其中一个文件，肉眼确认没有二进制乱码（文件内容是 base64 编码的字节，但整体是文本）。

**什么算失败**：目录里出现令牌、密码、私钥；关掉开关还在写；清空按钮清不掉。

---

## 14. CI 构建过、但从未运行过的产物 —— 未验证

`.github/workflows/ci.yml` 的 `helper` 作业会为这些平台构建 helper 二进制：

| 平台目录 | 由谁构建 | 有没有被真跑过 |
| --- | --- | --- |
| `linux-x86_64` | ubuntu 作业 | 有（本机 `cargo test` 会跑真二进制，`the_real_built_helper_survives_the_local_round_trip`） |
| `linux-aarch64` | ubuntu 作业（musl + zig） | **没有** —— CI 里没有 aarch64 的 Linux 机器 |
| `darwin-arm64` | macos 作业 | 有（macos-latest 就是 arm64） |
| `darwin-x86_64` | macos 作业 | **没有** —— 构建机是 arm64，`uname -m` 走的是 arm64 分支 |
| `windows-x86_64` | windows 作业 | **没有** —— 那个真二进制往返测试带 `#[cfg(unix)]`，在 Windows 上根本不编译 |

也就是说：**`linux-aarch64`、`darwin-x86_64`、`windows-x86_64` 的 helper 是"能构建、能发布、但没有在对应硬件上跑过一次"的。**

**怎么操作**

```bash
# 在对应机器上（树莓派 / ARM 服务器 / Intel Mac / Windows 机器）
uname -s -m                                    # Linux/aarch64、Darwin/x86_64
# 把该平台的 helper 传到那台机器上，然后：
~/.faragent/bin/faragent-helper --version      # 或任意一条 helper 的只读 op
```

**应该看到什么**：helper 打印 `faragent-helper <版本号>` 并退出 0 —— 版本号与它 `ping` 回复里的一致 —— 架构不匹配的报错**不**出现。（`--version` 与 `--help` 都在读取 stdin 之前就答完，所以这一行不会卡住。）

**什么算失败**：`Exec format error`；启动即崩；musl 静态链接在目标发行版上缺符号。

---

## 15. Windows 远端的环境判定文案 —— 未验证

本分支改掉了 `FallbackReason::WindowsRemote` 的措辞：以前它暗示"降级到脚本模式"，但 helper 通道是 POSIX 专用的，Windows 上**根本开不了 helper 会话**，所以现在是一句明确的失败说明；而且它以**双语** `localized` 错误传到前端（不是拍平成一句英文），中文读者看到的就是中文那半：

> the remote is Windows: the helper channel is POSIX-only, so no helper session can be opened on it.
> 远程是 Windows：helper 通道仅支持 POSIX，无法在这些远端打开 helper 会话。

mock 里已经按这句对齐（`win-builder` 这个主机名会返回它），Rust 侧的 `cargo test -p faragent-service`（76 项）也通过。真机要确认的是**在一台真的 Windows OpenSSH 主机上，用户看到的是这句而不是脚本降级**。

**怎么操作**

```bash
# 在一台开着 OpenSSH Server 的 Windows 机器上
ssh <WinHost> 'cmd /c ver'          # 确认是 Windows
# 然后在 FarAgent 里选这台主机
```

**应该看到什么**：明确的"Windows / helper 只支持 POSIX / 无法建立会话"，而不是"已改用脚本模式"；中文界面下这句话是中文。

**什么算失败**：文案说"已降级到脚本模式"（不真实）；中文界面显示英文那句；或者给出一个用户无法理解的原始报错。

---

## 16. 脚本兜底的 op 缺口被点名，而不是悄悄失败 —— 开发机已验（mock）

bash 兜底（`crates/faragent-remote/src/{fs,git}.rs`）只会七个 op —— `ping`、`fs.list`、`fs.read`、`fs.stat`、`git.discover`、`git.status`、`git.log`。它**不会** `git.diff`、`git.branches`、`watch.subscribe`。本分支之前，面板默认这三个都有：改动标签报 `unknown op git.diff`，分支列表没法用，实时刷新按设计被静默吞掉。

修它的机制本来就在协议里，只是以前没人用：`ping` 的回复带着 `ops` 列表，面板在连接打开时 ping 一次，然后只禁用远端确实供不了的那几项 —— 每一项都用双语理由顶替内容，绝不留空、也绝不撒谎。因为判定是**按 op** 而不是"原生 vs 脚本"，将来某个兜底补上了 `git.diff`，这个功能不用改代码就自动回来。

**怎么操作**

用第 3、4 节里的任一手段，或把安装目录指到没有 `sha256sum`/`shasum` 的挂载点，把兜底逼出来；然后在那台主机上打开面板，走下表。开发机上可以用 mock 的 `gpu-box`（`src/lib/mock/helper.ts` 把它建模成 `script_fallback`，它的 `opCall` 对七个之外的 op 返回 `unknown op`，与真实 shell 脚本一致）。

**应该看到什么** —— 逐项：

| 面板入口 | 兜底下的表现 | 原因 |
| --- | --- | --- |
| 文件标签：树、预览、stat | **可用** | `fs.list`、`fs.read`、`fs.stat` 都在词表里 |
| 改动标签：改动文件列表 | **可用** | `git.status` 在 |
| 改动标签：点开某文件的 diff | **禁用** | 没有 `git.diff`；该行不可展开，并显示 `changes.noDiffOp` |
| Git 标签：仓库 / status / log | **可用** | `git.discover`、`git.status`、`git.log` 都在 |
| Git 标签：分支列表 | **禁用** | 没有 `git.branches`；该区显示 `git.branchesUnsupported`，**不是**"没有分支" |
| 实时刷新 | **关闭** | 没有 `watch.subscribe`；面板顶部一行显示 `panel.watchUnsupported`，且不再发订阅 |

同时确认**反面**：兜底下，`git.diff`、`git.branches`、`watch.subscribe` 这三个请求一次都不该发出（照附录那样包一层 `window.__TAURI_INTERNALS__.invoke` 记录命令名）。再确认**正面**：原生主机（mock 里的 `build-01.farm.internal`）上以上六项都跟以前一样 —— 能力门禁不能把 helper 供得了的功能也关掉。

**什么算失败**：被禁用的入口渲染成空列表或转圈，而不是给出理由；中文界面下理由是英文；那三个不支持的 op 仍在发；或者原生主机丢掉了它本可以提供的功能。

---

## 附：开发机上怎么用 mock 复现推送

面板的实时刷新可以完全不碰真机地验证，审查者可用这套步骤：

```bash
# 1. 起前端
npm --prefix apps/faragent-app run dev     # http://localhost:1420

# 2. 打开 build-01.farm.internal 的面板，root 切到仓库夹具 /srv/data
#    然后在浏览器控制台里（dev 模式才有这个句柄）
__faragentMock.pokeWatch('build-01.farm.internal', '/srv/data/src/app.rs')
__faragentMock.pokeGitChanged('build-01.farm.internal')
```

- `pokeWatch` 只会送到**覆盖该路径**的订阅上，返回听到的订阅数（路径不在面板 root 之下就返回 0，所以先确认 root）。
- 效果：文件树刷新受影响的那个目录；Git 面板刷新。
- 想数清"有没有多打 SSH"：把 `window.__TAURI_INTERNALS__.invoke` 包一层，记录命令名即可。
- 各形状的夹具名见第 9 节那张表（`/srv/monorepo` 是 620 个改动那个）。

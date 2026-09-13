//! UI language. Chosen once, stored in `~/.faragent/config.json`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

impl Lang {
    pub const ALL: [Lang; 2] = [Lang::Zh, Lang::En];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "zh" | "zh-cn" | "zh-hans" | "cn" | "chinese" => Some(Self::Zh),
            "en" | "en-us" | "en-gb" | "english" => Some(Self::En),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Zh => "zh",
            Self::En => "en",
        }
    }

    pub fn native_name(self) -> &'static str {
        match self {
            Self::Zh => "中文",
            Self::En => "English",
        }
    }

    pub fn hosts_title(self) -> &'static str {
        match self {
            Self::Zh => "FarAgent · 主机",
            Self::En => "FarAgent · hosts",
        }
    }

    pub fn agents_title(self, host: &str) -> String {
        match self {
            Self::Zh => format!("FarAgent · {host} · 编程助手"),
            Self::En => format!("FarAgent · {host} · agents"),
        }
    }

    pub fn sessions_title(self, host: &str, agent: &str) -> String {
        format!("FarAgent · {host} · {agent}")
    }

    pub fn new_cwd_title(self) -> &'static str {
        match self {
            Self::Zh => "FarAgent · 新建会话 · 工作目录",
            Self::En => "FarAgent · new session · working directory",
        }
    }

    pub fn new_dir_title(self, dir: &str) -> String {
        match self {
            Self::Zh => format!("FarAgent · {dir} 不存在"),
            Self::En => format!("FarAgent · {dir} does not exist"),
        }
    }

    pub fn new_dir_list_title(self) -> &'static str {
        match self {
            Self::Zh => "目录不存在，是否创建？",
            Self::En => "directory missing - create it?",
        }
    }

    /// Body of the confirmation screen. The command that will run sits at
    /// `new_dir_cmd_index()` and is highlighted there.
    pub fn new_dir_lines(self, dir: &str, os: crate::remote::HostOs) -> Vec<String> {
        let cmd = self.new_dir_command(dir, os);
        match self {
            Self::Zh => vec![
                "这是会话的工作目录：agent 读写代码的根目录，不是文件夹浏览器。".into(),
                String::new(),
                format!("远程还没有这个目录：{dir}"),
                String::new(),
                "回车 = 由 FarAgent 在远程创建它（执行下面的命令），然后在这个目录里启动 / 恢复会话。".into(),
                cmd,
                String::new(),
                "Esc / q = 返回修改路径（不会在远程写入任何东西）。".into(),
            ],
            Self::En => vec![
                "This is a session's working directory: the root of the code the agent reads and writes, not a folder browser.".into(),
                String::new(),
                format!("That directory is not on the remote yet: {dir}"),
                String::new(),
                "Enter = let FarAgent create it on the remote (the command below), then start or resume the session there.".into(),
                cmd,
                String::new(),
                "Esc / q = back to edit the path (nothing is written on the remote).".into(),
            ],
        }
    }

    /// The one command the create screen runs on the remote, per dialect.
    pub fn new_dir_command(self, dir: &str, os: crate::remote::HostOs) -> String {
        use crate::remote::HostOs;
        match os {
            HostOs::Posix => format!("mkdir -p {dir}"),
            HostOs::Windows => format!("New-Item -ItemType Directory -Force -LiteralPath '{dir}'"),
        }
    }

    /// Index into `new_dir_lines(..)` of the command line to highlight.
    pub fn new_dir_cmd_index(self) -> usize {
        5
    }

    pub fn new_dir_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 创建并开始 · Esc 返回修改路径",
            Self::En => "enter create and start · esc back to the path",
        }
    }

    pub fn dir_missing_status(self) -> &'static str {
        match self {
            Self::Zh => "远程没有这个目录：回车创建并开始，Esc 返回修改",
            Self::En => "directory missing on the remote: enter creates it, esc edits the path",
        }
    }

    pub fn dir_creating(self, dir: &str) -> String {
        match self {
            Self::Zh => format!("正在远程创建 {dir} 并启动会话…"),
            Self::En => format!("creating {dir} on the remote and starting the session…"),
        }
    }

    pub fn language_title(self) -> &'static str {
        "FarAgent · language / 语言"
    }

    pub fn hosts_list_title(self) -> &'static str {
        match self {
            Self::Zh => "SSH 主机（~/.ssh/config）",
            Self::En => "SSH hosts (~/.ssh/config)",
        }
    }

    pub fn agents_list_title(self) -> &'static str {
        match self {
            Self::Zh => "编程助手",
            Self::En => "coding agents",
        }
    }

    pub fn sessions_list_title(self, os: crate::remote::HostOs) -> &'static str {
        use crate::remote::HostOs;
        match (self, os) {
            (Self::Zh, HostOs::Posix) => "会话  [live]=tmux 仍在运行",
            (Self::En, HostOs::Posix) => "sessions  [live]=tmux still running",
            (Self::Zh, HostOs::Windows) => "会话  [running]=可能有进程仍在运行",
            (Self::En, HostOs::Windows) => "sessions  [running]=a process may still be running",
        }
    }

    pub fn cwd_block_title(self) -> &'static str {
        match self {
            Self::Zh => "新会话的工作目录（agent 读写代码的地方，不是新建文件夹）",
            Self::En => {
                "working directory for the new session (where the agent runs - not a new folder)"
            }
        }
    }

    pub fn language_list_title(self) -> &'static str {
        "Select language / 选择语言"
    }

    pub fn keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 打开 · n 新建会话 · r 刷新 · L 语言 · q 返回 · 助手内断开: C-g d",
            Self::En => {
                "enter open · n new session · r refresh · L language · q back · agent detach: C-g d"
            }
        }
    }

    /// Footer for the session screens. On Windows remotes the agent runs in
    /// the foreground: there is no detach — quitting the agent ends it, and
    /// the conversation comes back through resume.
    pub fn keys_hint_os(self, os: crate::remote::HostOs) -> &'static str {
        use crate::remote::HostOs;
        match os {
            HostOs::Posix => self.keys_hint(),
            HostOs::Windows => match self {
                Self::Zh => {
                    "回车 打开 · n 新建会话 · r 刷新 · L 语言 · q 返回 · 退出助手即结束（可 resume 恢复）"
                }
                Self::En => {
                    "enter open · n new session · r refresh · L language · q back · quitting the agent ends it (resume later)"
                }
            },
        }
    }

    pub fn hosts_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 探测 · g 登录方式（密钥/密码）· r 刷新 · L 语言 · q 退出",
            Self::En => {
                "enter probe · g auth mode (key/password) · r refresh · L language · q quit"
            }
        }
    }

    pub fn agents_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => {
                "回车 会话/安装 · U 升级 · X 卸载 · r 刷新 · q 返回 · 助手内断开: C-g d"
            }
            Self::En => {
                "enter sessions/install · U upgrade · X uninstall · r refresh · q back · detach: C-g d"
            }
        }
    }

    pub fn confirm_keys_hint(self, can_run: bool) -> &'static str {
        match (self, can_run) {
            (Self::Zh, true) => "回车 执行（过程会直播） · Esc 取消",
            (Self::En, true) => "enter run (live PTY) · esc cancel",
            (Self::Zh, false) => "无法执行 · Esc 返回（下方有可复制命令）",
            (Self::En, false) => "cannot run · esc back (copy-paste commands below)",
        }
    }

    pub fn language_keys_hint(self) -> &'static str {
        "↑↓  j/k   Enter  confirm / 确认   q  quit"
    }

    pub fn status_ready(self) -> &'static str {
        match self {
            Self::Zh => "回车探测 · g 登录方式（密钥/密码）· r 刷新 · L 语言 · q 退出",
            Self::En => {
                "enter probe · g auth mode (key/password) · r refresh · L language · q quit"
            }
        }
    }

    pub fn status_help(self) -> &'static str {
        match self {
            Self::Zh => {
                "j/k 移动 · 回车打开 · n 新会话 · g 登录方式 · r 刷新 · L 语言 · q 返回 · 助手内断开: C-g d"
            }
            Self::En => {
                "j/k move · enter open · n new session · g auth mode · r refresh · L language · q back · detach in agent: C-g d"
            }
        }
    }

    pub fn no_hosts(self) -> &'static str {
        match self {
            Self::Zh => " ~/.ssh/config 里没有具体 Host（通配符会被忽略）。",
            Self::En => "No concrete Host entries in ~/.ssh/config (wildcards ignored).",
        }
    }

    pub fn host_count(self, n: usize) -> String {
        match self {
            Self::Zh => format!("{n} 台主机"),
            Self::En => format!("{n} hosts"),
        }
    }

    pub fn probing(self, host: &str) -> String {
        match self {
            Self::Zh => format!("正在探测 {host}…"),
            Self::En => format!("probing {host}…"),
        }
    }

    pub fn probe_failed(self, host: &str) -> String {
        match self {
            Self::Zh => format!("探测 {host} 失败（错误见下方，回车可重试）"),
            Self::En => format!("probe {host} failed (see error below; Enter retries)"),
        }
    }

    pub fn select_agent(self) -> &'static str {
        match self {
            Self::Zh => "选择助手 · 回车进入会话或安装 · U 升级 · X 卸载",
            Self::En => "select an agent · enter sessions or install · U upgrade · X uninstall",
        }
    }

    pub fn sessions_status(self) -> &'static str {
        match self {
            Self::Zh => "回车接入/恢复 · n 新建会话 · live 会话只 attach",
            Self::En => "enter attach/resume · n new session · live sessions attach only",
        }
    }

    pub fn session_count(self, n: usize) -> String {
        match self {
            Self::Zh => format!("{n} 个会话"),
            Self::En => format!("{n} sessions"),
        }
    }

    pub fn no_sessions(self) -> &'static str {
        match self {
            Self::Zh => "（暂无会话 — 按 n 新建会话）",
            Self::En => "(no sessions — press n for a new session)",
        }
    }

    pub fn live(self) -> &'static str {
        "live"
    }

    pub fn idle(self) -> &'static str {
        "idle"
    }

    /// Windows-remote session mark: a process scan suggests it may be open
    /// elsewhere (never a hard block — entering asks first).
    pub fn running(self) -> &'static str {
        "running"
    }

    pub fn sessions_status_os(self, os: crate::remote::HostOs) -> &'static str {
        use crate::remote::HostOs;
        match os {
            HostOs::Posix => self.sessions_status(),
            HostOs::Windows => match self {
                Self::Zh => "回车启动/恢复 · n 新建会话 · running 表示可能有进程在跑",
                Self::En => {
                    "enter start/resume · n new session · running means a process may be alive"
                }
            },
        }
    }

    pub fn running_confirm_title(self, host: &str) -> String {
        match self {
            Self::Zh => format!("FarAgent · {host} · 该会话可能在运行"),
            Self::En => format!("FarAgent · {host} · session may be running"),
        }
    }

    pub fn running_confirm_lines(self, title: &str) -> Vec<String> {
        match self {
            Self::Zh => vec![
                format!("检测到与「{title}」相关的 agent 进程可能仍在运行。"),
                String::new(),
                "同一会话若被两个进程同时写入，可能互相覆盖改动（codex#30424）。建议先到那个终端里退出它，再回来恢复。".into(),
                String::new(),
                "回车 = 仍然进入（以 resume 方式新起一个前台进程）".into(),
                "Esc = 返回会话列表".into(),
            ],
            Self::En => vec![
                format!("A process that may belong to \"{title}\" appears to be running."),
                String::new(),
                "Two agents writing the same session can overwrite each other (codex#30424). Consider quitting it in its own terminal first.".into(),
                String::new(),
                "Enter = open anyway (starts a new foreground process via resume)".into(),
                "Esc = back to the session list".into(),
            ],
        }
    }

    pub fn running_confirm_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 仍然进入 · Esc 返回列表",
            Self::En => "enter open anyway · esc back",
        }
    }

    pub fn session_warning_block_title(self) -> &'static str {
        match self {
            Self::Zh => "可能的双开冲突",
            Self::En => "possible double-open conflict",
        }
    }

    pub fn cancelled(self) -> &'static str {
        match self {
            Self::Zh => "已取消",
            Self::En => "cancelled",
        }
    }

    pub fn cwd_required(self) -> &'static str {
        match self {
            Self::Zh => "必须填写远程目录",
            Self::En => "cwd is required",
        }
    }

    pub fn type_cwd(self) -> &'static str {
        match self {
            Self::Zh => "输入 agent 的工作目录后回车；不存在会问你是否创建（Esc 取消）",
            Self::En => {
                "type the agent's working directory; if it is missing you will be asked to create it (esc cancels)"
            }
        }
    }

    pub fn probe_host_first(self) -> &'static str {
        match self {
            Self::Zh => "请先探测主机",
            Self::En => "probe the host first",
        }
    }

    #[allow(dead_code)]
    pub fn tmux_missing(self) -> &'static str {
        match self {
            Self::Zh => "远程未安装 tmux。回车可按官方/系统包管理器安装。",
            Self::En => "tmux is not installed on the remote. Enter to install it.",
        }
    }

    pub fn tmux_missing_short(self) -> &'static str {
        match self {
            Self::Zh => "远程未安装 tmux",
            Self::En => "tmux is not installed on the remote host",
        }
    }

    pub fn agent_missing(self, name: &str) -> String {
        match self {
            Self::Zh => format!("远程未安装 {name}"),
            Self::En => format!("{name} is not installed on the remote host"),
        }
    }

    #[allow(dead_code)]
    pub fn agent_not_installed(self, name: &str) -> String {
        match self {
            Self::Zh => format!("{name} 未安装"),
            Self::En => format!("{name} is not installed"),
        }
    }

    #[allow(dead_code)]
    pub fn not_installed(self) -> &'static str {
        match self {
            Self::Zh => "未安装",
            Self::En => "not installed",
        }
    }

    pub fn not_installed_hint(self) -> &'static str {
        match self {
            Self::Zh => "未安装 · 回车安装",
            Self::En => "not installed · enter to install",
        }
    }

    pub fn unknown_version(self) -> &'static str {
        match self {
            Self::Zh => "版本未知",
            Self::En => "unknown version",
        }
    }

    pub fn auth_ok(self) -> &'static str {
        match self {
            Self::Zh => "已登录",
            Self::En => "auth ok",
        }
    }

    pub fn auth_unknown(self) -> &'static str {
        match self {
            Self::Zh => "登录状态未知",
            Self::En => "auth unknown",
        }
    }

    pub fn attaching(self, tmux: &str) -> String {
        match self {
            Self::Zh => format!("正在接入 {tmux}  （断开: C-g d）"),
            Self::En => format!("attaching {tmux}  (detach: C-g d)"),
        }
    }

    pub fn detached(self) -> &'static str {
        match self {
            Self::Zh => "已断开 · 会话仍在远程运行",
            Self::En => "detached · session stays alive on the remote",
        }
    }

    /// Windows remote: the agent runs in the foreground of this connection.
    pub fn attaching_resume(self, name: &str) -> String {
        match self {
            Self::Zh => format!("正在启动 {name}（前台运行 · 退出即结束，可 resume 恢复）"),
            Self::En => format!("starting {name} (foreground · quitting ends it; resume later)"),
        }
    }

    pub fn session_ended(self) -> &'static str {
        match self {
            Self::Zh => "会话已结束 · 回车可 resume 恢复",
            Self::En => "session ended · enter resumes it later",
        }
    }

    pub fn ssh_exited(self, code: i32) -> String {
        match self {
            Self::Zh => format!("ssh/tmux 退出码 {code}"),
            Self::En => format!("ssh/tmux exited {code}"),
        }
    }

    pub fn language_saved(self) -> String {
        match self {
            Self::Zh => format!(
                "界面语言已保存到 ~/.faragent/config.json（{}）。之后不会再问。",
                self.native_name()
            ),
            Self::En => format!(
                "Language saved to ~/.faragent/config.json ({}). Won't ask again.",
                self.native_name()
            ),
        }
    }

    pub fn language_save_failed(self, err: &str) -> String {
        match self {
            Self::Zh => format!("无法写入 ~/.faragent/config.json: {err}"),
            Self::En => format!("could not write ~/.faragent/config.json: {err}"),
        }
    }

    pub fn confirm_title(self, action: crate::install::Action, host: &str, agent: &str) -> String {
        use crate::install::Action;
        match (self, action) {
            (Self::Zh, Action::Install) => format!("FarAgent · {host} · 安装 {agent}"),
            (Self::En, Action::Install) => format!("FarAgent · {host} · install {agent}"),
            (Self::Zh, Action::Upgrade) => format!("FarAgent · {host} · 升级 {agent}"),
            (Self::En, Action::Upgrade) => format!("FarAgent · {host} · upgrade {agent}"),
            (Self::Zh, Action::Uninstall) => format!("FarAgent · {host} · 卸载 {agent}"),
            (Self::En, Action::Uninstall) => format!("FarAgent · {host} · uninstall {agent}"),
        }
    }

    pub fn confirm_list_title(self) -> &'static str {
        match self {
            Self::Zh => "将在远程执行的命令（确认后直播输出）",
            Self::En => "commands that will run on the remote (live after confirm)",
        }
    }

    pub fn planning(self) -> &'static str {
        match self {
            Self::Zh => "正在生成安装计划…",
            Self::En => "building install plan…",
        }
    }

    pub fn plan_failed(self, err: &str) -> String {
        match self {
            Self::Zh => format!("无法生成安装计划: {err}"),
            Self::En => format!("could not build install plan: {err}"),
        }
    }

    pub fn no_need_uninstall(self, name: &str) -> String {
        match self {
            Self::Zh => format!("{name} 未安装，无需卸载"),
            Self::En => format!("{name} is not installed; nothing to uninstall"),
        }
    }

    pub fn step_sudo(self) -> &'static str {
        match self {
            Self::Zh => "需要 sudo",
            Self::En => "needs sudo",
        }
    }

    pub fn warning(self, w: crate::install::Warning) -> String {
        use crate::install::Warning;
        match (self, w) {
            (Self::Zh, Warning::LiveTmux) => {
                "警告：该助手还有 live tmux 会话。卸载可能打断正在跑的 TUI，仍可继续。".into()
            }
            (Self::En, Warning::LiveTmux) => {
                "Warning: this agent still has a live tmux session. Uninstall may interrupt it."
                    .into()
            }
            (Self::Zh, Warning::TmuxSkippedNoPkg) => {
                "未找到 brew/apt/dnf/yum/pacman/apk，跳过代装 tmux。可复制下方命令自行安装。".into()
            }
            (Self::En, Warning::TmuxSkippedNoPkg) => {
                "No brew/apt/dnf/yum/pacman/apk; skipping tmux. Copy a command below to install it yourself."
                    .into()
            }
            (Self::Zh, Warning::NeedsSudo) => {
                "有步骤需要 sudo。执行时若提示密码，在直播终端里输入（本机不保存）。".into()
            }
            (Self::En, Warning::NeedsSudo) => {
                "A step needs sudo. Type the password in the live terminal if asked (not stored locally)."
                    .into()
            }
        }
    }

    pub fn blocked(self, b: crate::install::Blocked) -> String {
        use crate::install::Blocked;
        match (self, b) {
            (Self::Zh, Blocked::NoCurlNoPkg) => {
                "远程没有 curl，也没有可识别的包管理器。请先自行安装 curl，命令见下方。".into()
            }
            (Self::En, Blocked::NoCurlNoPkg) => {
                "Remote has no curl and no known package manager. Install curl yourself (commands below)."
                    .into()
            }
            (Self::Zh, Blocked::TmuxOnlyNoPkg) => {
                "远程没有 tmux，也没有 brew/apt/dnf/yum/pacman/apk。请自行安装 tmux。".into()
            }
            (Self::En, Blocked::TmuxOnlyNoPkg) => {
                "Remote has no tmux and no brew/apt/dnf/yum/pacman/apk. Install tmux yourself."
                    .into()
            }
            (Self::Zh, Blocked::NotInstalled) => "未安装，无需卸载。".into(),
            (Self::En, Blocked::NotInstalled) => "Not installed; nothing to uninstall.".into(),
            (Self::Zh, Blocked::NothingToDo) => "没有需要执行的步骤。".into(),
            (Self::En, Blocked::NothingToDo) => "Nothing to do.".into(),
        }
    }

    pub fn suggested_title(self) -> &'static str {
        match self {
            Self::Zh => "可复制命令（FarAgent 不会执行这些）：",
            Self::En => "Copy-paste (FarAgent will not run these):",
        }
    }

    pub fn running_remote(self) -> &'static str {
        match self {
            Self::Zh => "正在远程执行（直播输出，完成后按回车返回）…",
            Self::En => "running on the remote (live output; Enter when done to return)…",
        }
    }

    pub fn remote_ok(self) -> &'static str {
        match self {
            Self::Zh => "远程命令成功 · 已重新探测",
            Self::En => "remote command succeeded · re-probed",
        }
    }

    pub fn remote_failed(self, code: i32) -> String {
        match self {
            Self::Zh => format!("远程命令失败（退出码 {code}）。错误见刚才的直播输出。"),
            Self::En => format!("remote command failed (exit {code}). See the live output."),
        }
    }

    pub fn plan_blocked_enter(self) -> &'static str {
        match self {
            Self::Zh => "当前计划无法执行。Esc 返回。",
            Self::En => "This plan cannot run. Esc to go back.",
        }
    }

    // ------------------------------------------------------------- problems
    // Long-form text for `diagnose`: every SSH failure gets a cause and
    // copy-pasteable fixes, in the language the user picked.

    pub fn problem_label(self) -> &'static str {
        match self {
            Self::Zh => "连接失败",
            Self::En => "connection failed",
        }
    }

    pub fn problem_title(self, host: &str) -> String {
        match self {
            Self::Zh => format!("FarAgent · {host} · 连接失败"),
            Self::En => format!("FarAgent · {host} · connection failed"),
        }
    }

    /// Panel title; the slug (`publickey_denied`, ...) keeps it greppable.
    pub fn problem_list_title(self, slug: &str) -> String {
        match self {
            Self::Zh => format!("原始报错与解决方案  [{slug}]"),
            Self::En => format!("raw error and fix  [{slug}]"),
        }
    }

    pub fn problem_raw(self) -> &'static str {
        match self {
            Self::Zh => "ssh 原始输出",
            Self::En => "raw ssh output",
        }
    }

    pub fn problem_command(self) -> &'static str {
        match self {
            Self::Zh => "FarAgent 实际执行的命令",
            Self::En => "command FarAgent ran",
        }
    }

    pub fn problem_fixes(self) -> &'static str {
        match self {
            Self::Zh => "处理步骤",
            Self::En => "fixes",
        }
    }

    pub fn problem_docs(self) -> &'static str {
        match self {
            Self::Zh => "文档",
            Self::En => "docs",
        }
    }

    pub fn ssh_doc(self) -> &'static str {
        match self {
            Self::Zh => "docs/zh/ssh-access.md（连不上时：原始报错 → 原因 → 解决）",
            Self::En => "docs/en/ssh-access.md (when it fails: raw error -> cause -> fix)",
        }
    }

    pub fn problem_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => {
                "j/k 滚动 · a 交互式登录（确认指纹 / 输密码）· r 重试 · y 复制全文 · esc 返回"
            }
            Self::En => {
                "j/k scroll · a interactive login (host key / password) · r retry · y copy · esc back"
            }
        }
    }

    pub fn problem_status(self, needs_auth: bool) -> &'static str {
        match (self, needs_auth) {
            (Self::Zh, true) => {
                "这台主机要走交互式登录：按 a 输密码或确认指纹（密码只给系统 ssh，FarAgent 不保存）"
            }
            (Self::En, true) => {
                "this host needs an interactive login: press a for the password / host key prompt (FarAgent stores nothing)"
            }
            (Self::Zh, false) => "按 a 可以交互式登录（确认指纹 / 输密码），r 重试",
            (Self::En, false) => {
                "press a to log in interactively (host key / password), r to retry"
            }
        }
    }

    pub fn problem_status_timeout(self) -> &'static str {
        match self {
            Self::Zh => {
                "等待超时：网络不通或远程登录壳挂住都可能 —— 按 r 重试，或按 a 交互式登录看实时输出"
            }
            Self::En => {
                "timed out: either the network is dead or the remote login shell hangs - press r to retry, or a to watch an interactive login"
            }
        }
    }

    pub fn auth_tag(self, mode: crate::ssh::AuthMode) -> &'static str {
        match (self, mode) {
            (Self::Zh, crate::ssh::AuthMode::Password) => "  [密码登录]",
            (Self::En, crate::ssh::AuthMode::Password) => "  [password]",
            (Self::Zh, crate::ssh::AuthMode::Key) => "  [仅密钥]",
            (Self::En, crate::ssh::AuthMode::Key) => "  [key only]",
            _ => "",
        }
    }

    pub fn auth_mode_label(self, mode: crate::ssh::AuthMode) -> &'static str {
        match (self, mode) {
            (Self::Zh, crate::ssh::AuthMode::Auto) => "自动：先试密钥，只有服务端要求密码时才提示",
            (Self::Zh, crate::ssh::AuthMode::Key) => "仅密钥：BatchMode，绝不弹密码",
            (Self::Zh, crate::ssh::AuthMode::Password) => "密码 / 键盘交互：登录一次后复用连接",
            (Self::En, crate::ssh::AuthMode::Auto) => {
                "auto: try keys first, offer a password prompt only if the server asks for one"
            }
            (Self::En, crate::ssh::AuthMode::Key) => "key only: BatchMode, never prompts",
            (Self::En, crate::ssh::AuthMode::Password) => {
                "password / keyboard-interactive: log in once, then reuse the connection"
            }
        }
    }

    pub fn auth_saved(self, host: &str, mode: crate::ssh::AuthMode) -> String {
        match self {
            Self::Zh => format!(
                "{host} 的登录方式：{}（{}）",
                mode.code(),
                self.auth_mode_label(mode)
            ),
            Self::En => format!(
                "{host} auth mode: {} ({})",
                mode.code(),
                self.auth_mode_label(mode)
            ),
        }
    }

    pub fn clipboard_ok(self) -> &'static str {
        match self {
            Self::Zh => "已复制到剪贴板",
            Self::En => "copied to clipboard",
        }
    }

    pub fn clipboard_failed(self) -> &'static str {
        match self {
            Self::Zh => "本机没有 pbcopy / wl-copy / xclip，无法复制",
            Self::En => "no pbcopy / wl-copy / xclip on this machine; cannot copy",
        }
    }

    /// Printed on the real terminal right before `ssh -tt` takes it over.
    pub fn interactive_banner(self, host: &str) -> String {
        match self {
            Self::Zh => format!(
                "正在交互式登录 {host}。如果提示密码，请输入远程账号的密码 —— 密码只交给系统 ssh，FarAgent 不读取也不保存。提示主机指纹时请核对后再回答 yes。成功后会复用这条连接，接下来一段时间不必再输。"
            ),
            Self::En => format!(
                "interactive login to {host}. Type the remote account password if asked - it goes straight to OpenSSH; FarAgent never reads or stores it. Verify the host key fingerprint before answering yes. A successful login is reused, so you will not be asked again for a while."
            ),
        }
    }

    pub fn login_ok(self, host: &str) -> String {
        match self {
            Self::Zh => format!(
                "已登录 {host}，多路复用连接保持中。接下来 `faragent` 与 `faragent doctor --host {host}` 不必再要密码。"
            ),
            Self::En => format!(
                "logged in to {host}; the multiplexed connection stays open, so `faragent` and `faragent doctor --host {host}` will not ask again."
            ),
        }
    }

    /// Shown in the TUI when the interactive attempt came back non-zero.
    pub fn auth_failed(self, code: i32) -> String {
        match self {
            Self::Zh => format!(
                "交互式登录没有成功（ssh 退出码 {code}）；失败原因就在刚才的终端输出里。按 r 重新探测，或再按 a 试一次。"
            ),
            Self::En => format!(
                "the interactive login did not succeed (ssh exit {code}); the reason is in the terminal output above. Press r to re-probe, or a to try again."
            ),
        }
    }

    /// Title of the in-memory password prompt (used when this machine's ssh
    /// cannot multiplex, e.g. Win32 OpenSSH).
    pub fn password_title(self) -> &'static str {
        match self {
            Self::Zh => "FarAgent · 密码",
            Self::En => "FarAgent · password",
        }
    }

    pub fn password_prompt(self, host: &str) -> String {
        match self {
            Self::Zh => format!(
                "输入 {host} 的登录密码。只保存在本次运行的进程内存里，不写盘、退出即清除；ssh 经 SSH_ASKPASS 读取，不再逐条命令提示。"
            ),
            Self::En => format!(
                "Password for {host}. Kept in this process only - never written to disk, gone when faragent exits. ssh reads it through SSH_ASKPASS."
            ),
        }
    }

    pub fn password_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 确认 · Esc 取消 · 输入不显示",
            Self::En => "enter confirm · esc cancel · input is hidden",
        }
    }

    pub fn password_required(self) -> &'static str {
        match self {
            Self::Zh => "密码不能为空",
            Self::En => "password must not be empty",
        }
    }

    pub fn password_stored(self, host: &str) -> String {
        match self {
            Self::Zh => format!("{host} 的密码已记住（仅本次运行）"),
            Self::En => format!("password remembered for {host} (this run only)"),
        }
    }

    pub fn problem_summary(self, p: crate::diagnose::Problem) -> &'static str {
        use crate::diagnose::Problem as P;
        match (self, p) {
            (Self::Zh, P::SshMissing) => "本机找不到 OpenSSH 客户端（ssh）：FarAgent 只负责驱动系统 ssh。",
            (Self::En, P::SshMissing) => {
                "no local OpenSSH client: FarAgent drives the system `ssh`, it does not ship its own."
            }
            (Self::Zh, P::PublickeyDenied) => {
                "远程拒绝了公钥：公钥没送到那台机器、账号不对，或远程权限不对。FarAgent 用 BatchMode，不会弹密码框。"
            }
            (Self::En, P::PublickeyDenied) => {
                "the server refused the key: the public key is not on that machine, the user is wrong, or remote permissions are off. FarAgent runs BatchMode, so it never shows a password prompt."
            }
            (Self::Zh, P::NeedsPassword) => {
                "远程只接受密码 / 键盘交互，publickey 不通过；FarAgent 不能替你弹密码框。"
            }
            (Self::En, P::NeedsPassword) => {
                "this host only accepts password / keyboard-interactive auth. FarAgent cannot type a password by itself."
            }
            (Self::Zh, P::PasswordDenied) => {
                "密码方式被拒绝：账号或密码不对，或这个账号被 sshd 挡了。"
            }
            (Self::En, P::PasswordDenied) => {
                "password auth was refused: wrong user or password, or sshd rejects that account."
            }
            (Self::Zh, P::TooManyAuthFailures) => {
                "本机 ssh-agent 里的钥匙太多，服务端在轮到你真正那把之前就断开了。"
            }
            (Self::En, P::TooManyAuthFailures) => {
                "too many keys in the local ssh-agent: the server hung up before it reached the right one."
            }
            (Self::Zh, P::HostKeyUnknown) => {
                "这台主机的指纹还不在本机 known_hosts 里（第一次连接），而 BatchMode 不能替你回答 yes。"
            }
            (Self::En, P::HostKeyUnknown) => {
                "this host's key is not in known_hosts yet, and BatchMode cannot answer the yes/no prompt for you."
            }
            (Self::Zh, P::HostKeyChanged) => {
                "远程主机指纹变了：系统重装、云主机重建，或者有人在中间转发。"
            }
            (Self::En, P::HostKeyChanged) => {
                "the host key changed: reinstall, rebuilt VM, or something is intercepting the connection."
            }
            (Self::Zh, P::PrivateFilePermissions) => {
                "本机 ~/.ssh 下的文件权限过宽（或属主不对），OpenSSH 为安全起见拒绝使用。"
            }
            (Self::En, P::PrivateFilePermissions) => {
                "a local ~/.ssh file is too permissive (or owned by someone else), so OpenSSH refuses to use it."
            }
            (Self::Zh, P::KeyUnreadable) => {
                "OpenSSH 读不了这把私钥：格式不对、文件损坏，或者把 .pub 当成了私钥。"
            }
            (Self::En, P::KeyUnreadable) => {
                "OpenSSH cannot read that private key: bad format, corrupt file, or a .pub was given instead."
            }
            (Self::Zh, P::KeyMissing) => "~/.ssh/config 里 IdentityFile 指的文件不存在或读不了。",
            (Self::En, P::KeyMissing) => {
                "the IdentityFile in ~/.ssh/config does not exist or cannot be read."
            }
            (Self::Zh, P::KeyPassphrase) => {
                "这把私钥带口令，但本机没有 ssh-agent 记住它，而 BatchMode 不会弹输入框。"
            }
            (Self::En, P::KeyPassphrase) => {
                "the key has a passphrase that no ssh-agent remembers, and BatchMode never prompts."
            }
            (Self::Zh, P::DnsFailure) => {
                "解析不了这个主机名：HostName 写错、DNS 不通，或这个内网名字要先连上对应的网。"
            }
            (Self::En, P::DnsFailure) => {
                "the hostname does not resolve: typo in HostName, DNS trouble, or an internal name that needs VPN/Tailscale first."
            }
            (Self::Zh, P::ConnectionRefused) => {
                "能到这台机器，但那个端口上没人监听：sshd 没启动、端口改了，或被防火墙拒绝。"
            }
            (Self::En, P::ConnectionRefused) => {
                "the host answers but nothing listens on that port: sshd stopped, wrong port, or a firewall reject."
            }
            (Self::Zh, P::ConnectionTimeout) => {
                "完全没有响应：地址不可达、防火墙悄悄丢包，或者远程登录壳卡住不返回。"
            }
            (Self::En, P::ConnectionTimeout) => {
                "no response at all: unreachable address, silently dropped packets, or a remote login shell that hangs."
            }
            (Self::Zh, P::NoRoute) => "本机没有到这个地址的路由：不在同一张网，或网卡 / VPN 没起来。",
            (Self::En, P::NoRoute) => {
                "no route to that address from this machine: wrong network, or the VPN/adapter is down."
            }
            (Self::Zh, P::KexClosed) => {
                "TCP 连上了，但 SSH 握手阶段就被关掉：sshd 没真的在跑、被 fail2ban 类机制拉黑，或 hosts.deny 拒绝。"
            }
            (Self::En, P::KexClosed) => {
                "TCP connected but the SSH handshake was closed: sshd not really running, an IP ban, or a TCP wrapper deny."
            }
            (Self::Zh, P::VersionMismatch) => {
                "客户端和服务端谈不拢算法：多半是远程 sshd 太老，只提供 ssh-rsa / 老 KEX。"
            }
            (Self::En, P::VersionMismatch) => {
                "client and server cannot agree on algorithms: usually an old sshd offering only ssh-rsa / legacy KEX."
            }
            (Self::Zh, P::RemoteBash) => {
                "SSH 通了，但远程登录壳没跑成 bash，或没有打印出 FarAgent 需要的标记。"
            }
            (Self::En, P::RemoteBash) => {
                "SSH works, but the remote login shell did not run bash or did not print the marker FarAgent expects."
            }
            (Self::Zh, P::RemoteShellUnsupported) => {
                "SSH 通了，但远端的默认 shell 根本不认识我们的命令（Windows 上常见于 sshd 默认 shell 配置损坏）。"
            }
            (Self::En, P::RemoteShellUnsupported) => {
                "SSH works, but the remote's default shell does not recognize our commands at all (on Windows this usually means sshd's default-shell setting is broken)."
            }
            (Self::Zh, P::Unknown) => "这个报错 FarAgent 还认不出来，下面是 ssh 的原始输出。",
            (Self::En, P::Unknown) => {
                "FarAgent does not recognize this failure yet; the raw ssh output is below."
            }
        }
    }

    pub fn problem_steps(
        self,
        p: crate::diagnose::Problem,
        f: &crate::diagnose::Facts,
    ) -> Vec<String> {
        use crate::diagnose::Problem as P;
        let host = f.host.as_str();
        let target = f.target.as_str();
        let port = f.port_flag();
        let port_n = f.port;
        let kh = f.known_hosts_key();
        let key = f
            .identity
            .clone()
            .unwrap_or_else(|| "~/.ssh/id_ed25519".into());
        let steps: Vec<String> = match (self, p) {
            (Self::Zh, P::SshMissing) if f.local == crate::remote::HostOs::Windows => vec![
                "先在 PowerShell 里确认：`ssh -V`；报“无法将 ssh 项识别为 cmdlet”说明没装或不在 PATH。".into(),
                "Windows 11 自带 OpenSSH 客户端，一般在 `C:\\Windows\\System32\\OpenSSH\\ssh.exe`。".into(),
                "没装的话：设置 → 系统 → 可选功能 → 添加功能 → 安装「OpenSSH 客户端」，或在管理员 PowerShell 运行 `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`。".into(),
                "装好后重开终端确认：`ssh -V` 与 `where.exe ssh` 都应成功。".into(),
            ],
            (Self::En, P::SshMissing) if f.local == crate::remote::HostOs::Windows => vec![
                "Check in PowerShell: `ssh -V`; \"not recognized as the name of a cmdlet\" means it is missing or not on PATH.".into(),
                "Windows 11 ships the OpenSSH client, usually at `C:\\Windows\\System32\\OpenSSH\\ssh.exe`.".into(),
                "If missing: Settings -> System -> Optional features -> Add a feature -> \"OpenSSH Client\", or run `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0` in an admin PowerShell.".into(),
                "Reopen the terminal and confirm: both `ssh -V` and `where.exe ssh` should succeed.".into(),
            ],
            (Self::Zh, P::SshMissing) => vec![
                "先确认有没有：`ssh -V`。macOS 自带 OpenSSH，报 command not found 说明没装或不在 PATH。".into(),
                "macOS：`xcode-select --install`，或 `brew install openssh`。".into(),
                "Debian / Ubuntu：`sudo apt-get install -y openssh-client`；Fedora：`sudo dnf install -y openssh-clients`；Arch：`sudo pacman -S openssh`。".into(),
                "装好后确认 PATH：`command -v ssh`。".into(),
            ],
            (Self::En, P::SshMissing) => vec![
                "Check whether it exists: `ssh -V`. macOS ships OpenSSH; `command not found` means it is missing or not on PATH.".into(),
                "macOS: `xcode-select --install`, or `brew install openssh`.".into(),
                "Debian / Ubuntu: `sudo apt-get install -y openssh-client`; Fedora: `sudo dnf install -y openssh-clients`; Arch: `sudo pacman -S openssh`.".into(),
                "Then confirm: `command -v ssh`.".into(),
            ],
            (Self::Zh, P::PublickeyDenied) => vec![
                format!("先看清客户端送出了哪把钥匙：`ssh -v{port} {host} true`。"),
                "确认本机有钥匙：`ls -l ~/.ssh/*.pub`。没有就生成一把：`ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`。".into(),
                format!("把公钥装到远程（这一步远程还得能用密码或别的方式登录）：`ssh-copy-id{port} -i {key}.pub {host}`。"),
                format!("在 ~/.ssh/config 的 `Host {host}` 下钉住这把钥匙：`IdentityFile {key}` 和 `IdentitiesOnly yes`。"),
                format!("远程补权限：`chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`，再看 `{target}` 上这个用户名是否正确。"),
                format!("如果这台机器只让用密码：`faragent auth --host {host} --mode password`，再 `faragent login --host {host}`（TUI 里按 a 同样可以）。"),
            ],
            (Self::En, P::PublickeyDenied) => vec![
                format!("First see which key the client offered: `ssh -v{port} {host} true`."),
                "Check you have a key: `ls -l ~/.ssh/*.pub`. If not: `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`.".into(),
                format!("Install the public key on the remote (that step still needs a working login): `ssh-copy-id{port} -i {key}.pub {host}`."),
                format!("Pin that key for this host in ~/.ssh/config: `IdentityFile {key}` plus `IdentitiesOnly yes`."),
                format!("Fix remote permissions: `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`, and check that the user exists on {target}."),
                format!("If this machine only allows passwords: `faragent auth --host {host} --mode password`, then `faragent login --host {host}` (or press a in the TUI)."),
            ],
            (Self::Zh, P::NeedsPassword) if f.local == crate::remote::HostOs::Windows => {
                let mut steps = Vec::new();
                steps.push(
                    "Windows 自带的 ssh 不支持连接复用，FarAgent 改为在内存里记住一次密码（不写盘、退出即清除），后续命令经 SSH_ASKPASS 自动应答。".into(),
                );
                steps.push(format!(
                    "在 TUI 的问题页按 a 输入密码即可；主机指纹等交互提示仍由 `faragent login --host {host}` 处理。"
                ));
                if f.mode != crate::ssh::AuthMode::Password {
                    steps.push(format!(
                        "也可以先把这台机器固定为密码模式：`faragent auth --host {host} --mode password`。"
                    ));
                }
                steps.push(
                    "更稳的做法仍是配密钥 / ssh-agent（见文档「配好密钥」），之后不再需要输入密码。".into(),
                );
                steps
            }
            (Self::En, P::NeedsPassword) if f.local == crate::remote::HostOs::Windows => {
                let mut steps = Vec::new();
                steps.push(
                    "Windows' built-in ssh cannot multiplex, so FarAgent remembers the password in memory instead (never written to disk, gone on exit) and answers ssh through SSH_ASKPASS.".into(),
                );
                steps.push(format!(
                    "Press a on the TUI problem screen to type it; host-key questions still go through `faragent login --host {host}`."
                ));
                if f.mode != crate::ssh::AuthMode::Password {
                    steps.push(format!(
                        "You can also pin this host to password mode first: `faragent auth --host {host} --mode password`."
                    ));
                }
                steps.push(
                    "Keys / ssh-agent remain the sturdier option (see \"set up keys\" in the docs).".into(),
                );
                steps
            }
            (Self::Zh, P::NeedsPassword) => {
                let mut steps = Vec::new();
                if f.mode == crate::ssh::AuthMode::Password {
                    steps.push(format!(
                        "这台主机已经是密码模式，直接做一次交互式登录：`faragent login --host {host}`。"
                    ));
                } else {
                    steps.push(format!(
                        "把这台主机切到密码模式：`faragent auth --host {host} --mode password`。"
                    ));
                    steps.push(format!(
                        "再做一次交互式登录（密码只交给系统 ssh，FarAgent 不保存）：`faragent login --host {host}`。"
                    ));
                }
                steps.push(
                    "登录成功后 FarAgent 会复用这条多路复用连接，一段时间内不再问你密码；断开或过期后再 login 一次即可。TUI 的问题页按 a 是同一件事。".into(),
                );
                steps.push(format!(
                    "更稳的做法仍然是配密钥（见文档「配好密钥」），之后用 `faragent auth --host {host} --mode auto` 切回来。"
                ));
                steps
            }
            (Self::En, P::NeedsPassword) => {
                let mut steps = Vec::new();
                if f.mode == crate::ssh::AuthMode::Password {
                    steps.push(format!(
                        "This host is already in password mode; just do one interactive login: `faragent login --host {host}`."
                    ));
                } else {
                    steps.push(format!(
                        "Switch this host to password mode: `faragent auth --host {host} --mode password`."
                    ));
                    steps.push(format!(
                        "Then do one interactive login (the password goes straight to OpenSSH; FarAgent never stores it): `faragent login --host {host}`."
                    ));
                }
                steps.push(
                    "After that FarAgent reuses the multiplexed connection, so it will not ask again for a while; log in once more when it expires. Pressing a on the TUI problem screen does the same thing.".into(),
                );
                steps.push(format!(
                    "Keys are still the sturdier option (see \"set up keys\" in the docs); then `faragent auth --host {host} --mode auto`."
                ));
                steps
            }
            (Self::Zh, P::PasswordDenied) => vec![
                format!("手工确认账号密码：`ssh{port} {host}`。"),
                format!("核对用户名：~/.ssh/config 里 `Host {host}` 的 `User` 必须是远程账号（远程 `whoami` 对不上就改）。"),
                "远程看认证日志：Linux `sudo tail -f /var/log/auth.log`（或 `journalctl -u ssh -f`）；macOS `log stream --predicate 'process == \"sshd\"'`。".into(),
                "检查 sshd 是否放行这个用户：AllowUsers / DenyUsers / PasswordAuthentication / KbdInteractiveAuthentication。".into(),
            ],
            (Self::En, P::PasswordDenied) => vec![
                format!("Verify the credentials by hand: `ssh{port} {host}`."),
                format!("Check the user: `User` under `Host {host}` in ~/.ssh/config must be the remote account (compare with `whoami` on the remote)."),
                "Read the auth log on the remote: Linux `sudo tail -f /var/log/auth.log` (or `journalctl -u ssh -f`); macOS `log stream --predicate 'process == \"sshd\"'`.".into(),
                "Check sshd allows that account: AllowUsers / DenyUsers / PasswordAuthentication / KbdInteractiveAuthentication.".into(),
            ],
            (Self::Zh, P::TooManyAuthFailures) => vec![
                "看看 agent 里装了几把：`ssh-add -l`。".into(),
                format!("在 ~/.ssh/config 的 `Host {host}` 下钉死一把：`IdentityFile {key}` 和 `IdentitiesOnly yes`。"),
                format!("直接验证效果：`ssh -o IdentitiesOnly=yes -i {key}{port} {host} true`。"),
                "清掉不用的钥匙：`ssh-add -D`，再按需 `ssh-add` 需要的那些。".into(),
            ],
            (Self::En, P::TooManyAuthFailures) => vec![
                "Count what the agent holds: `ssh-add -l`.".into(),
                format!("Pin one key for this host in ~/.ssh/config: `IdentityFile {key}` plus `IdentitiesOnly yes`."),
                format!("Verify: `ssh -o IdentitiesOnly=yes -i {key}{port} {host} true`."),
                "Drop the rest: `ssh-add -D`, then `ssh-add` only the keys you need.".into(),
            ],
            (Self::Zh, P::HostKeyUnknown) => vec![
                format!("交互式确认一次指纹（TUI 里按 a 等效）：`faragent login --host {host}`。"),
                format!("或者手工：`ssh{port} {host} true`，核对指纹后回答 yes。"),
                format!("想直接写入（务必通过可信渠道核对指纹）：`ssh-keyscan -t ed25519{port} {target} >> ~/.ssh/known_hosts`。"),
                "确认之后回到 FarAgent 重试即可。".into(),
            ],
            (Self::En, P::HostKeyUnknown) => vec![
                format!("Confirm the fingerprint once, interactively (pressing a in the TUI is the same): `faragent login --host {host}`."),
                format!("Or by hand: `ssh{port} {host} true` and answer yes after checking the fingerprint."),
                format!("To write it non-interactively (verify the fingerprint through a trusted channel first): `ssh-keyscan -t ed25519{port} {target} >> ~/.ssh/known_hosts`."),
                "Then retry in FarAgent.".into(),
            ],
            (Self::Zh, P::HostKeyChanged) => vec![
                "先判断原因：这台机器最近重装过系统、重建过云主机吗？说不清就先别继续。".into(),
                "在远程核对现在的指纹：`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`。".into(),
                format!("确认无误后删掉本机旧记录：`ssh-keygen -R {kh}`。"),
                format!("再连一次确认新指纹：`faragent login --host {host}`。"),
                "指纹变化来路不明时先查网络（DNS / 代理 / 跳板机），不要直接接受。".into(),
            ],
            (Self::En, P::HostKeyChanged) => vec![
                "First work out why: was the machine rebuilt or reinstalled recently? If not, stop here.".into(),
                "On the remote, print the current fingerprint: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.".into(),
                format!("If it matches what you expect, drop the stale entry here: `ssh-keygen -R {kh}`."),
                format!("Connect once to confirm the new key: `faragent login --host {host}`."),
                "If the change is unexplained, check the network path (DNS / proxy / bastion) instead of accepting it.".into(),
            ],
            (Self::Zh, P::PrivateFilePermissions)
                if f.local == crate::remote::HostOs::Windows =>
            {
                vec![
                    "Windows 的 OpenSSH 检查的是 ACL（不是 Unix 权限位）：先看 `icacls $env:USERPROFILE\\.ssh`。".into(),
                    "收窄到仅当前用户（管理员 PowerShell）：`icacls $env:USERPROFILE\\.ssh /inheritance:r`，再 `icacls $env:USERPROFILE\\.ssh /grant:r \"$env:USERNAME:(OI)(CI)F\"`。".into(),
                    "确认属主：`Get-Acl $env:USERPROFILE\\.ssh\\id_ed25519 | Format-List Owner`，应为当前用户，而不是 Administrators / SYSTEM。".into(),
                    format!("再试一次：`ssh -o BatchMode=yes{port} {host} echo ok`。"),
                ]
            }
            (Self::En, P::PrivateFilePermissions)
                if f.local == crate::remote::HostOs::Windows =>
            {
                vec![
                    "Windows OpenSSH checks ACLs (not Unix mode bits): start with `icacls $env:USERPROFILE\\.ssh`.".into(),
                    "Narrow it to your user only (admin PowerShell): `icacls $env:USERPROFILE\\.ssh /inheritance:r`, then `icacls $env:USERPROFILE\\.ssh /grant:r \"$env:USERNAME:(OI)(CI)F\"`.".into(),
                    "Check the owner: `Get-Acl $env:USERPROFILE\\.ssh\\id_ed25519 | Format-List Owner` should be your user, not Administrators / SYSTEM.".into(),
                    format!("Retry: `ssh -o BatchMode=yes{port} {host} echo ok`."),
                ]
            }
            (Self::Zh, P::PrivateFilePermissions) => vec![
                "`chmod 700 ~/.ssh`".into(),
                "`chmod 600 ~/.ssh/config ~/.ssh/id_ed25519 ~/.ssh/known_hosts`（换成你实际用到的文件名）".into(),
                "`chmod 644 ~/.ssh/id_ed25519.pub`".into(),
                "属主必须是当前用户：`ls -l ~/.ssh`，必要时 `sudo chown $(whoami) ~/.ssh/*`。".into(),
                format!("再试一次：`ssh -o BatchMode=yes{port} {host} true`。"),
            ],
            (Self::En, P::PrivateFilePermissions) => vec![
                "`chmod 700 ~/.ssh`".into(),
                "`chmod 600 ~/.ssh/config ~/.ssh/id_ed25519 ~/.ssh/known_hosts` (use your real filenames)".into(),
                "`chmod 644 ~/.ssh/id_ed25519.pub`".into(),
                "Ownership must be your user: `ls -l ~/.ssh`, then `sudo chown $(whoami) ~/.ssh/*` if needed.".into(),
                format!("Retry: `ssh -o BatchMode=yes{port} {host} true`."),
            ],
            (Self::Zh, P::KeyUnreadable) => vec![
                "看文件开头：`head -1 ~/.ssh/id_ed25519`，应该是 `-----BEGIN OPENSSH PRIVATE KEY-----`。".into(),
                "`IdentityFile` 只能指向私钥，不要写成 `.pub`。".into(),
                "文件确实是坏的或不是私钥：重新生成 `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`。".into(),
                format!("重新上传公钥：`ssh-copy-id{port} -i ~/.ssh/id_ed25519.pub {host}`。"),
            ],
            (Self::En, P::KeyUnreadable) => vec![
                "Look at the header: `head -1 ~/.ssh/id_ed25519` should say `-----BEGIN OPENSSH PRIVATE KEY-----`.".into(),
                "`IdentityFile` must point at the private key, never a `.pub`.".into(),
                "If the file really is broken or not a key, regenerate: `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`.".into(),
                format!("Re-upload the public key: `ssh-copy-id{port} -i ~/.ssh/id_ed25519.pub {host}`."),
            ],
            (Self::Zh, P::KeyMissing) => vec![
                "看现在的配置：`grep -n -i identityfile ~/.ssh/config`。".into(),
                "确认路径真实存在：`ls -l ~/.ssh`（`~` 只在 ssh 配置里会被展开）。".into(),
                "确实缺这把钥匙就生成：`ssh-keygen -t ed25519 -f {key}`。".into(),
                "或把 `IdentityFile` 改成你本机已有的私钥，然后重试。".into(),
            ],
            (Self::En, P::KeyMissing) => vec![
                "Inspect the config: `grep -n -i identityfile ~/.ssh/config`.".into(),
                "Check the path really exists: `ls -l ~/.ssh` (only ssh config expands `~`).".into(),
                "Generate the missing key: `ssh-keygen -t ed25519 -f {key}`.".into(),
                "Or point `IdentityFile` at a key you already have, then retry.".into(),
            ],
            (Self::Zh, P::KeyPassphrase) => vec![
                "放进 agent（macOS 可存钥匙串）：`ssh-add --apple-use-keychain ~/.ssh/id_ed25519`；Linux：`ssh-add ~/.ssh/id_ed25519`。".into(),
                "确认已加载：`ssh-add -l`。".into(),
                "macOS 想持久化：在 ~/.ssh/config 顶部加 `AddKeysToAgent yes` 与 `UseKeychain yes`。".into(),
                "不想每次输入口令：为这台机器单独生成一把无口令密钥。".into(),
            ],
            (Self::En, P::KeyPassphrase) => vec![
                "Add it to the agent (macOS can use the keychain): `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`; Linux: `ssh-add ~/.ssh/id_ed25519`.".into(),
                "Confirm it loaded: `ssh-add -l`.".into(),
                "On macOS, make it stick: add `AddKeysToAgent yes` and `UseKeychain yes` at the top of ~/.ssh/config.".into(),
                "Or make a passphrase-free key used only for this machine.".into(),
            ],
            (Self::Zh, P::DnsFailure) => vec![
                format!("看配置里现在写了什么：`grep -n -A3 -i 'host {host}' ~/.ssh/config`。"),
                format!("单独试解析：`dig +short {target}`（或 `nslookup {target}`）。"),
                "Tailscale / VPN / 公司内网名字必须先连上那张网：`tailscale status`。".into(),
                "临时办法：把可达的 IP 直接写进 `HostName`。".into(),
            ],
            (Self::En, P::DnsFailure) => vec![
                format!("See what the config says now: `grep -n -A3 -i 'host {host}' ~/.ssh/config`."),
                format!("Resolve it on its own: `dig +short {target}` (or `nslookup {target}`)."),
                "Tailscale / VPN / internal names need that network first: `tailscale status`.".into(),
                "Workaround: put a reachable IP straight into `HostName`.".into(),
            ],
            (Self::Zh, P::ConnectionRefused) => vec![
                format!("确认端口：`grep -n -A3 -i 'host {host}' ~/.ssh/config`（默认 22，改过就要写 `Port`）。"),
                format!("从本机探端口：`nc -vz {target} {port_n}`。"),
                "远程确认服务在跑：Linux `sudo systemctl status ssh`；macOS「系统设置 → 通用 → 共享 → 远程登录」。".into(),
                format!("云安全组 / 本机防火墙要放行 TCP {port_n}。"),
            ],
            (Self::En, P::ConnectionRefused) => vec![
                format!("Check the port: `grep -n -A3 -i 'host {host}' ~/.ssh/config` (default 22; a custom port needs `Port`)."),
                format!("Probe the port from here: `nc -vz {target} {port_n}`."),
                "Confirm the service runs on the remote: Linux `sudo systemctl status ssh`; macOS System Settings -> General -> Sharing -> Remote Login.".into(),
                format!("Allow TCP {port_n} in the cloud security group / local firewall."),
            ],
            (Self::Zh, P::ConnectionTimeout) => vec![
                format!("先看能不能到：`ping -c 2 {target}` 与 `nc -vz {target} {port_n}`。"),
                "局域网地址出了那张网就不通：出门要改用 Tailscale 或公网 IP / 域名。".into(),
                format!("云安全组 / 路由器端口转发是否放行 {port_n}（家宽在 NAT / CGNAT 后面时端口转发无效）。"),
                format!("端口能通但一直卡住，多半是远程登录壳里有等待输入的命令：`ssh{port} {host} -- bash -lc 'echo ok'`，检查 ~/.bashrc 与 ~/.bash_profile。"),
                format!("手工复现看细节：`ssh -v{port} {host} true`。"),
            ],
            (Self::En, P::ConnectionTimeout) => vec![
                format!("See whether the host answers at all: `ping -c 2 {target}` and `nc -vz {target} {port_n}`."),
                "A LAN address stops working off that network: use Tailscale or a public IP / domain instead.".into(),
                format!("Allow {port_n} in the cloud security group / router port forwarding (forwarding does nothing behind NAT or CGNAT)."),
                format!("If the port answers but ssh hangs, the remote login shell is probably waiting for input: `ssh{port} {host} -- bash -lc 'echo ok'`, then check ~/.bashrc and ~/.bash_profile."),
                format!("Reproduce with detail: `ssh -v{port} {host} true`."),
            ],
            (Self::Zh, P::NoRoute) => vec![
                format!("`ping -c 2 {target}`"),
                "确认你在对的网里：局域网地址只在家里 / 办公室那张网有效。".into(),
                "用 Tailscale / VPN 时先看状态：`tailscale status`。".into(),
                "换个入口：改用公网 IP / 域名，或把 `HostName` 换成可达地址。".into(),
            ],
            (Self::En, P::NoRoute) => vec![
                format!("`ping -c 2 {target}`"),
                "Confirm you are on the right network: a LAN address only works on that LAN.".into(),
                "With Tailscale / VPN, check state first: `tailscale status`.".into(),
                "Try another path: a public IP / domain, or set `HostName` to a reachable address.".into(),
            ],
            (Self::Zh, P::KexClosed) => vec![
                "刚连续失败过很多次？等几分钟再试（fail2ban 类封禁会自己解封）。".into(),
                "远程确认 sshd 真的在跑：`sudo systemctl status ssh` 或 `sudo /usr/sbin/sshd -T | head`。".into(),
                "云厂商安全组、TCP wrapper（/etc/hosts.allow、/etc/hosts.deny）是否拦了本机 IP。".into(),
                format!("看完整握手过程：`ssh -vvv{port} {host} true`。"),
            ],
            (Self::En, P::KexClosed) => vec![
                "Many failures in a row just now? Wait a few minutes (fail2ban-style bans expire).".into(),
                "Confirm sshd really runs: `sudo systemctl status ssh` or `sudo /usr/sbin/sshd -T | head`.".into(),
                "Check cloud security groups and TCP wrappers (/etc/hosts.allow, /etc/hosts.deny) for your IP.".into(),
                format!("Watch the full handshake: `ssh -vvv{port} {host} true`."),
            ],
            (Self::Zh, P::VersionMismatch) => vec![
                format!("看服务端到底提供什么：`ssh -v{port} {host} true`，注意 `Their offer:` 那一行。"),
                format!("临时放开一次：`ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa{port} {host} true`。"),
                format!("能用就把同样的选项写进 ~/.ssh/config 的 `Host {host}` 段，FarAgent 会自动沿用。"),
                "根治办法是升级远程的 OpenSSH。".into(),
            ],
            (Self::En, P::VersionMismatch) => vec![
                format!("See what the server offers: `ssh -v{port} {host} true`, look at the `Their offer:` line."),
                format!("Loosen it once: `ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa{port} {host} true`."),
                format!("If that works, put the same options under `Host {host}` in ~/.ssh/config and FarAgent will pick them up."),
                "The real fix is upgrading OpenSSH on the remote.".into(),
            ],
            (Self::Zh, P::RemoteBash) => vec![
                format!("确认远程有 bash：`ssh{port} {host} -- bash -lc 'echo ok'`。"),
                "确认登录壳不卡：~/.bashrc、~/.bash_profile 里不要有等待输入的命令（read、ssh-add、sudo 等）。".into(),
                "远程只有 sh / zsh 时先装 bash：Debian / Ubuntu `sudo apt-get install -y bash`；Fedora `sudo dnf install -y bash`。".into(),
                format!("看登录壳细节：`ssh{port} {host} -- bash -lc 'echo $SHELL; command -v bash; echo $PATH'`。"),
            ],
            (Self::En, P::RemoteBash) => vec![
                format!("Confirm bash exists remotely: `ssh{port} {host} -- bash -lc 'echo ok'`."),
                "Make sure the login shell does not block: no commands that wait for input in ~/.bashrc or ~/.bash_profile (read, ssh-add, sudo, ...).".into(),
                "If only sh / zsh exists, install bash: Debian / Ubuntu `sudo apt-get install -y bash`; Fedora `sudo dnf install -y bash`.".into(),
                format!("Inspect the login shell: `ssh{port} {host} -- bash -lc 'echo $SHELL; command -v bash; echo $PATH'`."),
            ],
            (Self::Zh, P::RemoteShellUnsupported) => vec![
                format!("先看原样输出：`ssh{port} {host} echo FARAGENT_OS_V1`。"),
                "Windows 远端：sshd 的默认 shell 必须可用（默认是 cmd.exe；改坏过就改回来：`New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value 'C:\\Windows\\System32\\cmd.exe' -PropertyType String -Force`，然后 `Restart-Service sshd`）。".into(),
                "Linux/macOS 远端：登录 shell 必须存在且可执行（`echo $SHELL`；不对就 `chsh -s /bin/bash <user>`），/etc/passwd 里的 shell 也不能指向已删除的程序。".into(),
                format!("确认最基本的命令能跑通：`ssh{port} {host} echo ok`。"),
            ],
            (Self::En, P::RemoteShellUnsupported) => vec![
                format!("See the raw output first: `ssh{port} {host} echo FARAGENT_OS_V1`."),
                "Windows remote: sshd's default shell must work (cmd.exe by default; if it broke, restore it: `New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value 'C:\\Windows\\System32\\cmd.exe' -PropertyType String -Force`, then `Restart-Service sshd`).".into(),
                "Linux/macOS remote: the login shell must exist and be executable (`echo $SHELL`; fix with `chsh -s /bin/bash <user>`), and /etc/passwd must not point at a deleted program.".into(),
                format!("Confirm the most basic command runs: `ssh{port} {host} echo ok`."),
            ],
            (Self::Zh, P::Unknown) => vec![
                format!("详细模式复现：`ssh -vvv{port} {host} true`。"),
                format!("`faragent doctor --host {host}` 会一起打印本机 ssh、主机列表和远程探测结果。"),
                "把原始输出贴到 https://github.com/mahingbun-dev/FarAgent/issues。".into(),
                "通用排查步骤见文档 docs/zh/ssh-access.md。".into(),
            ],
            (Self::En, P::Unknown) => vec![
                format!("Reproduce with detail: `ssh -vvv{port} {host} true`."),
                format!("`faragent doctor --host {host}` prints the local ssh, the host list and the remote probe together."),
                "Paste the raw output into https://github.com/mahingbun-dev/FarAgent/issues.".into(),
                "General walkthrough: docs/en/ssh-access.md.".into(),
            ],
        };
        steps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_aliases() {
        assert_eq!(Lang::parse("zh-CN"), Some(Lang::Zh));
        assert_eq!(Lang::parse("en"), Some(Lang::En));
        assert_eq!(Lang::parse("nope"), None);
    }
}

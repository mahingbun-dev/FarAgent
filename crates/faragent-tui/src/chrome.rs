//! Terminal-UI chrome wording: screen titles, key hints, status lines and
//! empty states. Everything here is only ever rendered by the faragent TUI —
//! wording that belongs to a feature (diagnosis, install plans, auth) lives
//! with that feature module instead, and feature wording that a GUI also
//! needs is produced as `LocalizedText` by those modules.
//!
//! Defined as an extension trait so call sites read `lang.hosts_title()`
//! while the methods can live next to the UI that renders them.

use faragent_core::text::Lang;
use faragent_core::vocab::HostOs;
use faragent_remote::remote::new_dir_command;

pub trait Chrome {
    fn hosts_title(self) -> &'static str;
    fn agents_title(self, host: &str) -> String;
    fn sessions_title(self, host: &str, agent: &str) -> String;
    fn new_cwd_title(self) -> &'static str;
    fn new_dir_title(self, dir: &str) -> String;
    fn new_dir_list_title(self) -> &'static str;
    /// Body of the confirmation screen. The command that will run sits at
    /// `new_dir_cmd_index()` and is highlighted there.
    fn new_dir_lines(self, dir: &str, os: HostOs) -> Vec<String>;
    /// Index into `new_dir_lines(..)` of the command line to highlight.
    fn new_dir_cmd_index(self) -> usize;
    fn new_dir_keys_hint(self) -> &'static str;
    fn dir_missing_status(self) -> &'static str;
    fn dir_creating(self, dir: &str) -> String;
    fn language_title(self) -> &'static str;
    fn hosts_list_title(self) -> &'static str;
    fn agents_list_title(self) -> &'static str;
    fn sessions_list_title(self, os: HostOs) -> &'static str;
    fn cwd_block_title(self) -> &'static str;
    fn dir_picker_title(self) -> &'static str;
    fn dir_recent_label(self, path: &str) -> String;
    fn new_cwd_keys_hint(self) -> &'static str;
    fn full_permissions_status(self, on: bool) -> &'static str;
    fn full_permissions_tag(self, on: bool) -> &'static str;
    fn language_list_title(self) -> &'static str;
    fn keys_hint(self) -> &'static str;
    /// Footer for the session screens. On Windows remotes the agent runs in
    /// the foreground: there is no detach — quitting the agent ends it, and
    /// the conversation comes back through resume.
    fn keys_hint_os(self, os: HostOs) -> &'static str;
    fn hosts_keys_hint(self) -> &'static str;
    fn agents_keys_hint(self) -> &'static str;
    fn confirm_keys_hint(self, can_run: bool) -> &'static str;
    fn language_keys_hint(self) -> &'static str;
    fn status_ready(self) -> &'static str;
    fn status_help(self) -> &'static str;
    fn no_hosts(self) -> &'static str;
    fn host_count(self, n: usize) -> String;
    fn probing(self, host: &str) -> String;
    fn probe_failed(self, host: &str) -> String;
    fn select_agent(self) -> &'static str;
    fn sessions_status(self) -> &'static str;
    fn session_count(self, n: usize) -> String;
    fn no_sessions(self) -> &'static str;
    fn sessions_status_os(self, os: HostOs) -> &'static str;
    fn running_confirm_title(self, host: &str) -> String;
    fn running_confirm_lines(self, title: &str) -> Vec<String>;
    fn running_confirm_keys_hint(self) -> &'static str;
    fn session_warning_block_title(self) -> &'static str;
    fn cancelled(self) -> &'static str;
    fn cwd_required(self) -> &'static str;
    fn type_cwd(self) -> &'static str;
    fn probe_host_first(self) -> &'static str;
    fn attaching(self, tmux: &str) -> String;
    fn detached(self) -> &'static str;
    /// Windows remote: the agent runs in the foreground of this connection.
    fn attaching_resume(self, name: &str) -> String;
    fn session_ended(self) -> &'static str;
    fn ssh_exited(self, code: i32) -> String;
    fn language_saved(self) -> String;
    fn language_save_failed(self, err: &str) -> String;
    fn clipboard_ok(self) -> &'static str;
    fn clipboard_failed(self) -> &'static str;
    /// Title of the in-memory password prompt (used when this machine's ssh
    /// cannot multiplex, e.g. Win32 OpenSSH).
    fn password_title(self) -> &'static str;
    fn password_prompt(self, host: &str) -> String;
    fn password_keys_hint(self) -> &'static str;
    fn password_required(self) -> &'static str;
    fn password_stored(self, host: &str) -> String;
    fn problem_keys_hint(self) -> &'static str;
    fn problem_status(self, needs_auth: bool) -> &'static str;
    fn problem_status_timeout(self) -> &'static str;
}

impl Chrome for Lang {
    fn hosts_title(self) -> &'static str {
        match self {
            Self::Zh => "FarAgent · 主机",
            Self::En => "FarAgent · hosts",
        }
    }

    fn agents_title(self, host: &str) -> String {
        match self {
            Self::Zh => format!("FarAgent · {host} · 编程助手"),
            Self::En => format!("FarAgent · {host} · agents"),
        }
    }

    fn sessions_title(self, host: &str, agent: &str) -> String {
        format!("FarAgent · {host} · {agent}")
    }

    fn new_cwd_title(self) -> &'static str {
        match self {
            Self::Zh => "FarAgent · 新建会话 · 工作目录",
            Self::En => "FarAgent · new session · working directory",
        }
    }

    fn new_dir_title(self, dir: &str) -> String {
        match self {
            Self::Zh => format!("FarAgent · {dir} 不存在"),
            Self::En => format!("FarAgent · {dir} does not exist"),
        }
    }

    fn new_dir_list_title(self) -> &'static str {
        match self {
            Self::Zh => "目录不存在，是否创建？",
            Self::En => "directory missing - create it?",
        }
    }

    fn new_dir_lines(self, dir: &str, os: HostOs) -> Vec<String> {
        let cmd = new_dir_command(dir, os);
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

    fn new_dir_cmd_index(self) -> usize {
        5
    }

    fn new_dir_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 创建并开始 · Esc 返回修改路径",
            Self::En => "enter create and start · esc back to the path",
        }
    }

    fn dir_missing_status(self) -> &'static str {
        match self {
            Self::Zh => "远程没有这个目录：回车创建并开始，Esc 返回修改",
            Self::En => "directory missing on the remote: enter creates it, esc edits the path",
        }
    }

    fn dir_creating(self, dir: &str) -> String {
        match self {
            Self::Zh => format!("正在远程创建 {dir} 并启动会话…"),
            Self::En => format!("creating {dir} on the remote and starting the session…"),
        }
    }

    fn language_title(self) -> &'static str {
        "FarAgent · language / 语言"
    }

    fn hosts_list_title(self) -> &'static str {
        match self {
            Self::Zh => "SSH 主机（~/.ssh/config）",
            Self::En => "SSH hosts (~/.ssh/config)",
        }
    }

    fn agents_list_title(self) -> &'static str {
        match self {
            Self::Zh => "编程助手",
            Self::En => "coding agents",
        }
    }

    fn sessions_list_title(self, os: HostOs) -> &'static str {
        match (self, os) {
            (Self::Zh, HostOs::Posix) => "会话  [live]=tmux 仍在运行",
            (Self::En, HostOs::Posix) => "sessions  [live]=tmux still running",
            (Self::Zh, HostOs::Windows) => "会话  [running]=可能有进程仍在运行",
            (Self::En, HostOs::Windows) => "sessions  [running]=a process may still be running",
        }
    }

    fn cwd_block_title(self) -> &'static str {
        match self {
            Self::Zh => "新会话的工作目录（agent 读写代码的地方，不是新建文件夹）",
            Self::En => {
                "working directory for the new session (where the agent runs - not a new folder)"
            }
        }
    }

    fn dir_picker_title(self) -> &'static str {
        match self {
            Self::Zh => "最近目录 · .. 上级 · 子目录",
            Self::En => "recent · .. parent · children",
        }
    }

    fn dir_recent_label(self, path: &str) -> String {
        match self {
            Self::Zh => format!("最近  {path}"),
            Self::En => format!("recent  {path}"),
        }
    }

    fn new_cwd_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "j/k 选择 · 回车进入目录 · s 在此启动 · Tab 刷新 · p 完全权限 · Esc 返回",
            Self::En => {
                "j/k select · enter open dir · s start here · tab refresh · p full permissions · esc back"
            }
        }
    }

    fn full_permissions_status(self, on: bool) -> &'static str {
        match (self, on) {
            (Self::Zh, true) => "完全权限（新会话跳过确认）",
            (Self::En, true) => "full permissions (new sessions skip prompts)",
            (Self::Zh, false) => "需确认（新会话走 agent 默认权限）",
            (Self::En, false) => "confirm required (new sessions use the agent's default prompts)",
        }
    }

    fn full_permissions_tag(self, on: bool) -> &'static str {
        match (self, on) {
            (Self::Zh, true) => "完全权限",
            (Self::En, true) => "full permissions",
            (Self::Zh, false) => "需确认",
            (Self::En, false) => "confirm required",
        }
    }

    fn language_list_title(self) -> &'static str {
        "Select language / 选择语言"
    }

    fn keys_hint(self) -> &'static str {
        match self {
            Self::Zh => {
                "回车 打开 · n 新建会话 · p 完全权限 · r 刷新 · L 语言 · q 返回 · 助手内断开: C-g d"
            }
            Self::En => {
                "enter open · n new session · p full permissions · r refresh · L language · q back · agent detach: C-g d"
            }
        }
    }

    fn keys_hint_os(self, os: HostOs) -> &'static str {
        match os {
            HostOs::Posix => self.keys_hint(),
            HostOs::Windows => match self {
                Self::Zh => {
                    "回车 打开 · n 新建会话 · p 完全权限 · r 刷新 · L 语言 · q 返回 · 退出助手即结束（可 resume 恢复）"
                }
                Self::En => {
                    "enter open · n new session · p full permissions · r refresh · L language · q back · quitting the agent ends it (resume later)"
                }
            },
        }
    }

    fn hosts_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => {
                "回车 探测 · g 登录方式（密钥/密码）· G 同步 GitHub · r 刷新 · L 语言 · q 退出"
            }
            Self::En => {
                "enter probe · g auth mode (key/password) · G sync GitHub · r refresh · L language · q quit"
            }
        }
    }

    fn agents_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => {
                "回车 会话/安装 · U 升级 · X 卸载 · r 刷新 · q 返回 · 助手内断开: C-g d"
            }
            Self::En => {
                "enter sessions/install · U upgrade · X uninstall · r refresh · q back · detach: C-g d"
            }
        }
    }

    fn confirm_keys_hint(self, can_run: bool) -> &'static str {
        match (self, can_run) {
            (Self::Zh, true) => "回车 执行（过程会直播） · Esc 取消",
            (Self::En, true) => "enter run (live PTY) · esc cancel",
            (Self::Zh, false) => "无法执行 · Esc 返回（下方有可复制命令）",
            (Self::En, false) => "cannot run · esc back (copy-paste commands below)",
        }
    }

    fn language_keys_hint(self) -> &'static str {
        "↑↓  j/k   Enter  confirm / 确认   q  quit"
    }

    fn status_ready(self) -> &'static str {
        match self {
            Self::Zh => {
                "回车探测 · g 登录方式（密钥/密码）· G 同步 GitHub · r 刷新 · L 语言 · q 退出"
            }
            Self::En => {
                "enter probe · g auth mode (key/password) · G sync GitHub · r refresh · L language · q quit"
            }
        }
    }

    fn status_help(self) -> &'static str {
        match self {
            Self::Zh => {
                "j/k 移动 · 回车打开 · n 新会话 · p 完全权限 · g 登录方式 · G 同步 GitHub · r 刷新 · L 语言 · q 返回 · 助手内断开: C-g d"
            }
            Self::En => {
                "j/k move · enter open · n new session · p full permissions · g auth mode · G sync GitHub · r refresh · L language · q back · detach in agent: C-g d"
            }
        }
    }

    fn no_hosts(self) -> &'static str {
        match self {
            Self::Zh => " ~/.ssh/config 里没有具体 Host（通配符会被忽略）。",
            Self::En => "No concrete Host entries in ~/.ssh/config (wildcards ignored).",
        }
    }

    fn host_count(self, n: usize) -> String {
        match self {
            Self::Zh => format!("{n} 台主机"),
            Self::En => format!("{n} hosts"),
        }
    }

    fn probing(self, host: &str) -> String {
        match self {
            Self::Zh => format!("正在探测 {host}…"),
            Self::En => format!("probing {host}…"),
        }
    }

    fn probe_failed(self, host: &str) -> String {
        match self {
            Self::Zh => format!("探测 {host} 失败（错误见下方，回车可重试）"),
            Self::En => format!("probe {host} failed (see error below; Enter retries)"),
        }
    }

    fn select_agent(self) -> &'static str {
        match self {
            Self::Zh => "选择助手 · 回车进入会话或安装 · U 升级 · X 卸载",
            Self::En => "select an agent · enter sessions or install · U upgrade · X uninstall",
        }
    }

    fn sessions_status(self) -> &'static str {
        match self {
            Self::Zh => "回车接入/恢复 · n 新建会话 · p 完全权限 · live 会话只 attach",
            Self::En => {
                "enter attach/resume · n new session · p full permissions · live sessions attach only"
            }
        }
    }

    fn session_count(self, n: usize) -> String {
        match self {
            Self::Zh => format!("{n} 个会话"),
            Self::En => format!("{n} sessions"),
        }
    }

    fn no_sessions(self) -> &'static str {
        match self {
            Self::Zh => "（暂无会话 — 按 n 新建会话）",
            Self::En => "(no sessions — press n for a new session)",
        }
    }

    fn sessions_status_os(self, os: HostOs) -> &'static str {
        match os {
            HostOs::Posix => self.sessions_status(),
            HostOs::Windows => match self {
                Self::Zh => {
                    "回车启动/恢复 · n 新建会话 · p 完全权限 · running 表示可能有进程在跑"
                }
                Self::En => {
                    "enter start/resume · n new session · p full permissions · running means a process may be alive"
                }
            },
        }
    }

    fn running_confirm_title(self, host: &str) -> String {
        match self {
            Self::Zh => format!("FarAgent · {host} · 该会话可能在运行"),
            Self::En => format!("FarAgent · {host} · session may be running"),
        }
    }

    fn running_confirm_lines(self, title: &str) -> Vec<String> {
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

    fn running_confirm_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 仍然进入 · Esc 返回列表",
            Self::En => "enter open anyway · esc back",
        }
    }

    fn session_warning_block_title(self) -> &'static str {
        match self {
            Self::Zh => "可能的双开冲突",
            Self::En => "possible double-open conflict",
        }
    }

    fn cancelled(self) -> &'static str {
        match self {
            Self::Zh => "已取消",
            Self::En => "cancelled",
        }
    }

    fn cwd_required(self) -> &'static str {
        match self {
            Self::Zh => "必须填写远程目录",
            Self::En => "cwd is required",
        }
    }

    fn type_cwd(self) -> &'static str {
        match self {
            Self::Zh => {
                "j/k 选择目录，回车进入，s 在当前路径启动；不存在会问你是否创建（Esc 取消）"
            }
            Self::En => {
                "j/k select a directory, enter opens it, s starts in the current path; if missing you will be asked to create it (esc cancels)"
            }
        }
    }

    fn probe_host_first(self) -> &'static str {
        match self {
            Self::Zh => "请先探测主机",
            Self::En => "probe the host first",
        }
    }

    fn attaching(self, tmux: &str) -> String {
        match self {
            Self::Zh => format!("正在接入 {tmux}  （断开: C-g d）"),
            Self::En => format!("attaching {tmux}  (detach: C-g d)"),
        }
    }

    fn detached(self) -> &'static str {
        match self {
            Self::Zh => "已断开 · 会话仍在远程运行",
            Self::En => "detached · session stays alive on the remote",
        }
    }

    fn attaching_resume(self, name: &str) -> String {
        match self {
            Self::Zh => format!("正在启动 {name}（前台运行 · 退出即结束，可 resume 恢复）"),
            Self::En => format!("starting {name} (foreground · quitting ends it; resume later)"),
        }
    }

    fn session_ended(self) -> &'static str {
        match self {
            Self::Zh => "会话已结束 · 回车可 resume 恢复",
            Self::En => "session ended · enter resumes it later",
        }
    }

    fn ssh_exited(self, code: i32) -> String {
        match self {
            Self::Zh => format!("ssh/tmux 退出码 {code}"),
            Self::En => format!("ssh/tmux exited {code}"),
        }
    }

    fn language_saved(self) -> String {
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

    fn language_save_failed(self, err: &str) -> String {
        match self {
            Self::Zh => format!("无法写入 ~/.faragent/config.json: {err}"),
            Self::En => format!("could not write ~/.faragent/config.json: {err}"),
        }
    }

    fn clipboard_ok(self) -> &'static str {
        match self {
            Self::Zh => "已复制到剪贴板",
            Self::En => "copied to clipboard",
        }
    }

    fn clipboard_failed(self) -> &'static str {
        match self {
            Self::Zh => "本机没有 pbcopy / wl-copy / xclip，无法复制",
            Self::En => "no pbcopy / wl-copy / xclip on this machine; cannot copy",
        }
    }

    fn password_title(self) -> &'static str {
        match self {
            Self::Zh => "FarAgent · 密码",
            Self::En => "FarAgent · password",
        }
    }

    fn password_prompt(self, host: &str) -> String {
        match self {
            Self::Zh => format!(
                "输入 {host} 的登录密码。只保存在本次运行的进程内存里，不写盘、退出即清除；ssh 经 SSH_ASKPASS 读取，不再逐条命令提示。"
            ),
            Self::En => format!(
                "Password for {host}. Kept in this process only - never written to disk, gone when faragent exits. ssh reads it through SSH_ASKPASS."
            ),
        }
    }

    fn password_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 确认 · Esc 取消 · 输入不显示",
            Self::En => "enter confirm · esc cancel · input is hidden",
        }
    }

    fn password_required(self) -> &'static str {
        match self {
            Self::Zh => "密码不能为空",
            Self::En => "password must not be empty",
        }
    }

    fn password_stored(self, host: &str) -> String {
        match self {
            Self::Zh => format!("{host} 的密码已记住（仅本次运行）"),
            Self::En => format!("password remembered for {host} (this run only)"),
        }
    }

    fn problem_keys_hint(self) -> &'static str {
        match self {
            Self::Zh => {
                "j/k 滚动 · a 交互式登录（确认指纹 / 输密码）· r 重试 · y 复制全文 · esc 返回"
            }
            Self::En => {
                "j/k scroll · a interactive login (host key / password) · r retry · y copy · esc back"
            }
        }
    }

    fn problem_status(self, needs_auth: bool) -> &'static str {
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

    fn problem_status_timeout(self) -> &'static str {
        match self {
            Self::Zh => {
                "等待超时：网络不通或远程登录壳挂住都可能 —— 按 r 重试，或按 a 交互式登录看实时输出"
            }
            Self::En => {
                "timed out: either the network is dead or the remote login shell hangs - press r to retry, or a to watch an interactive login"
            }
        }
    }
}

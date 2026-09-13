//! UI language. Chosen once, stored in `~/.farssh/config.json`.

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
            Self::Zh => "FarSSH · 主机",
            Self::En => "FarSSH · hosts",
        }
    }

    pub fn agents_title(self, host: &str) -> String {
        match self {
            Self::Zh => format!("FarSSH · {host} · 编程助手"),
            Self::En => format!("FarSSH · {host} · agents"),
        }
    }

    pub fn sessions_title(self, host: &str, agent: &str) -> String {
        format!("FarSSH · {host} · {agent}")
    }

    pub fn new_cwd_title(self) -> &'static str {
        match self {
            Self::Zh => "FarSSH · 新会话 · 远程目录",
            Self::En => "FarSSH · new session · remote cwd",
        }
    }

    pub fn language_title(self) -> &'static str {
        "FarSSH · language / 语言"
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

    pub fn sessions_list_title(self) -> &'static str {
        match self {
            Self::Zh => "会话  [live]=tmux 仍在运行",
            Self::En => "sessions  [live]=tmux still running",
        }
    }

    pub fn cwd_block_title(self) -> &'static str {
        match self {
            Self::Zh => "远程工作目录",
            Self::En => "remote working directory",
        }
    }

    pub fn language_list_title(self) -> &'static str {
        "Select language / 选择语言"
    }

    pub fn keys_hint(self) -> &'static str {
        match self {
            Self::Zh => "回车 打开 · n 新建 · r 刷新 · L 语言 · q 返回 · 助手内断开: C-g d",
            Self::En => {
                "enter open · n new · r refresh · L language · q back · agent detach: C-g d"
            }
        }
    }

    pub fn language_keys_hint(self) -> &'static str {
        "↑↓  j/k   Enter  confirm / 确认   q  quit"
    }

    pub fn status_ready(self) -> &'static str {
        match self {
            Self::Zh => "回车选择 · q 退出 · r 刷新 · L 语言 · ? 帮助",
            Self::En => "enter select · q quit · r refresh · L language · ? help",
        }
    }

    pub fn status_help(self) -> &'static str {
        match self {
            Self::Zh => {
                "j/k 移动 · 回车打开 · n 新会话 · r 刷新 · L 语言 · q 返回 · 助手内断开: C-g d"
            }
            Self::En => {
                "j/k move · enter open · n new session · r refresh · L language · q back · detach in agent: C-g d"
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
            Self::Zh => "选择助手 · 回车进入会话 · q 返回",
            Self::En => "select an agent · enter sessions · q back",
        }
    }

    pub fn sessions_status(self) -> &'static str {
        match self {
            Self::Zh => "回车接入/恢复 · n 新建 · live 会话只 attach",
            Self::En => "enter attach/resume · n new · live sessions attach only",
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
            Self::Zh => "（暂无会话 — 按 n 新建）",
            Self::En => "(no sessions — press n to start one)",
        }
    }

    pub fn live(self) -> &'static str {
        "live"
    }

    pub fn idle(self) -> &'static str {
        "idle"
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
            Self::Zh => "输入远程目录，回车开始，Esc 取消",
            Self::En => "type a remote directory, enter to start, esc to cancel",
        }
    }

    pub fn probe_host_first(self) -> &'static str {
        match self {
            Self::Zh => "请先探测主机",
            Self::En => "probe the host first",
        }
    }

    pub fn tmux_missing(self) -> &'static str {
        match self {
            Self::Zh => "远程未安装 tmux。请自行安装，farssh 不会代装。",
            Self::En => {
                "tmux is not installed on the remote. Install it yourself; farssh will not."
            }
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

    pub fn agent_not_installed(self, name: &str) -> String {
        match self {
            Self::Zh => format!("{name} 未安装"),
            Self::En => format!("{name} is not installed"),
        }
    }

    pub fn not_installed(self) -> &'static str {
        match self {
            Self::Zh => "未安装",
            Self::En => "not installed",
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

    pub fn ssh_exited(self, code: i32) -> String {
        match self {
            Self::Zh => format!("ssh/tmux 退出码 {code}"),
            Self::En => format!("ssh/tmux exited {code}"),
        }
    }

    pub fn language_saved(self) -> String {
        match self {
            Self::Zh => format!(
                "界面语言已保存到 ~/.farssh/config.json（{}）。之后不会再问。",
                self.native_name()
            ),
            Self::En => format!(
                "Language saved to ~/.farssh/config.json ({}). Won't ask again.",
                self.native_name()
            ),
        }
    }

    pub fn language_save_failed(self, err: &str) -> String {
        match self {
            Self::Zh => format!("无法写入 ~/.farssh/config.json: {err}"),
            Self::En => format!("could not write ~/.farssh/config.json: {err}"),
        }
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

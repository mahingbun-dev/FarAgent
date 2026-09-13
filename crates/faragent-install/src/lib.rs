//! Build a remote install / upgrade / uninstall plan on the laptop.
//! Official URLs are hardcoded here. The remote never supplies the script.

use anyhow::{anyhow, Result};
use faragent_core::agents::AgentKind;
use faragent_core::shell::shell_single_quote;
use faragent_core::text::LocalizedText;
use faragent_core::vocab::HostOs;
use faragent_remote::win;
use faragent_transport::{host_os, OpenSshTransport};

pub const CLAUDE_INSTALL: &str = "curl -fsSL https://claude.ai/install.sh | bash";
pub const CODEX_INSTALL: &str = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
pub const GROK_INSTALL: &str = "curl -fsSL https://x.ai/cli/install.sh | bash";
pub const PI_INSTALL: &str = "curl -fsSL https://pi.dev/install.sh | sh";

/// Official Windows installers (PowerShell). Same "official only" rule as the
/// POSIX side; all of them install per-user, no admin needed.
pub const CLAUDE_INSTALL_PS1: &str = "irm https://claude.ai/install.ps1 | iex";
pub const CODEX_INSTALL_PS1: &str = "irm https://chatgpt.com/codex/install.ps1 | iex";
pub const GROK_INSTALL_PS1: &str = "irm https://x.ai/cli/install.ps1 | iex";
pub const PI_INSTALL_PS1: &str = "irm https://pi.dev/install.ps1 | iex";

pub const NODE_LTS_WINGET: &str =
    "winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements";

pub const NVM_INSTALL: &str =
    "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash";
pub const NVM_NODE_LTS: &str = "nvm install --lts";

pub const NPM_CLAUDE: &str = "@anthropic-ai/claude-code";
pub const NPM_CODEX: &str = "@openai/codex";
pub const NPM_GROK: &str = "@xai-official/grok";
pub const NPM_PI: &str = "@earendil-works/pi-coding-agent";

pub const SUGGESTED_TMUX: &[&str] = &[
    "sudo apt-get update && sudo apt-get install -y tmux",
    "brew install tmux",
    "sudo dnf install -y tmux",
    "sudo yum install -y tmux",
    "sudo pacman -S --noconfirm tmux",
    "sudo apk add tmux",
];

pub const SUGGESTED_CURL: &[&str] = &[
    "sudo apt-get update && sudo apt-get install -y curl",
    "brew install curl",
    "sudo dnf install -y curl",
    "sudo yum install -y curl",
    "sudo pacman -S --noconfirm curl",
    "sudo apk add curl",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Install,
    Upgrade,
    Uninstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PkgManager {
    Brew,
    AptGet,
    Apt,
    Dnf,
    Yum,
    Pacman,
    Apk,
    Winget,
}

impl PkgManager {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "brew" => Some(Self::Brew),
            "apt-get" => Some(Self::AptGet),
            "apt" => Some(Self::Apt),
            "dnf" => Some(Self::Dnf),
            "yum" => Some(Self::Yum),
            "pacman" => Some(Self::Pacman),
            "apk" => Some(Self::Apk),
            "winget" => Some(Self::Winget),
            _ => None,
        }
    }

    #[allow(dead_code)]
    pub fn slug(self) -> &'static str {
        match self {
            Self::Brew => "brew",
            Self::AptGet => "apt-get",
            Self::Apt => "apt",
            Self::Dnf => "dnf",
            Self::Yum => "yum",
            Self::Pacman => "pacman",
            Self::Apk => "apk",
            Self::Winget => "winget",
        }
    }

    /// `(command, needs_sudo)` — winget installs per-user, never sudo.
    pub fn install_cmd(self, pkg: &str) -> (String, bool) {
        match self {
            Self::Brew => (format!("brew install {pkg}"), false),
            Self::AptGet => (
                format!("sudo apt-get update && sudo apt-get install -y {pkg}"),
                true,
            ),
            Self::Apt => (
                format!("sudo apt update && sudo apt install -y {pkg}"),
                true,
            ),
            Self::Dnf => (format!("sudo dnf install -y {pkg}"), true),
            Self::Yum => (format!("sudo yum install -y {pkg}"), true),
            Self::Pacman => (format!("sudo pacman -S --noconfirm {pkg}"), true),
            Self::Apk => (format!("sudo apk add {pkg}"), true),
            Self::Winget => (
                format!(
                    "winget install -e --id {pkg} --accept-source-agreements --accept-package-agreements"
                ),
                false,
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Warning {
    LiveTmux,
    TmuxSkippedNoPkg,
    NeedsSudo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blocked {
    NoCurlNoPkg,
    TmuxOnlyNoPkg,
    NotInstalled,
    NothingToDo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub title: String,
    pub command: String,
    pub sudo: bool,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub action: Action,
    pub agent: AgentKind,
    pub steps: Vec<Step>,
    pub script: String,
    pub blocked: Option<Blocked>,
    pub warnings: Vec<Warning>,
    pub suggested: Vec<String>,
}

impl Plan {
    pub fn can_run(&self) -> bool {
        self.blocked.is_none() && !self.steps.is_empty()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preflight {
    pub os: HostOs,
    pub home: String,
    pub curl: bool,
    pub node: bool,
    pub npm: bool,
    pub nvm: bool,
    pub tmux: bool,
    pub winget: bool,
    pub pkg: Option<PkgManager>,
    pub agent_found: bool,
    pub agent_path: Option<String>,
    pub live_tmux: bool,
}

pub fn agent_install_command(agent: AgentKind, os: HostOs) -> &'static str {
    match os {
        HostOs::Posix => match agent {
            AgentKind::Claude => CLAUDE_INSTALL,
            AgentKind::Codex => CODEX_INSTALL,
            AgentKind::Grok => GROK_INSTALL,
            AgentKind::Pi => PI_INSTALL,
        },
        HostOs::Windows => match agent {
            AgentKind::Claude => CLAUDE_INSTALL_PS1,
            AgentKind::Codex => CODEX_INSTALL_PS1,
            AgentKind::Grok => GROK_INSTALL_PS1,
            AgentKind::Pi => PI_INSTALL_PS1,
        },
    }
}

pub fn agent_upgrade_command(agent: AgentKind, os: HostOs) -> String {
    match os {
        HostOs::Posix => match agent {
            AgentKind::Claude => format!("claude update || {CLAUDE_INSTALL}"),
            AgentKind::Grok => format!("grok update || {GROK_INSTALL}"),
            AgentKind::Codex => CODEX_INSTALL.to_string(),
            AgentKind::Pi => PI_INSTALL.to_string(),
        },
        // PowerShell 5.1 has no `||`; `$?` carries the previous status.
        HostOs::Windows => match agent {
            AgentKind::Claude => format!("claude update; if (-not $?) {{ {CLAUDE_INSTALL_PS1} }}"),
            AgentKind::Grok => format!("grok update; if (-not $?) {{ {GROK_INSTALL_PS1} }}"),
            AgentKind::Codex => CODEX_INSTALL_PS1.to_string(),
            AgentKind::Pi => PI_INSTALL_PS1.to_string(),
        },
    }
}

pub fn npm_package(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Claude => NPM_CLAUDE,
        AgentKind::Codex => NPM_CODEX,
        AgentKind::Grok => NPM_GROK,
        AgentKind::Pi => NPM_PI,
    }
}

pub fn brew_uninstall_command(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Claude => "brew uninstall --cask claude-code",
        AgentKind::Codex => "brew uninstall --cask codex",
        AgentKind::Grok => "brew uninstall grok",
        AgentKind::Pi => "brew uninstall pi-coding-agent",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMethod {
    Native,
    Npm,
    Brew,
}

pub fn classify_path(path: &str) -> InstallMethod {
    let p = path.replace('\\', "/");
    if p.contains("/node_modules/")
        || p.contains("/.nvm/")
        || p.contains("npm-global")
        || p.contains("/.npm/")
        || p.contains("/lib/node_modules/")
    {
        return InstallMethod::Npm;
    }
    if p.contains("/Cellar/")
        || p.contains("/Caskroom/")
        || p.contains("/linuxbrew/")
        || p.contains("/Homebrew/")
        || p.contains("/opt/homebrew/")
        || p.contains("/home/linuxbrew/")
    {
        return InstallMethod::Brew;
    }
    InstallMethod::Native
}

pub fn preflight_script(agent: AgentKind, os: HostOs) -> String {
    if os == HostOs::Windows {
        return win::preflight_script(agent);
    }
    let slug = agent.slug();
    format!(
        r#"
printf 'FARAGENT_PREFLIGHT_V1\n'
printf 'os\tposix\n'
printf 'home\t%s\n' "$HOME"
which1() {{ command -v "$1" 2>/dev/null || true; }}
printf 'curl\t%s\n' "$(which1 curl)"
printf 'node\t%s\n' "$(which1 node)"
printf 'npm\t%s\n' "$(which1 npm)"
if [ -s "${{NVM_DIR:-$HOME/.nvm}}/nvm.sh" ]; then
  printf 'nvm\t1\n'
else
  printf 'nvm\t0\n'
fi
printf 'tmux\t%s\n' "$(which1 tmux)"
pkg=
for p in brew apt-get apt dnf yum pacman apk; do
  if command -v "$p" >/dev/null 2>&1; then
    pkg=$p
    break
  fi
done
printf 'pkg\t%s\n' "$pkg"
printf 'agent_path\t%s\n' "$(which1 {slug})"
live=0
if command -v tmux >/dev/null 2>&1; then
  if tmux -L faragent list-sessions -F '#{{session_name}}' 2>/dev/null | grep -q '^faragent-{slug}-'; then
    live=1
  fi
  if tmux -L farssh list-sessions -F '#{{session_name}}' 2>/dev/null | grep -q '^farssh-{slug}-'; then
    live=1
  fi
fi
printf 'live\t%s\n' "$live"
"#
    )
}

pub fn parse_preflight(text: &str) -> Result<Preflight> {
    let body = after_magic(text, "FARAGENT_PREFLIGHT_V1")?;
    let mut pf = Preflight::default();
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line == "FARAGENT_PREFLIGHT_V1" {
            continue;
        }
        let mut cols = line.splitn(2, '\t');
        let key = cols.next().unwrap_or("");
        let val = cols.next().unwrap_or("").trim();
        match key {
            "os" => pf.os = HostOs::parse(val).unwrap_or_default(),
            "home" => pf.home = val.to_string(),
            "curl" => pf.curl = !val.is_empty(),
            "node" => pf.node = !val.is_empty(),
            "npm" => pf.npm = !val.is_empty(),
            "nvm" => pf.nvm = val == "1" || val.eq_ignore_ascii_case("yes") || val == "true",
            "tmux" => pf.tmux = !val.is_empty() && val != "0",
            "winget" => pf.winget = !val.is_empty() && val != "0",
            "pkg" => pf.pkg = PkgManager::parse(val),
            "agent_path" => {
                if !val.is_empty() {
                    pf.agent_found = true;
                    pf.agent_path = Some(val.to_string());
                }
            }
            "live" => pf.live_tmux = val == "1" || val.eq_ignore_ascii_case("yes") || val == "true",
            _ => {}
        }
    }
    Ok(pf)
}

pub fn preflight_host(host: &str, agent: AgentKind) -> Result<Preflight> {
    let client = OpenSshTransport::connect(host)?;
    let os = host_os(host)?;
    let output = match os {
        HostOs::Posix => client.exec_login(&preflight_script(agent, os))?,
        HostOs::Windows => client.exec_win(&win::preflight_script(agent), &[])?,
    };
    if !output.success() {
        client.require_ok(&output)?;
    }
    let mut pf = parse_preflight(&String::from_utf8_lossy(&output.stdout))?;
    // The dispatcher already knows; the script's own line is advisory.
    pf.os = os;
    Ok(pf)
}

pub fn plan_for(action: Action, agent: AgentKind, pf: &Preflight) -> Plan {
    match action {
        Action::Install => plan_install(agent, pf),
        Action::Upgrade => plan_upgrade(agent, pf),
        Action::Uninstall => plan_uninstall(agent, pf),
    }
}

fn plan_install(agent: AgentKind, pf: &Preflight) -> Plan {
    match pf.os {
        HostOs::Posix => plan_install_posix(agent, pf),
        HostOs::Windows => plan_install_windows(agent, pf),
    }
}

/// Windows has no tmux and no curl bootstrapping: the agents' official
/// PowerShell installers are per-user and self-contained; Node (only for Pi)
/// comes from winget when available.
fn plan_install_windows(agent: AgentKind, pf: &Preflight) -> Plan {
    let mut steps = Vec::new();
    let mut suggested = Vec::new();
    let want_agent = !pf.agent_found;
    let want_node = want_agent && agent == AgentKind::Pi && !pf.node;

    if want_node {
        if pf.winget {
            steps.push(Step {
                title: "Install Node.js LTS via winget".into(),
                command: NODE_LTS_WINGET.to_string(),
                sudo: false,
            });
        } else {
            suggested.push(NODE_LTS_WINGET.to_string());
        }
    }

    if want_agent {
        steps.push(Step {
            title: format!("Install {}", agent.title()),
            command: agent_install_command(agent, HostOs::Windows).to_string(),
            sudo: false,
        });
        steps.push(verify_step(agent, HostOs::Windows));
    }

    let blocked = if steps.is_empty() {
        Some(Blocked::NothingToDo)
    } else {
        None
    };
    finish_plan(
        Action::Install,
        agent,
        steps,
        blocked,
        Vec::new(),
        suggested,
        pf.os,
    )
}

fn plan_install_posix(agent: AgentKind, pf: &Preflight) -> Plan {
    let mut steps = Vec::new();
    let mut warnings = Vec::new();
    let mut suggested = Vec::new();
    let mut blocked = None;
    let want_agent = !pf.agent_found;
    let want_tmux = !pf.tmux;
    let want_node = want_agent && agent == AgentKind::Pi && !pf.node;
    let want_curl = !pf.curl && (want_agent || want_node);

    if want_curl {
        match pf.pkg {
            Some(pkg) => {
                let (cmd, sudo) = pkg.install_cmd("curl");
                if sudo {
                    warnings.push(Warning::NeedsSudo);
                }
                steps.push(Step {
                    title: "Install curl".into(),
                    command: cmd,
                    sudo,
                });
            }
            None => {
                blocked = Some(Blocked::NoCurlNoPkg);
                suggested.extend(SUGGESTED_CURL.iter().map(|s| (*s).to_string()));
            }
        }
    }

    if want_tmux {
        match pf.pkg {
            Some(pkg) => {
                let (cmd, sudo) = pkg.install_cmd("tmux");
                if sudo {
                    warnings.push(Warning::NeedsSudo);
                }
                steps.push(Step {
                    title: "Install tmux".into(),
                    command: cmd,
                    sudo,
                });
            }
            None => {
                suggested.extend(SUGGESTED_TMUX.iter().map(|s| (*s).to_string()));
                if want_agent {
                    warnings.push(Warning::TmuxSkippedNoPkg);
                } else {
                    blocked = Some(Blocked::TmuxOnlyNoPkg);
                }
            }
        }
    }

    if want_node && blocked.is_none() {
        steps.push(Step {
            title: "Install nvm".into(),
            command: NVM_INSTALL.to_string(),
            sudo: false,
        });
        steps.push(Step {
            title: "Install Node LTS via nvm".into(),
            command: nvm_use_and_install_lts(),
            sudo: false,
        });
    }

    if want_agent && blocked.is_none() {
        steps.push(Step {
            title: format!("Install {}", agent.title()),
            command: agent_install_command(agent, HostOs::Posix).to_string(),
            sudo: false,
        });
        steps.push(verify_step(agent, HostOs::Posix));
    } else if !want_agent && want_tmux && blocked.is_none() && !steps.is_empty() {
        steps.push(Step {
            title: "Verify tmux".into(),
            command: "command -v tmux && tmux -V".into(),
            sudo: false,
        });
    }

    if blocked.is_none() && steps.is_empty() {
        blocked = Some(Blocked::NothingToDo);
    }

    finish_plan(
        Action::Install,
        agent,
        steps,
        blocked,
        warnings,
        suggested,
        pf.os,
    )
}

fn plan_upgrade(agent: AgentKind, pf: &Preflight) -> Plan {
    if !pf.agent_found {
        return plan_install(agent, pf);
    }
    let mut warnings = Vec::new();
    if pf.live_tmux {
        warnings.push(Warning::LiveTmux);
    }
    let steps = vec![
        Step {
            title: format!("Upgrade {}", agent.title()),
            command: agent_upgrade_command(agent, pf.os),
            sudo: false,
        },
        verify_step(agent, pf.os),
    ];
    finish_plan(
        Action::Upgrade,
        agent,
        steps,
        None,
        warnings,
        Vec::new(),
        pf.os,
    )
}

fn plan_uninstall(agent: AgentKind, pf: &Preflight) -> Plan {
    if !pf.agent_found {
        return finish_plan(
            Action::Uninstall,
            agent,
            Vec::new(),
            Some(Blocked::NotInstalled),
            Vec::new(),
            Vec::new(),
            pf.os,
        );
    }
    let mut warnings = Vec::new();
    if pf.live_tmux {
        warnings.push(Warning::LiveTmux);
    }
    let path = pf.agent_path.as_deref().unwrap_or("");
    let command = uninstall_command(agent, path, pf.os);
    let steps = vec![Step {
        title: format!("Uninstall {} CLI (keep config)", agent.title()),
        command,
        sudo: false,
    }];
    finish_plan(
        Action::Uninstall,
        agent,
        steps,
        None,
        warnings,
        Vec::new(),
        pf.os,
    )
}

pub fn uninstall_command(agent: AgentKind, path: &str, os: HostOs) -> String {
    match (os, classify_path(path)) {
        (_, InstallMethod::Npm) => format!("npm uninstall -g {}", npm_package(agent)),
        (HostOs::Posix, InstallMethod::Brew) => brew_uninstall_command(agent).to_string(),
        (HostOs::Posix, InstallMethod::Native) => native_uninstall_command(agent, path),
        (HostOs::Windows, _) => native_uninstall_command_windows(agent, path),
    }
}

fn native_uninstall_command(agent: AgentKind, path: &str) -> String {
    let extra = if path.is_empty() {
        String::new()
    } else {
        format!("rm -f {}; ", shell_single_quote(path))
    };
    match agent {
        AgentKind::Claude => format!(
            "{extra}if command -v claude >/dev/null 2>&1; then claude uninstall || true; fi; \
rm -f \"$HOME/.local/bin/claude\"; rm -rf \"$HOME/.local/share/claude\" \"$HOME/.claude-code\""
        ),
        AgentKind::Codex => {
            format!("{extra}rm -f \"$HOME/.local/bin/codex\" \"$HOME/.codex/bin/codex\"")
        }
        AgentKind::Grok => {
            format!("{extra}rm -f \"$HOME/.grok/bin/grok\" \"$HOME/.local/bin/grok\"")
        }
        AgentKind::Pi => format!(
            "{extra}npm uninstall -g {pkg} || true; rm -f \"$HOME/.local/bin/pi\"",
            pkg = NPM_PI
        ),
    }
}

/// Windows native uninstall: best-effort removal of the detected binary plus
/// the standard per-user install locations. Config directories stay, matching
/// the POSIX arm's "keep config" promise.
fn native_uninstall_command_windows(agent: AgentKind, path: &str) -> String {
    let extra = if path.is_empty() {
        String::new()
    } else {
        format!(
            "Remove-Item -Force -ErrorAction SilentlyContinue {}; ",
            win::ps_single_quote(path)
        )
    };
    match agent {
        AgentKind::Claude => format!(
            "{extra}claude uninstall 2>$null; \
Remove-Item -Force -Recurse -ErrorAction SilentlyContinue \
\"$env:USERPROFILE\\.local\\bin\\claude.exe\", \"$env:USERPROFILE\\.local\\bin\\claude.cmd\", \
\"$env:USERPROFILE\\.local\\share\\claude\""
        ),
        AgentKind::Codex => format!(
            "{extra}Remove-Item -Force -Recurse -ErrorAction SilentlyContinue \
\"$env:USERPROFILE\\.local\\bin\\codex.exe\", \"$env:USERPROFILE\\.local\\bin\\codex.cmd\""
        ),
        AgentKind::Grok => format!(
            "{extra}Remove-Item -Force -Recurse -ErrorAction SilentlyContinue \
\"$env:USERPROFILE\\.grok\\bin\\grok.exe\", \"$env:USERPROFILE\\.grok\\bin\\agent.exe\", \
\"$env:USERPROFILE\\.local\\bin\\grok.exe\""
        ),
        AgentKind::Pi => format!(
            "{extra}npm uninstall -g {pkg} 2>$null; \
Remove-Item -Force -Recurse -ErrorAction SilentlyContinue \
\"$env:USERPROFILE\\.local\\bin\\pi.exe\", \"$env:USERPROFILE\\.local\\bin\\pi.cmd\"",
            pkg = NPM_PI
        ),
    }
}

fn nvm_use_and_install_lts() -> String {
    format!("export NVM_DIR=\"$HOME/.nvm\"; . \"$NVM_DIR/nvm.sh\"; {NVM_NODE_LTS}")
}

fn verify_step(agent: AgentKind, os: HostOs) -> Step {
    let bin = agent.bin();
    match os {
        HostOs::Posix => Step {
            title: format!("Verify {bin}"),
            command: format!(
                "export PATH=\"$HOME/.local/bin:$HOME/.grok/bin:$PATH\"; \
if [ -s \"$HOME/.nvm/nvm.sh\" ]; then export NVM_DIR=\"$HOME/.nvm\"; . \"$NVM_DIR/nvm.sh\"; fi; \
hash -r || true; command -v {bin}; {bin} --version || {bin} -V || true"
            ),
            sudo: false,
        },
        HostOs::Windows => Step {
            title: format!("Verify {bin}"),
            command: format!(
                "$env:PATH = \"$env:USERPROFILE\\.local\\bin;$env:USERPROFILE\\.grok\\bin;$env:PATH\"; \
(Get-Command {bin} -ErrorAction SilentlyContinue).Source; & {bin} --version"
            ),
            sudo: false,
        },
    }
}

fn finish_plan(
    action: Action,
    agent: AgentKind,
    steps: Vec<Step>,
    blocked: Option<Blocked>,
    mut warnings: Vec<Warning>,
    suggested: Vec<String>,
    os: HostOs,
) -> Plan {
    if steps.iter().any(|s| s.sudo) && !warnings.contains(&Warning::NeedsSudo) {
        warnings.push(Warning::NeedsSudo);
    }
    let script = if blocked.is_some() || steps.is_empty() {
        String::new()
    } else {
        render_script(agent, action, &steps, os)
    };
    Plan {
        action,
        agent,
        steps,
        script,
        blocked,
        warnings,
        suggested,
    }
}

fn render_script(agent: AgentKind, action: Action, steps: &[Step], os: HostOs) -> String {
    match os {
        HostOs::Posix => render_script_posix(agent, action, steps),
        HostOs::Windows => render_script_windows(agent, action, steps),
    }
}

/// PowerShell twin of the POSIX wrapper: same `========== [n] title ==========`
/// section shape, a closing line, and Read-Host so the live terminal pauses
/// before dropping back to the TUI. Scripts stay short by construction; the
/// launcher rides an EncodedCommand whose command line must fit cmd's limit.
fn render_script_windows(agent: AgentKind, action: Action, steps: &[Step]) -> String {
    let mut s = String::new();
    s.push_str(win::UTF8_PREAMBLE);
    s.push('\n');
    s.push_str("$ErrorActionPreference = 'Continue'\n");
    s.push_str(&format!(
        "Write-Output 'faragent: {} {}'\n",
        action_word(action),
        agent.slug()
    ));
    s.push_str("Write-Output (\"host: \" + $env:COMPUTERNAME)\n");
    for (i, step) in steps.iter().enumerate() {
        let n = i + 1;
        let title = step.title.replace('\'', "");
        s.push_str(&format!(
            "\nWrite-Output ''\nWrite-Output '========== [{n}] {title} =========='\n"
        ));
        s.push_str(&step.command);
        s.push('\n');
    }
    s.push_str(
        "\nWrite-Output ''\nWrite-Output 'faragent: finished. Press Enter to return to FarAgent.'\nRead-Host | Out-Null\n",
    );
    s
}

fn render_script_posix(agent: AgentKind, action: Action, steps: &[Step]) -> String {
    let mut s = String::from(
        r#"set -eo pipefail
faragent_cleanup() {
  st=$?
  echo
  echo "========== faragent: finished (status $st) =========="
  echo "Press Enter to return to FarAgent."
  read -r _ || true
}
trap faragent_cleanup EXIT
export PATH="$HOME/.local/bin:$HOME/.grok/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  set +e
  . "$NVM_DIR/nvm.sh"
  set -e
fi
echo "faragent: remote $(hostname 2>/dev/null || true)  action below"
"#,
    );
    s.push_str(&format!(
        "echo 'faragent: {} {}'\n",
        action_word(action),
        agent.slug()
    ));
    for (i, step) in steps.iter().enumerate() {
        let n = i + 1;
        let title = step.title.replace('\'', "");
        let echoed = shell_single_quote(&format!("+ {}", step.command));
        s.push_str(&format!(
            "\necho\necho '========== [{n}] {title} =========='\nprintf '%s\\n' {echoed}\n{}\n",
            step.command
        ));
    }
    s
}

fn action_word(action: Action) -> &'static str {
    match action {
        Action::Install => "install",
        Action::Upgrade => "upgrade",
        Action::Uninstall => "uninstall",
    }
}

fn after_magic<'a>(text: &'a str, magic: &str) -> Result<&'a str> {
    if let Some(i) = text.find(magic) {
        Ok(&text[i + magic.len()..])
    } else {
        Err(anyhow!(
            "missing {magic} in remote output: {}",
            text.chars().take(240).collect::<String>()
        ))
    }
}

// Install-flow wording travels with the plans it describes. A UI picks the
// language at render time; the plan itself is language-free.
// (Step titles and script echoes stay English by design — they name the
// commands that will actually run on the remote.)

pub fn confirm_title(action: Action, host: &str, agent: &str) -> LocalizedText<String> {
    match action {
        Action::Install => LocalizedText::new(
            format!("FarAgent · {host} · 安装 {agent}"),
            format!("FarAgent · {host} · install {agent}"),
        ),
        Action::Upgrade => LocalizedText::new(
            format!("FarAgent · {host} · 升级 {agent}"),
            format!("FarAgent · {host} · upgrade {agent}"),
        ),
        Action::Uninstall => LocalizedText::new(
            format!("FarAgent · {host} · 卸载 {agent}"),
            format!("FarAgent · {host} · uninstall {agent}"),
        ),
    }
}

pub fn confirm_list_title() -> LocalizedText<&'static str> {
    LocalizedText::new(
        "将在远程执行的命令（确认后直播输出）",
        "commands that will run on the remote (live after confirm)",
    )
}

pub fn planning() -> LocalizedText<&'static str> {
    LocalizedText::new("正在生成安装计划…", "building install plan…")
}

pub fn plan_failed(err: &str) -> LocalizedText<String> {
    LocalizedText::new(
        format!("无法生成安装计划: {err}"),
        format!("could not build install plan: {err}"),
    )
}

pub fn no_need_uninstall(name: &str) -> LocalizedText<String> {
    LocalizedText::new(
        format!("{name} 未安装，无需卸载"),
        format!("{name} is not installed; nothing to uninstall"),
    )
}

pub fn step_sudo() -> LocalizedText<&'static str> {
    LocalizedText::new("需要 sudo", "needs sudo")
}

pub fn warning(w: Warning) -> LocalizedText<String> {
    match w {
        Warning::LiveTmux => LocalizedText::new(
            "警告：该助手还有 live tmux 会话。卸载可能打断正在跑的 TUI，仍可继续。".into(),
            "Warning: this agent still has a live tmux session. Uninstall may interrupt it.".into(),
        ),
        Warning::TmuxSkippedNoPkg => LocalizedText::new(
            "未找到 brew/apt/dnf/yum/pacman/apk，跳过代装 tmux。可复制下方命令自行安装。".into(),
            "No brew/apt/dnf/yum/pacman/apk; skipping tmux. Copy a command below to install it yourself.".into(),
        ),
        Warning::NeedsSudo => LocalizedText::new(
            "有步骤需要 sudo。执行时若提示密码，在直播终端里输入（本机不保存）。".into(),
            "A step needs sudo. Type the password in the live terminal if asked (not stored locally).".into(),
        ),
    }
}

pub fn blocked(b: Blocked) -> LocalizedText<String> {
    match b {
        Blocked::NoCurlNoPkg => LocalizedText::new(
            "远程没有 curl，也没有可识别的包管理器。请先自行安装 curl，命令见下方。".into(),
            "Remote has no curl and no known package manager. Install curl yourself (commands below).".into(),
        ),
        Blocked::TmuxOnlyNoPkg => LocalizedText::new(
            "远程没有 tmux，也没有 brew/apt/dnf/yum/pacman/apk。请自行安装 tmux。".into(),
            "Remote has no tmux and no brew/apt/dnf/yum/pacman/apk. Install tmux yourself.".into(),
        ),
        Blocked::NotInstalled => LocalizedText::new(
            "未安装，无需卸载。".into(),
            "Not installed; nothing to uninstall.".into(),
        ),
        Blocked::NothingToDo => LocalizedText::new("没有需要执行的步骤。".into(), "Nothing to do.".into()),
    }
}

pub fn suggested_title() -> LocalizedText<&'static str> {
    LocalizedText::new(
        "可复制命令（FarAgent 不会执行这些）：",
        "Copy-paste (FarAgent will not run these):",
    )
}

pub fn running_remote() -> LocalizedText<&'static str> {
    LocalizedText::new(
        "正在远程执行（直播输出，完成后按回车返回）…",
        "running on the remote (live output; Enter when done to return)…",
    )
}

pub fn remote_ok() -> LocalizedText<&'static str> {
    LocalizedText::new(
        "远程命令成功 · 已重新探测",
        "remote command succeeded · re-probed",
    )
}

pub fn remote_failed(code: i32) -> LocalizedText<String> {
    LocalizedText::new(
        format!("远程命令失败（退出码 {code}）。错误见刚才的直播输出。"),
        format!("remote command failed (exit {code}). See the live output."),
    )
}

pub fn plan_blocked_enter() -> LocalizedText<&'static str> {
    LocalizedText::new(
        "当前计划无法执行。Esc 返回。",
        "This plan cannot run. Esc to go back.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use faragent_transport::bash_login_command;
    use pretty_assertions::assert_eq;

    fn pf(curl: bool, tmux: bool, pkg: Option<PkgManager>, agent_path: Option<&str>) -> Preflight {
        Preflight {
            os: HostOs::Posix,
            home: "/home/you".into(),
            curl,
            node: false,
            npm: false,
            nvm: false,
            tmux,
            winget: false,
            pkg,
            agent_found: agent_path.is_some(),
            agent_path: agent_path.map(|s| s.to_string()),
            live_tmux: false,
        }
    }

    fn pf_windows(node: bool, winget: bool, agent_path: Option<&str>) -> Preflight {
        Preflight {
            os: HostOs::Windows,
            home: "C:\\Users\\you".into(),
            node,
            winget,
            pkg: winget.then_some(PkgManager::Winget),
            agent_found: agent_path.is_some(),
            agent_path: agent_path.map(|s| s.to_string()),
            ..Preflight::default()
        }
    }

    #[test]
    fn official_install_strings() {
        assert_eq!(
            agent_install_command(AgentKind::Claude, HostOs::Posix),
            "curl -fsSL https://claude.ai/install.sh | bash"
        );
        assert_eq!(
            agent_install_command(AgentKind::Codex, HostOs::Posix),
            "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
        );
        assert_eq!(
            agent_install_command(AgentKind::Grok, HostOs::Posix),
            "curl -fsSL https://x.ai/cli/install.sh | bash"
        );
        assert_eq!(
            agent_install_command(AgentKind::Pi, HostOs::Posix),
            "curl -fsSL https://pi.dev/install.sh | sh"
        );
        // Windows keeps the same "official installer only" rule.
        assert_eq!(
            agent_install_command(AgentKind::Claude, HostOs::Windows),
            CLAUDE_INSTALL_PS1
        );
        assert_eq!(
            agent_install_command(AgentKind::Codex, HostOs::Windows),
            CODEX_INSTALL_PS1
        );
        assert_eq!(
            agent_install_command(AgentKind::Grok, HostOs::Windows),
            GROK_INSTALL_PS1
        );
        assert_eq!(
            agent_install_command(AgentKind::Pi, HostOs::Windows),
            PI_INSTALL_PS1
        );
    }

    #[test]
    fn claude_only_missing_no_extra_deps() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Claude,
            &pf(true, true, Some(PkgManager::AptGet), None),
        );
        assert!(plan.can_run());
        assert!(plan.blocked.is_none());
        let cmds: Vec<_> = plan.steps.iter().map(|s| s.command.as_str()).collect();
        assert!(cmds.contains(&CLAUDE_INSTALL));
        assert!(!cmds
            .iter()
            .any(|c| c.contains("tmux") && c.contains("install")));
        assert!(!cmds.contains(&NVM_INSTALL));
        assert!(plan.script.contains('|'));
        assert!(plan.script.contains("claude.ai/install.sh"));
    }

    #[test]
    fn missing_tmux_with_apt_adds_sudo() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Claude,
            &pf(true, false, Some(PkgManager::AptGet), None),
        );
        assert!(plan.can_run());
        assert!(plan.warnings.contains(&Warning::NeedsSudo));
        let tmux = plan
            .steps
            .iter()
            .find(|s| s.title.contains("tmux"))
            .unwrap();
        assert!(tmux.sudo);
        assert_eq!(
            tmux.command,
            "sudo apt-get update && sudo apt-get install -y tmux"
        );
    }

    #[test]
    fn brew_tmux_has_no_sudo() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Grok,
            &pf(true, false, Some(PkgManager::Brew), None),
        );
        let tmux = plan
            .steps
            .iter()
            .find(|s| s.title.contains("tmux"))
            .unwrap();
        assert!(!tmux.sudo);
        assert_eq!(tmux.command, "brew install tmux");
    }

    #[test]
    fn no_pkg_manager_blocks_tmux_only() {
        let mut p = pf(true, false, None, Some("/home/you/.local/bin/claude"));
        p.agent_found = true;
        let plan = plan_for(Action::Install, AgentKind::Claude, &p);
        assert!(!plan.can_run());
        assert_eq!(plan.blocked, Some(Blocked::TmuxOnlyNoPkg));
        assert!(plan
            .suggested
            .iter()
            .any(|s| s.contains("apt-get") && s.contains("tmux")));
        assert!(plan.script.is_empty());
    }

    #[test]
    fn no_pkg_still_installs_agent_and_warns_tmux() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Claude,
            &pf(true, false, None, None),
        );
        assert!(plan.can_run());
        assert_eq!(plan.blocked, None);
        assert!(plan.warnings.contains(&Warning::TmuxSkippedNoPkg));
        assert!(plan.steps.iter().any(|s| s.command == CLAUDE_INSTALL));
        assert!(!plan.steps.iter().any(|s| s.title.contains("tmux")));
    }

    #[test]
    fn no_curl_no_pkg_blocks() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Codex,
            &pf(false, true, None, None),
        );
        assert_eq!(plan.blocked, Some(Blocked::NoCurlNoPkg));
        assert!(!plan.can_run());
        assert!(plan.suggested.iter().any(|s| s.contains("curl")));
    }

    #[test]
    fn missing_curl_with_dnf_installs_curl() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Grok,
            &pf(false, true, Some(PkgManager::Dnf), None),
        );
        assert_eq!(plan.steps[0].command, "sudo dnf install -y curl");
        assert!(plan.steps.iter().any(|s| s.command == GROK_INSTALL));
    }

    #[test]
    fn pi_without_node_gets_nvm_claude_does_not() {
        let base = pf(true, true, Some(PkgManager::Brew), None);
        let pi = plan_for(Action::Install, AgentKind::Pi, &base);
        assert!(pi.steps.iter().any(|s| s.command == NVM_INSTALL));
        assert!(pi
            .steps
            .iter()
            .any(|s| s.command.contains("nvm install --lts")));
        let claude = plan_for(Action::Install, AgentKind::Claude, &base);
        assert!(!claude.steps.iter().any(|s| s.command == NVM_INSTALL));
    }

    #[test]
    fn upgrade_claude_uses_self_update_fallback() {
        let p = pf(true, true, None, Some("/home/you/.local/bin/claude"));
        let plan = plan_for(Action::Upgrade, AgentKind::Claude, &p);
        assert!(plan.can_run());
        assert!(plan.steps[0].command.contains("claude update"));
        assert!(plan.steps[0].command.contains(CLAUDE_INSTALL));
    }

    #[test]
    fn upgrade_when_missing_becomes_install() {
        let plan = plan_for(
            Action::Upgrade,
            AgentKind::Claude,
            &pf(true, true, None, None),
        );
        assert_eq!(plan.action, Action::Install);
        assert!(plan.steps.iter().any(|s| s.command == CLAUDE_INSTALL));
    }

    #[test]
    fn uninstall_native_local_bin() {
        let cmd = uninstall_command(
            AgentKind::Claude,
            "/home/you/.local/bin/claude",
            HostOs::Posix,
        );
        assert!(cmd.contains("rm -f"));
        assert!(cmd.contains("/home/you/.local/bin/claude"));
        assert!(!cmd.contains("rm -rf \"$HOME/.claude\""));
        assert!(!cmd.contains("npm uninstall"));
    }

    #[test]
    fn uninstall_npm_prefix() {
        let cmd = uninstall_command(
            AgentKind::Codex,
            "/home/you/.nvm/versions/node/v22.0.0/bin/codex",
            HostOs::Posix,
        );
        assert_eq!(cmd, "npm uninstall -g @openai/codex");
        let pi = uninstall_command(
            AgentKind::Pi,
            "/var/services/homes/Mr.Ma/.npm-global/bin/pi",
            HostOs::Posix,
        );
        assert_eq!(pi, "npm uninstall -g @earendil-works/pi-coding-agent");
    }

    #[test]
    fn uninstall_not_installed_is_blocked() {
        let plan = plan_for(
            Action::Uninstall,
            AgentKind::Grok,
            &pf(true, true, None, None),
        );
        assert_eq!(plan.blocked, Some(Blocked::NotInstalled));
        assert!(!plan.can_run());
    }

    #[test]
    fn uninstall_live_warns_but_allows() {
        let mut p = pf(true, true, None, Some("/home/you/.grok/bin/grok"));
        p.live_tmux = true;
        let plan = plan_for(Action::Uninstall, AgentKind::Grok, &p);
        assert!(plan.can_run());
        assert!(plan.warnings.contains(&Warning::LiveTmux));
        assert!(plan.steps[0].command.contains("$HOME/.grok/bin/grok"));
    }

    #[test]
    fn parse_preflight_fixture() {
        let text = "\
junk
FARAGENT_PREFLIGHT_V1
home\t/home/you
curl\t/usr/bin/curl
node\t
npm\t
nvm\t0
tmux\t
pkg\tapt-get
agent_path\t
live\t0
";
        let p = parse_preflight(text).unwrap();
        assert!(p.curl);
        assert!(!p.node);
        assert!(!p.tmux);
        assert_eq!(p.pkg, Some(PkgManager::AptGet));
        assert!(!p.agent_found);
        assert!(!p.live_tmux);
    }

    #[test]
    fn bash_login_keeps_pipe_in_one_argv() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Claude,
            &pf(true, true, None, None),
        );
        let cmd = bash_login_command(&plan.script);
        assert!(cmd.starts_with("bash -lc "));
        assert!(cmd.contains("install.sh"));
        assert!(cmd.contains("'"), "script with | must be quoted: {cmd}");
        assert!(!cmd.contains("bash -lc curl "));
    }

    #[test]
    fn classify_paths() {
        assert_eq!(
            classify_path("/opt/homebrew/bin/claude"),
            InstallMethod::Brew
        );
        assert_eq!(
            classify_path("/home/you/.local/bin/claude"),
            InstallMethod::Native
        );
        assert_eq!(
            classify_path("/home/you/.npm-global/bin/pi"),
            InstallMethod::Npm
        );
        // Windows npm-global paths normalize to the same classification.
        assert_eq!(
            classify_path("C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex"),
            InstallMethod::Npm
        );
    }

    #[test]
    fn windows_install_plan_uses_official_ps1_no_tmux() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Claude,
            &pf_windows(false, true, None),
        );
        assert!(plan.can_run());
        assert!(plan.blocked.is_none());
        let cmds: Vec<_> = plan.steps.iter().map(|s| s.command.as_str()).collect();
        assert!(cmds.contains(&CLAUDE_INSTALL_PS1));
        assert!(!cmds.iter().any(|c| c.contains("tmux")));
        assert!(!cmds.iter().any(|c| c.contains("curl")));
        assert!(plan.script.contains("========== [1]"));
        assert!(plan.script.contains("Read-Host"));
        assert!(plan.script.contains("claude.ai/install.ps1"));
        assert!(plan.script.contains("[Console]::OutputEncoding"));
    }

    #[test]
    fn windows_pi_without_node_uses_winget_or_suggests_it() {
        let plan = plan_for(
            Action::Install,
            AgentKind::Pi,
            &pf_windows(false, true, None),
        );
        assert!(plan
            .steps
            .iter()
            .any(|s| s.command.contains("OpenJS.NodeJS.LTS")));
        assert!(plan.steps.iter().any(|s| s.command == PI_INSTALL_PS1));

        // No winget: the node install becomes a copy-paste suggestion.
        let plan = plan_for(
            Action::Install,
            AgentKind::Pi,
            &pf_windows(false, false, None),
        );
        assert!(plan.suggested.iter().any(|s| s.contains("NodeJS.LTS")));
        assert!(!plan.steps.iter().any(|s| s.command.contains("winget")));
        assert!(plan.steps.iter().any(|s| s.command == PI_INSTALL_PS1));
    }

    #[test]
    fn windows_uninstall_removes_native_binaries() {
        let cmd = uninstall_command(
            AgentKind::Grok,
            "C:\\Users\\you\\.grok\\bin\\grok.exe",
            HostOs::Windows,
        );
        assert!(cmd.contains("Remove-Item"));
        assert!(cmd.contains("C:\\Users\\you\\.grok\\bin\\grok.exe"));
        assert!(cmd.contains("$env:USERPROFILE\\.grok\\bin\\grok.exe"));

        // npm shims still go through npm.
        let npm = uninstall_command(
            AgentKind::Codex,
            "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
            HostOs::Windows,
        );
        assert_eq!(npm, "npm uninstall -g @openai/codex");
    }

    #[test]
    fn windows_upgrade_avoids_ps51_unsupported_operators() {
        let cmd = agent_upgrade_command(AgentKind::Claude, HostOs::Windows);
        assert!(cmd.contains("claude update"));
        assert!(cmd.contains("install.ps1"));
        assert!(!cmd.contains("||"), "PS 5.1 has no || operator: {cmd}");
    }

    #[test]
    fn parse_preflight_windows_fixture() {
        let text = "FARAGENT_PREFLIGHT_V1\r\n\
os\twindows\r\n\
home\tC:\\Users\\you\r\n\
node\t\r\n\
winget\tC:\\Users\\you\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe\r\n\
pkg\twinget\r\n\
agent_path\tC:\\Users\\you\\.local\\bin\\claude.exe\r\n\
live\t0\r\n";
        let p = parse_preflight(text).unwrap();
        assert_eq!(p.os, HostOs::Windows);
        assert!(p.winget);
        assert_eq!(p.pkg, Some(PkgManager::Winget));
        assert!(p.agent_found);
        assert!(!p.tmux);
    }
}

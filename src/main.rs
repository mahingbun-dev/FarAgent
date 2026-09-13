mod agents;
mod config;
mod diagnose;
mod doctor;
mod i18n;
mod install;
mod probe;
mod pty;
mod remote;
mod runtime;
mod ssh;
mod tui;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use i18n::Lang;
use ssh::AuthMode;

#[derive(Parser, Debug)]
#[command(
    name = "faragent",
    version,
    about = "FarAgent: attach to coding agents already installed on your own machines"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Open the host / agent / session picker (default)
    Tui,
    /// Print SSH hosts, optional remote probe
    Doctor {
        /// Concrete Host alias from ~/.ssh/config
        #[arg(long)]
        host: Option<String>,
    },
    /// Probe a host (JSON)
    Probe {
        #[arg(long)]
        host: String,
    },
    /// List sessions for an agent on a host (JSON)
    Sessions {
        #[arg(long)]
        host: String,
        #[arg(long)]
        agent: String,
    },
    /// Show or set how faragent authenticates to a host
    Auth {
        /// Concrete Host alias from ~/.ssh/config
        #[arg(long)]
        host: String,
        /// auto | key | password. Omit to print the current mode.
        #[arg(long)]
        mode: Option<String>,
    },
    /// Log in once on the real terminal (password / host key) and keep it multiplexed
    Login {
        #[arg(long)]
        host: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        None | Some(Command::Tui) => tui::run(),
        Some(Command::Doctor { host }) => doctor::run(host.as_deref()),
        Some(Command::Probe { host }) => report(&host, probe_json(&host)),
        Some(Command::Sessions { host, agent }) => report(&host, sessions_json(&host, &agent)),
        Some(Command::Auth { host, mode }) => auth(&host, mode.as_deref()),
        Some(Command::Login { host }) => login(&host),
    }
}

fn lang() -> Lang {
    config::language().unwrap_or(Lang::Zh)
}

/// On failure print the same report the TUI shows (raw output + cause + fixes)
/// instead of a bare `Error: ...`.
fn report(host: &str, result: Result<()>) -> Result<()> {
    match result {
        Ok(()) => Ok(()),
        Err(e) => match diagnose::diagnosis_of(&e, host, lang()) {
            Some(d) => {
                print!("{}", d.plain(lang()));
                std::process::exit(1);
            }
            None => Err(e),
        },
    }
}

fn probe_json(host: &str) -> Result<()> {
    let p = probe::probe_host(host)?;
    println!("{}", serde_json::to_string_pretty(&json_probe(&p))?);
    Ok(())
}

fn sessions_json(host: &str, agent: &str) -> Result<()> {
    let kind = agents::AgentKind::parse(agent)?;
    let rows = runtime::list_sessions(host, kind)?;
    println!("{}", serde_json::to_string_pretty(&rows)?);
    Ok(())
}

fn auth(host: &str, mode: Option<&str>) -> Result<()> {
    let lang = lang();
    let Some(mode) = mode else {
        println!("{}", lang.auth_saved(host, config::auth_for(host)));
        return Ok(());
    };
    let parsed = AuthMode::parse(mode)
        .ok_or_else(|| anyhow!("unknown auth mode '{mode}': use auto | key | password"))?;
    config::set_auth(host, parsed)?;
    println!("{}", lang.auth_saved(host, parsed));
    Ok(())
}

/// One interactive login, then verify that later commands can reuse it.
fn login(host: &str) -> Result<()> {
    let lang = lang();
    let mode = config::auth_for(host);
    let client = ssh::Client::new(host)?;
    let code = pty::interactive_connect(host, mode, lang)?;
    let out = client.exec_raw_line(ssh::REMOTE_PING)?;
    if out.status.success() {
        println!("{}", lang.login_ok(host));
        return Ok(());
    }
    let mut d = diagnose::Diagnosis::of(&client.error_for(&out), lang);
    if code != 0
        && matches!(
            d.problem,
            diagnose::Problem::NeedsPassword | diagnose::Problem::PublickeyDenied
        )
    {
        // The user just tried; the actionable advice is about the credential,
        // not about enabling password mode.
        d = d.relabel(diagnose::Problem::PasswordDenied, lang);
    }
    print!("{}", d.plain(lang));
    std::process::exit(if code == 0 { 1 } else { code });
}

fn json_probe(p: &probe::Probe) -> serde_json::Value {
    serde_json::json!({
        "home": p.home,
        "os": p.os.slug(),
        "shell": p.shell,
        "path": p.path,
        "tmux": {
            "found": p.tmux.found,
            "path": p.tmux.path,
            "version": p.tmux.version,
        },
        "agents": p.agents.iter().map(|a| serde_json::json!({
            "id": a.id,
            "found": a.found,
            "path": a.path,
            "version": a.version,
            "auth_hint": a.auth_hint,
        })).collect::<Vec<_>>(),
    })
}

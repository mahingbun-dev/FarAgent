mod agents;
mod config;
mod doctor;
mod i18n;
mod probe;
mod pty;
mod remote;
mod runtime;
mod ssh;
mod tui;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "farssh",
    version,
    about = "FarSSH: attach to coding agents on your own machines over SSH"
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
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        None | Some(Command::Tui) => tui::run(),
        Some(Command::Doctor { host }) => doctor::run(host.as_deref()),
        Some(Command::Probe { host }) => {
            let p = probe::probe_host(&host)?;
            println!("{}", serde_json::to_string_pretty(&json_probe(&p))?);
            Ok(())
        }
        Some(Command::Sessions { host, agent }) => {
            let kind = agents::AgentKind::parse(&agent)?;
            let rows = runtime::list_sessions(&host, kind)?;
            println!("{}", serde_json::to_string_pretty(&rows)?);
            Ok(())
        }
    }
}

fn json_probe(p: &probe::Probe) -> serde_json::Value {
    serde_json::json!({
        "home": p.home,
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

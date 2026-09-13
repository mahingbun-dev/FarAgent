use crate::probe;
use crate::runtime;
use crate::ssh::{self, Client};
use anyhow::Result;

pub fn run(host: Option<&str>) -> Result<()> {
    println!("farssh doctor");
    println!(
        "local ssh: {}",
        which_local("ssh").unwrap_or_else(|| "(missing)".into())
    );
    println!(
        "ssh config: {}",
        ssh::ssh_config_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "(none)".into())
    );
    let hosts = ssh::list_hosts()?;
    println!("hosts in ~/.ssh/config (non-pattern): {}", hosts.len());
    for h in &hosts {
        println!("  - {}", h.label());
    }
    if hosts.is_empty() {
        println!("  (add concrete Host entries; wildcards like * are ignored)");
    }

    let Some(host) = host else {
        println!("\nPass --host <alias> to probe a remote machine.");
        return Ok(());
    };

    println!("\n== remote {host} ==");
    let client = Client::new(host)?;
    let ping = client.exec(&["true"])?;
    if ping.status.success() {
        println!("ssh: ok (BatchMode)");
    } else {
        println!("ssh: FAIL");
        println!("{}", Client::output_text(&ping).trim());
        return Ok(());
    }

    match probe::probe_host(host) {
        Ok(p) => {
            println!("home: {}", p.home);
            println!("shell: {}", p.shell);
            println!(
                "tmux: {}",
                if p.tmux.found {
                    format!(
                        "{}  {}",
                        p.tmux.path.as_deref().unwrap_or("tmux"),
                        p.tmux.version.as_deref().unwrap_or("")
                    )
                } else {
                    "NOT INSTALLED (farssh will not install it)".into()
                }
            );
            for kind in crate::agents::AgentKind::ALL {
                println!("  {}", probe::format_agent_line(kind, &p));
            }
            println!("PATH (login shell): {}", p.path);
            if p.tmux.found {
                if let Err(e) = runtime::ensure_tmux_conf(&client) {
                    println!("tmux.conf: {e}");
                } else {
                    println!("tmux conf: {}/.farssh/tmux.conf", p.home);
                }
            }
            println!("\nnotes:");
            println!("  - Coding is the native agent TUI inside tmux socket 'farssh'.");
            println!("  - Detach with C-g d (prefix C-g). This does not kill the agent.");
            println!("  - Do not resume a live session; attach the existing tmux session.");
            println!("  - Remote needs bash + tmux + agents. No python3.");
        }
        Err(e) => println!("probe: {e}"),
    }
    Ok(())
}

fn which_local(bin: &str) -> Option<String> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let p = dir.join(bin);
            p.exists().then(|| p.display().to_string())
        })
    })
}

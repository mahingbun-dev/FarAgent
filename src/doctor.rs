use crate::diagnose::Diagnosis;
use crate::i18n::Lang;
use crate::install;
use crate::probe;
use crate::runtime;
use crate::ssh::{self, Client};
use anyhow::Result;

pub fn run(host: Option<&str>) -> Result<()> {
    println!("faragent doctor");
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
        println!(
            "  - {}{}",
            h.label(),
            lang().auth_tag(crate::config::auth_for(&h.alias))
        );
    }
    if hosts.is_empty() {
        println!("  (add concrete Host entries; wildcards like * are ignored)");
    }
    if let Some(home) = dirs::home_dir() {
        let old = home.join(".farssh");
        let new = home.join(".faragent");
        if old.exists() && new.exists() {
            println!("note: leftover ~/.farssh (active config is ~/.faragent)");
        }
    }

    let Some(host) = host else {
        println!("\nPass --host <alias> to probe a remote machine.");
        return Ok(());
    };

    println!("\n== remote {host} ==");
    let client = Client::new(host)?;
    println!(
        "auth mode: {} ({})",
        client.mode.code(),
        lang().auth_mode_label(client.mode)
    );
    let ping = client.exec(&["true"])?;
    if ping.status.success() {
        println!("ssh: ok");
        println!(
            "multiplex: {}",
            if !client.muxed() {
                "not supported by this ssh build (no ControlMaster; Win32 OpenSSH)"
            } else if client.master_alive() {
                "ControlMaster running"
            } else {
                "no ControlMaster socket"
            }
        );
    } else {
        let err = client.error_for(&ping);
        println!("{}", Diagnosis::of(&err, lang()).plain(lang()));
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
                    "NOT INSTALLED (TUI Enter can install via brew/apt/dnf/yum/pacman/apk; sudo allowed)".into()
                }
            );
            for kind in crate::agents::AgentKind::ALL {
                println!("  {}", probe::format_agent_line(kind, &p));
                let found = p.agent(kind).map(|a| a.found) == Some(true);
                if !found {
                    println!("      install: {}", install::agent_install_command(kind));
                } else {
                    println!("      upgrade: {}", install::agent_upgrade_command(kind));
                }
            }
            println!("PATH (login shell): {}", p.path);
            if p.tmux.found {
                if let Err(e) = runtime::ensure_tmux_conf(&client) {
                    println!("tmux.conf: {e}");
                } else {
                    println!("tmux conf: {}/.faragent/tmux.conf", p.home);
                }
            }
            println!("\nnotes:");
            println!("  - Coding is the native agent TUI inside tmux socket 'faragent'.");
            println!("  - Detach with C-g d (prefix C-g). This does not kill the agent.");
            println!("  - Do not resume a live session; attach the existing tmux session.");
            println!("  - Remote needs bash. tmux + agents can be installed from the TUI.");
            println!(
                "  - Agent installers are official curl|bash into the user directory (no sudo)."
            );
            println!(
                "  - tmux/curl may use sudo + the system package manager. Node for Pi uses nvm."
            );
            println!("  - doctor never runs those commands; the TUI confirm screen does.");
            println!("  - No python3. No faragent binary on the target.");
        }
        Err(e) => println!("{}", crate::diagnose::render_error(&e, host, lang())),
    }
    Ok(())
}

fn which_local(bin: &str) -> Option<String> {
    let paths = std::env::var_os("PATH")?;
    let dirs: Vec<std::path::PathBuf> = std::env::split_paths(&paths).collect();
    let exts: &[&str] = if cfg!(windows) { &[".exe", ""] } else { &[""] };
    which_in(&dirs, bin, exts)
}

/// First `dir/bin<ext>` that exists, in PATH order — the way a shell would
/// resolve it. Windows executables carry a `.exe` suffix.
fn which_in(dirs: &[std::path::PathBuf], bin: &str, exts: &[&str]) -> Option<String> {
    dirs.iter().find_map(|dir| {
        exts.iter()
            .map(|ext| dir.join(format!("{bin}{ext}")))
            .find(|p| p.is_file())
            .map(|p| p.display().to_string())
    })
}

/// doctor speaks the language the user picked in the TUI.
fn lang() -> Lang {
    crate::config::language().unwrap_or(Lang::Zh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_in_prefers_path_order_and_tries_extensions() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("ssh"), "x").unwrap();
        std::fs::write(a.join("ssh.exe"), "x").unwrap();
        let dirs = vec![a.clone(), b.clone()];
        // Unix: only the bare name counts; ssh.exe is invisible.
        assert_eq!(
            which_in(&dirs, "ssh", &[""]),
            Some(b.join("ssh").display().to_string())
        );
        // Windows: the earlier PATH entry with ssh.exe wins.
        assert_eq!(
            which_in(&dirs, "ssh", &[".exe", ""]),
            Some(a.join("ssh.exe").display().to_string())
        );
        assert_eq!(which_in(&dirs, "missing", &[".exe", ""]), None);
    }
}

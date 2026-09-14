//! Local FarAgent directories (`~/.faragent`) and the one-shot rename from
//! the pre-rename `~/.farssh`. Remote `~` expansion lives here too so TUI
//! and App cannot drift.

use crate::vocab::HostOs;
use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub const APP_HOME_DIR: &str = ".faragent";
pub const LEGACY_APP_HOME_DIR: &str = ".farssh";

/// Local config / ControlMaster dir. Renames `~/.farssh` once if the new dir is absent.
pub fn faragent_home() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("cannot resolve home directory"))?;
    migrate_app_home(&home)
}

pub fn migrate_app_home(home: &Path) -> Result<PathBuf> {
    let dest = home.join(APP_HOME_DIR);
    let src = home.join(LEGACY_APP_HOME_DIR);
    if !dest.exists() && src.exists() {
        fs::rename(&src, &dest)
            .with_context(|| format!("rename {} -> {}", src.display(), dest.display()))?;
    }
    Ok(dest)
}

/// `~` / `~/x` (or `~\x`) against a **remote** home, in that host's separator
/// style. Prefix only: `~bob` and mid-path tildes stay literal.
pub fn expand_home(typed: &str, home: &str, os: HostOs) -> String {
    if typed == "~" {
        return home.to_string();
    }
    match os {
        HostOs::Posix => match typed.strip_prefix("~/") {
            Some(rest) => format!("{}/{}", home.trim_end_matches('/'), rest),
            None => typed.to_string(),
        },
        HostOs::Windows => {
            for prefix in ["~/", "~\\"] {
                if let Some(rest) = typed.strip_prefix(prefix) {
                    return format!(
                        "{}\\{}",
                        home.trim_end_matches(['/', '\\']),
                        rest.replace('/', "\\")
                    );
                }
            }
            typed.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_renames_legacy_home() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(".farssh");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("config.json"), "{}\n").unwrap();
        let dest = migrate_app_home(tmp.path()).unwrap();
        assert_eq!(dest, tmp.path().join(".faragent"));
        assert!(dest.join("config.json").is_file());
        assert!(!old.exists());
    }

    #[test]
    fn migrate_leaves_existing_new_home() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(".farssh");
        let new = tmp.path().join(".faragent");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        std::fs::write(old.join("config.json"), "old").unwrap();
        std::fs::write(new.join("config.json"), "new").unwrap();
        migrate_app_home(tmp.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(new.join("config.json")).unwrap(),
            "new"
        );
        assert!(old.exists());
    }

    #[test]
    fn tilde_expands_against_the_remote_home_only_as_a_prefix() {
        let os = HostOs::Posix;
        assert_eq!(expand_home("~", "/home/me", os), "/home/me");
        assert_eq!(
            expand_home("~/code/app", "/home/me", os),
            "/home/me/code/app"
        );
        assert_eq!(
            expand_home("~/code/app", "/home/me/", os),
            "/home/me/code/app"
        );
        assert_eq!(expand_home("/srv/app", "/home/me", os), "/srv/app");
        // Mid-path tildes are literal, and a user named `~bob` is not a home ref.
        assert_eq!(expand_home("/srv/~weird", "/home/me", os), "/srv/~weird");
        assert_eq!(expand_home("~bob/app", "/home/me", os), "~bob/app");
    }

    #[test]
    fn tilde_expands_windows_style_home() {
        let os = HostOs::Windows;
        let home = "C:\\Users\\me";
        assert_eq!(expand_home("~", home, os), home);
        assert_eq!(
            expand_home("~\\code\\app", home, os),
            "C:\\Users\\me\\code\\app"
        );
        assert_eq!(
            expand_home("~/code/app", home, os),
            "C:\\Users\\me\\code\\app"
        );
        assert_eq!(expand_home("C:\\srv\\app", home, os), "C:\\srv\\app");
        assert_eq!(expand_home("~bob", home, os), "~bob");
        // Trailing separators on the home do not double up.
        assert_eq!(
            expand_home("~\\x", "C:\\Users\\me\\", os),
            "C:\\Users\\me\\x"
        );
    }
}

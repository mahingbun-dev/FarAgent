//! Local FarAgent directories (`~/.faragent`) and the one-shot rename from
//! the pre-rename `~/.farssh`.

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
}

//! Local client config: `~/.faragent/config.json`.

use crate::i18n::Lang;
use crate::ssh;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    /// `"zh"` or `"en"`. Absent on first run so the TUI can ask once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

pub fn path() -> Result<PathBuf> {
    Ok(ssh::faragent_home()?.join("config.json"))
}

pub fn load() -> Config {
    let Ok(path) = path() else {
        return Config::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(cfg: &Config) -> Result<()> {
    let dir = ssh::faragent_home()?;
    fs::create_dir_all(&dir).with_context(|| dir.display().to_string())?;
    let path = dir.join("config.json");
    let tmp = dir.join("config.json.tmp");
    let body = serde_json::to_string_pretty(cfg)? + "\n";
    fs::write(&tmp, body).with_context(|| tmp.display().to_string())?;
    fs::rename(&tmp, &path).with_context(|| path.display().to_string())?;
    Ok(())
}

pub fn language() -> Option<Lang> {
    load().language.as_deref().and_then(Lang::parse)
}

pub fn set_language(lang: Lang) -> Result<()> {
    let mut cfg = load();
    cfg.language = Some(lang.code().to_string());
    save(&cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_language() {
        let cfg = Config {
            language: Some("zh".into()),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        assert_eq!(
            Lang::parse(back.language.as_deref().unwrap()),
            Some(Lang::Zh)
        );
    }

    #[test]
    fn missing_language_is_first_run() {
        let cfg: Config = serde_json::from_str("{}").unwrap();
        assert!(cfg.language.is_none());
    }
}

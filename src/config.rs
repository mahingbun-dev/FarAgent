//! Local client config: `~/.faragent/config.json`.

use crate::i18n::Lang;
use crate::ssh::{self, AuthMode};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    /// `"zh"` or `"en"`. Absent on first run so the TUI can ask once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Per-host overrides keyed by the `Host` alias from `~/.ssh/config`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hosts: BTreeMap<String, HostConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostConfig {
    #[serde(default)]
    pub auth: AuthMode,
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

/// `auto` unless the user pinned this host to key- or password-only.
pub fn auth_for(host: &str) -> AuthMode {
    load().hosts.get(host).map(|h| h.auth).unwrap_or_default()
}

/// `auto` is the default, so storing it just removes the override.
pub fn set_auth(host: &str, mode: AuthMode) -> Result<()> {
    let mut cfg = load();
    if mode == AuthMode::Auto {
        cfg.hosts.remove(host);
    } else {
        cfg.hosts
            .insert(host.to_string(), HostConfig { auth: mode });
    }
    save(&cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_language() {
        let cfg = Config {
            language: Some("zh".into()),
            ..Default::default()
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

    #[test]
    fn host_auth_roundtrip_and_default() {
        let cfg: Config =
            serde_json::from_str(r#"{"language":"zh","hosts":{"devbox":{"auth":"password"}}}"#)
                .unwrap();
        assert_eq!(cfg.hosts["devbox"].auth, AuthMode::Password);
        assert_eq!(cfg.language.as_deref(), Some("zh"));
        // A config written before this field existed still loads.
        let old: Config = serde_json::from_str(r#"{"language":"en"}"#).unwrap();
        assert!(old.hosts.is_empty());
        let json = serde_json::to_string(&Config::default()).unwrap();
        assert!(!json.contains("hosts"), "empty map stays out of the file");
    }
}

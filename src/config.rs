//! Local client config: `~/.faragent/config.json`.

use crate::i18n::Lang;
use crate::remote::HostOs;
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
    /// Cached remote dialect. Saves one round trip per command on machines
    /// whose ssh cannot multiplex; self-heals when the probe disagrees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<HostOs>,
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

/// `auto` is the default, so storing it just removes the override — but the
/// cached `os` is not an override, it must survive.
pub fn set_auth(host: &str, mode: AuthMode) -> Result<()> {
    let mut cfg = load();
    apply_auth(&mut cfg, host, mode);
    save(&cfg)
}

fn apply_auth(cfg: &mut Config, host: &str, mode: AuthMode) {
    if mode == AuthMode::Auto {
        match cfg.hosts.get_mut(host) {
            Some(h) if h.os.is_some() => h.auth = AuthMode::Auto,
            _ => {
                cfg.hosts.remove(host);
            }
        }
    } else {
        cfg.hosts.entry(host.to_string()).or_default().auth = mode;
    }
}

/// Cached remote dialect for a host, if it was ever detected.
pub fn host_os(host: &str) -> Option<HostOs> {
    load().hosts.get(host).and_then(|h| h.os)
}

pub fn set_host_os(host: &str, os: HostOs) -> Result<()> {
    let mut cfg = load();
    let entry = cfg.hosts.entry(host.to_string()).or_default();
    if entry.os == Some(os) {
        return Ok(());
    }
    entry.os = Some(os);
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

    #[test]
    fn cached_os_survives_auth_reset() {
        let mut cfg = Config::default();
        apply_auth(&mut cfg, "devbox", AuthMode::Password);
        cfg.hosts.get_mut("devbox").unwrap().os = Some(HostOs::Windows);
        apply_auth(&mut cfg, "devbox", AuthMode::Auto);
        let h = cfg.hosts.get("devbox").expect("os cache keeps the entry");
        assert_eq!(h.auth, AuthMode::Auto);
        assert_eq!(h.os, Some(HostOs::Windows));

        // Without a cached os, auto still drops the whole entry.
        apply_auth(&mut cfg, "plain", AuthMode::Password);
        apply_auth(&mut cfg, "plain", AuthMode::Auto);
        assert!(!cfg.hosts.contains_key("plain"));
    }

    #[test]
    fn host_os_roundtrips_and_defaults() {
        let cfg: Config = serde_json::from_str(r#"{"hosts":{"win":{"os":"windows"}}}"#).unwrap();
        assert_eq!(cfg.hosts["win"].os, Some(HostOs::Windows));
        assert_eq!(cfg.hosts["win"].auth, AuthMode::Auto);
        // A config written before the field existed still loads.
        let old: Config =
            serde_json::from_str(r#"{"hosts":{"devbox":{"auth":"password"}}}"#).unwrap();
        assert_eq!(old.hosts["devbox"].os, None);
        let json = serde_json::to_string(&Config::default()).unwrap();
        assert!(!json.contains("\"os\""));
    }
}

//! UI language and text that exists in both languages at once.
//!
//! `Lang` is the user's choice (stored in `~/.faragent/config.json`).
//! `LocalizedText` is how feature code hands wording to a UI without knowing
//! which language it renders in: both languages are computed eagerly and the
//! UI picks one. That keeps feature modules free of any UI language state —
//! the TUI picks with its current `Lang`, a GUI can pick per render.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

impl Lang {
    pub const ALL: [Lang; 2] = [Lang::Zh, Lang::En];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "zh" | "zh-cn" | "zh-hans" | "cn" | "chinese" => Some(Self::Zh),
            "en" | "en-us" | "en-gb" | "english" => Some(Self::En),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::Zh => "zh",
            Self::En => "en",
        }
    }

    pub fn native_name(self) -> &'static str {
        match self {
            Self::Zh => "中文",
            Self::En => "English",
        }
    }
}

/// A string (or list of strings) held in both languages.
///
/// Fields are public so tests and call sites can take a specific language
/// directly (`.zh` / `.en`) when they are not rendering for a user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalizedText<T> {
    pub zh: T,
    pub en: T,
}

impl<T> LocalizedText<T> {
    pub const fn new(zh: T, en: T) -> Self {
        Self { zh, en }
    }
}

impl<T: Clone> LocalizedText<T> {
    /// The text for `lang`.
    pub fn pick(&self, lang: Lang) -> T {
        match lang {
            Lang::Zh => self.zh.clone(),
            Lang::En => self.en.clone(),
        }
    }
}

/// A multi-line body (screen text, fix steps) in both languages.
pub type Lines = LocalizedText<Vec<String>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_aliases() {
        assert_eq!(Lang::parse("zh-CN"), Some(Lang::Zh));
        assert_eq!(Lang::parse("en"), Some(Lang::En));
        assert_eq!(Lang::parse("nope"), None);
    }

    #[test]
    fn pick_selects_the_language() {
        let text = LocalizedText::new("你好".to_string(), "hello".to_string());
        assert_eq!(text.pick(Lang::Zh), "你好");
        assert_eq!(text.pick(Lang::En), "hello");
        let lines: Lines = LocalizedText::new(vec!["一".into()], vec!["one".into()]);
        assert_eq!(lines.pick(Lang::En), vec!["one".to_string()]);
    }
}

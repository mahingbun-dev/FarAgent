//! Shell quoting shared by everything that builds a remote command line.

/// Quote one token for a POSIX shell; safe tokens pass through untouched.
pub fn shell_single_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:@%=+,".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_safe_and_unsafe() {
        assert_eq!(shell_single_quote("abc"), "abc");
        assert_eq!(shell_single_quote("a b"), "'a b'");
        assert_eq!(shell_single_quote("a'b"), "'a'\"'\"'b'");
    }
}

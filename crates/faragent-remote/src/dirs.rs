//! `FARAGENT_DIRS_V1`: list child directories of one remote path.
//! Scripts never create directories.

use faragent_core::shell::shell_single_quote;
use faragent_core::vocab::HostOs;

use crate::win::UTF8_PREAMBLE;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirListing {
    pub cwd: String,
    pub parent: String,
    pub dirs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirListError {
    NotADir { path: String },
    Unreadable { path: String, hint: String },
}

/// POSIX path is inlined (always single-quoted) so spaces and metacharacters
/// cannot become extra shell words.
fn posix_quoted(path: &str) -> String {
    let q = shell_single_quote(path);
    if q.starts_with('\'') {
        q
    } else {
        format!("'{q}'")
    }
}

pub fn posix_list_script(path: &str) -> String {
    let path_q = posix_quoted(path);
    format!(
        r#"
printf 'FARAGENT_DIRS_V1\n'
if [ ! -d {path_q} ]; then
  printf 'err\tnot_a_dir\t%s\n' {path_q}
  exit 0
fi
if [ ! -r {path_q} ] || [ ! -x {path_q} ]; then
  printf 'err\tunreadable\t%s\n' {path_q}
  exit 0
fi
_parent=$(dirname -- {path_q})
_cwd=$(printf '%s' {path_q} | tr '\t\n\r' '   ')
_parent=$(printf '%s' "$_parent" | tr '\t\n\r' '   ')
printf 'cwd\t%s\n' "$_cwd"
printf 'parent\t%s\n' "$_parent"
for _n in {path_q}/* {path_q}/.[!.]* {path_q}/..?*; do
  [ -d "$_n" ] || continue
  _b=${{_n##*/}}
  [ "$_b" = "." ] && continue
  [ "$_b" = ".." ] && continue
  _b=$(printf '%s' "$_b" | tr '\t\n\r' '   ')
  printf 'dir\t%s\n' "$_b"
done
printf 'ok\n'
"#
    )
}

/// Path is `$args[0]` as UTF-8 base64, same as the other Windows scripts.
pub fn win_list_script() -> String {
    format!(
        r#"{UTF8_PREAMBLE}
Write-Output 'FARAGENT_DIRS_V1'
$cwd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]))
function Clean([string]$s) {{ return ($s -replace "[`t`r`n]", ' ') }}
if (-not (Test-Path -LiteralPath $cwd -PathType Container)) {{
  Write-Output ("err`tnot_a_dir`t{{0}}" -f (Clean $cwd))
  exit 0
}}
try {{
  $items = @(Get-ChildItem -LiteralPath $cwd -Directory -Force -ErrorAction Stop)
}} catch {{
  Write-Output ("err`tunreadable`t{{0}}`t{{1}}" -f (Clean $cwd), (Clean ([string]$_.Exception.Message)))
  exit 0
}}
$parent = [IO.Path]::GetDirectoryName($cwd)
if ([string]::IsNullOrEmpty($parent)) {{ $parent = $cwd }}
Write-Output ("cwd`t{{0}}" -f (Clean $cwd))
Write-Output ("parent`t{{0}}" -f (Clean $parent))
foreach ($i in $items) {{
  if ($i.Name -eq '.' -or $i.Name -eq '..') {{ continue }}
  Write-Output ("dir`t{{0}}" -f (Clean $i.Name))
}}
Write-Output 'ok'
"#
    )
}

pub fn parse_listing(text: &str) -> Result<DirListing, DirListError> {
    const MAGIC: &str = "FARAGENT_DIRS_V1";
    let Some(idx) = text.find(MAGIC) else {
        return Err(DirListError::Unreadable {
            path: String::new(),
            hint: "remote output missing FARAGENT_DIRS_V1".into(),
        });
    };
    let mut cwd = String::new();
    let mut parent = String::new();
    let mut dirs = Vec::new();
    for line in text[idx..].lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line == MAGIC {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        match cols.first().copied() {
            Some("cwd") => cwd = cols.get(1).unwrap_or(&"").to_string(),
            Some("parent") => parent = cols.get(1).unwrap_or(&"").to_string(),
            Some("dir") => {
                let name = cols.get(1).copied().unwrap_or("");
                if !name.is_empty() && name != "." && name != ".." {
                    dirs.push(name.to_string());
                }
            }
            Some("err") => {
                let kind = cols.get(1).copied().unwrap_or("");
                let path = cols.get(2).unwrap_or(&"").to_string();
                let hint = cols.get(3).unwrap_or(&"").to_string();
                return match kind {
                    "not_a_dir" => Err(DirListError::NotADir { path }),
                    _ => Err(DirListError::Unreadable { path, hint }),
                };
            }
            _ => {}
        }
    }
    if cwd.is_empty() {
        return Err(DirListError::Unreadable {
            path: String::new(),
            hint: "listing did not include cwd".into(),
        });
    }
    Ok(DirListing { cwd, parent, dirs })
}

pub fn join_dir(cwd: &str, name: &str, os: HostOs) -> String {
    match os {
        HostOs::Posix => {
            if name == ".." {
                posix_parent(cwd)
            } else if posix_is_root(cwd) {
                format!("/{name}")
            } else {
                format!("{}/{name}", cwd.trim_end_matches('/'))
            }
        }
        HostOs::Windows => {
            if name == ".." {
                win_parent(cwd)
            } else {
                format!("{}\\{name}", win_join_base(cwd))
            }
        }
    }
}

fn posix_is_root(cwd: &str) -> bool {
    !cwd.is_empty() && cwd.chars().all(|c| c == '/')
}

fn posix_parent(cwd: &str) -> String {
    if posix_is_root(cwd) {
        return "/".into();
    }
    let trimmed = cwd.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", _)) => "/".into(),
        Some((parent, _)) => parent.to_string(),
        None => ".".into(),
    }
}

fn win_is_drive_root(cwd: &str) -> bool {
    let t = cwd.trim_end_matches('\\');
    let b = t.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

fn win_drive_root(cwd: &str) -> String {
    format!("{}\\", cwd.trim_end_matches('\\'))
}

fn win_join_base(cwd: &str) -> String {
    cwd.trim_end_matches('\\').to_string()
}

fn win_parent(cwd: &str) -> String {
    if win_is_drive_root(cwd) {
        return win_drive_root(cwd);
    }
    let trimmed = cwd.trim_end_matches('\\');
    match trimmed.rsplit_once('\\') {
        Some((parent, _)) if win_is_drive_root(parent) => win_drive_root(parent),
        Some((parent, _)) if !parent.is_empty() => parent.to_string(),
        _ => cwd.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_listing_reads_cwd_parent_and_dirs() {
        let text = "\
banner
FARAGENT_DIRS_V1
cwd	/home/me
parent	/home
dir	code
dir	docs
ok
";
        let l = parse_listing(text).unwrap();
        assert_eq!(l.cwd, "/home/me");
        assert_eq!(l.parent, "/home");
        assert_eq!(l.dirs, vec!["code", "docs"]);
    }

    #[test]
    fn parse_listing_not_a_dir() {
        let text = "FARAGENT_DIRS_V1\nerr\tnot_a_dir\t/nope\n";
        match parse_listing(text) {
            Err(DirListError::NotADir { path }) => assert_eq!(path, "/nope"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn join_dir_posix_and_windows() {
        use faragent_core::vocab::HostOs;
        assert_eq!(join_dir("/home/me", "code", HostOs::Posix), "/home/me/code");
        assert_eq!(join_dir("/", "etc", HostOs::Posix), "/etc");
        assert_eq!(
            join_dir("C:\\Users\\me", "code", HostOs::Windows),
            "C:\\Users\\me\\code"
        );
        assert_eq!(join_dir("C:\\", "Users", HostOs::Windows), "C:\\Users");
    }

    #[test]
    fn parse_listing_unreadable() {
        let text = "FARAGENT_DIRS_V1\nerr\tunreadable\t/secret\n";
        match parse_listing(text) {
            Err(DirListError::Unreadable { path, .. }) => assert_eq!(path, "/secret"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_listing_skips_dot_and_dotdot() {
        let text = "\
FARAGENT_DIRS_V1
cwd	/home/me
parent	/home
dir	.
dir	..
dir	code
ok
";
        let l = parse_listing(text).unwrap();
        assert_eq!(l.dirs, vec!["code"]);
    }

    #[test]
    fn join_dir_dotdot_is_parent() {
        use faragent_core::vocab::HostOs;
        assert_eq!(join_dir("/home/me", "..", HostOs::Posix), "/home");
        assert_eq!(join_dir("/", "..", HostOs::Posix), "/");
        assert_eq!(
            join_dir("C:\\Users\\me", "..", HostOs::Windows),
            "C:\\Users"
        );
        assert_eq!(join_dir("C:\\", "..", HostOs::Windows), "C:\\");
        assert_eq!(join_dir("C:\\Users", "..", HostOs::Windows), "C:\\");
    }

    #[test]
    fn posix_script_has_marker_no_python_no_mkdir() {
        let s = posix_list_script("/home/me/app");
        assert!(s.contains("FARAGENT_DIRS_V1"));
        assert!(s.contains("'/home/me/app'"));
        assert!(!s.contains("python"));
        assert!(!s.contains("mkdir"));
    }

    #[test]
    fn win_script_has_marker_and_preamble() {
        let s = win_list_script();
        assert!(s.contains("FARAGENT_DIRS_V1"));
        assert!(s.contains("Get-ChildItem"));
        assert!(s.contains("[Console]::OutputEncoding"));
        assert!(s.contains("[Convert]::FromBase64String($args[0])"));
        assert!(s.contains("Get-ChildItem -LiteralPath $cwd -Directory -Force"));
        assert!(s.is_ascii());
        assert!(!s.contains("mkdir"));
        assert!(!s.contains("New-Item"));
        assert!(!s.contains("python"));
    }

    #[cfg(unix)]
    #[test]
    fn posix_script_lists_only_child_directories() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!(
            "faragent-dirs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(tmp.join("code")).unwrap();
        std::fs::create_dir_all(tmp.join("docs")).unwrap();
        std::fs::create_dir_all(tmp.join(".hidden")).unwrap();
        std::fs::write(tmp.join("file.txt"), b"x").unwrap();
        let path = tmp.to_str().unwrap();
        let out = std::process::Command::new("bash")
            .args(["-lc", &posix_list_script(path)])
            .output()
            .expect("bash");
        assert!(
            out.status.success(),
            "stderr={}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text = String::from_utf8_lossy(&out.stdout);
        let l = parse_listing(&text).unwrap_or_else(|e| panic!("{e:?} stdout={text}"));
        assert_eq!(l.cwd, path);
        assert_eq!(l.parent, tmp.parent().unwrap().to_str().unwrap());
        let mut dirs = l.dirs.clone();
        dirs.sort();
        assert_eq!(dirs, vec![".hidden", "code", "docs"]);

        let missing = tmp.join("nope");
        let err_out = std::process::Command::new("bash")
            .args(["-lc", &posix_list_script(missing.to_str().unwrap())])
            .output()
            .expect("bash");
        let err_text = String::from_utf8_lossy(&err_out.stdout);
        match parse_listing(&err_text) {
            Err(DirListError::NotADir { path }) => {
                assert_eq!(path, missing.to_str().unwrap());
            }
            other => panic!("{other:?} stdout={err_text}"),
        }

        let empty = tmp.join("code");
        let empty_out = std::process::Command::new("bash")
            .args(["-lc", &posix_list_script(empty.to_str().unwrap())])
            .output()
            .expect("bash");
        let empty_text = String::from_utf8_lossy(&empty_out.stdout);
        let empty_l =
            parse_listing(&empty_text).unwrap_or_else(|e| panic!("{e:?} stdout={empty_text}"));
        assert_eq!(empty_l.cwd, empty.to_str().unwrap());
        assert!(empty_l.dirs.is_empty(), "{empty_l:?}");

        let spaced = tmp.join("my app");
        std::fs::create_dir_all(spaced.join("src")).unwrap();
        let spaced_out = std::process::Command::new("bash")
            .args(["-lc", &posix_list_script(spaced.to_str().unwrap())])
            .output()
            .expect("bash");
        let spaced_text = String::from_utf8_lossy(&spaced_out.stdout);
        let spaced_l =
            parse_listing(&spaced_text).unwrap_or_else(|e| panic!("{e:?} stdout={spaced_text}"));
        assert_eq!(spaced_l.cwd, spaced.to_str().unwrap());
        assert_eq!(spaced_l.dirs, vec!["src"]);

        let secret = tmp.join("secret");
        std::fs::create_dir(&secret).unwrap();
        let mut perms = std::fs::metadata(&secret).unwrap().permissions();
        perms.set_mode(0o000);
        std::fs::set_permissions(&secret, perms).unwrap();
        let secret_out = std::process::Command::new("bash")
            .args(["-lc", &posix_list_script(secret.to_str().unwrap())])
            .output()
            .expect("bash");
        let secret_text = String::from_utf8_lossy(&secret_out.stdout);
        let mut restore = std::fs::metadata(&secret).unwrap().permissions();
        restore.set_mode(0o755);
        std::fs::set_permissions(&secret, restore).unwrap();
        match parse_listing(&secret_text) {
            Err(DirListError::Unreadable { path, .. }) => {
                assert_eq!(path, secret.to_str().unwrap());
            }
            other => panic!("{other:?} stdout={secret_text}"),
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }
}

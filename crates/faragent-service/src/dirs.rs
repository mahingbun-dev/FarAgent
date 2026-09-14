//! List child directories of one remote path. Never creates directories.
//! The caller expands `~`; this module forwards the path as given.

use anyhow::{anyhow, Result};
use faragent_core::vocab::HostOs;
use faragent_remote::dirs as remote_dirs;
use faragent_remote::win;
use faragent_transport::{run_login, run_win_login_args, OpenSshTransport};

pub use faragent_remote::dirs::{DirListError, DirListing};

pub fn list_dirs(host: &str, os: HostOs, path: &str) -> Result<DirListing> {
    let client = OpenSshTransport::connect(host)?;
    let text = match os {
        HostOs::Posix => run_login(&client, &remote_dirs::posix_list_script(path))?,
        HostOs::Windows => {
            let path_b64 = win::b64(path);
            run_win_login_args(&client, &remote_dirs::win_list_script(), &[&path_b64])?
        }
    };
    remote_dirs::parse_listing(&text).map_err(dir_list_error)
}

fn dir_list_error(err: DirListError) -> anyhow::Error {
    match err {
        DirListError::NotADir { path } => anyhow!("not a directory: {path}"),
        DirListError::Unreadable { path, hint } if hint.is_empty() => {
            anyhow!("unreadable directory: {path}")
        }
        DirListError::Unreadable { path, hint } => {
            anyhow!("unreadable directory: {path}: {hint}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_list_error_maps_variants_without_error_impl() {
        let not_dir = dir_list_error(DirListError::NotADir {
            path: "/nope".into(),
        });
        assert!(not_dir.to_string().contains("/nope"));
        assert!(not_dir.to_string().contains("not a directory"));

        let unread = dir_list_error(DirListError::Unreadable {
            path: "/secret".into(),
            hint: "permission denied".into(),
        });
        assert!(unread.to_string().contains("/secret"));
        assert!(unread.to_string().contains("permission denied"));
    }
}

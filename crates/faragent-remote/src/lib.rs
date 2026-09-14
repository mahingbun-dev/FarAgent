//! The remote-side protocol: the POSIX (bash + tmux) and Windows (cmd +
//! PowerShell) dialects of FarAgent's scripts, and the parsers for their
//! output. Pure data — no processes, no connection; the transport crate
//! executes what this crate builds.

pub mod dirs;
pub mod fs;
pub mod git;
pub mod remote;
pub mod win;

/// The token [`fs::POSIX_FALLBACK_HEAD`] spells the fallback's version into,
/// replaced with this crate's version by [`posix_fallback_script`].
///
/// It is a placeholder rather than a `format!` argument because the script is a
/// single raw string; substituting the version when the script is assembled
/// keeps the literal `@@VERSION@@` visible in the source that surrounds it.
pub const POSIX_FALLBACK_VERSION_PLACEHOLDER: &str = "@@VERSION@@";

/// The whole bash fallback channel, ready to stream to a remote.
///
/// This is the last resort when the `faragent-helper` binary cannot be deployed
/// (no build for the remote's architecture, a `noexec` mount, an unwritable
/// home, no checksum tool). It is a script, not a program: the transport sends
/// it once — `bash -lc '<script>'` with all three stdio piped, the same channel
/// the helper is spoken over — and thereafter writes request frames to its stdin
/// and reads reply frames from its stdout. The wire format is
/// `faragent_helper::proto`'s, so the same client parser serves both.
///
/// The script implements a read-only subset: `ping`, `fs.list`, `fs.read`,
/// `fs.stat`, `git.discover`, `git.status`, `git.log`. An op outside that set
/// gets a `bad_request` naming what is there, rather than silence.
pub fn posix_fallback_script() -> String {
    let mut script =
        String::with_capacity(fs::POSIX_FALLBACK_HEAD.len() + git::POSIX_FALLBACK_TAIL.len());
    script.push_str(fs::POSIX_FALLBACK_HEAD);
    script.push_str(git::POSIX_FALLBACK_TAIL);
    script.replace(
        POSIX_FALLBACK_VERSION_PLACEHOLDER,
        env!("CARGO_PKG_VERSION"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_script_is_one_program_with_one_version_and_no_carriage_returns() {
        let head = fs::POSIX_FALLBACK_HEAD;
        let tail = git::POSIX_FALLBACK_TAIL;
        // The placeholder is exactly once, alone in the head, and gone from the
        // assembled script — otherwise a second copy would ship the literal
        // `@@VERSION@@` inside a JSON string.
        assert_eq!(head.matches(POSIX_FALLBACK_VERSION_PLACEHOLDER).count(), 1);
        assert_eq!(tail.matches(POSIX_FALLBACK_VERSION_PLACEHOLDER).count(), 0);

        let script = posix_fallback_script();
        assert!(!script.contains(POSIX_FALLBACK_VERSION_PLACEHOLDER));
        // The version lands inside the script's `ping` frame, where the quotes
        // are shell-escaped (`\"version\":\"0.2.0\"`); the frame those escapes
        // decode to is checked in `tests/fallback.rs`, where the script runs.
        assert!(script.contains(&format!(
            "\\\"version\\\":\\\"{}\\\"",
            env!("CARGO_PKG_VERSION")
        )));
        // The transport hands the script to `bash -lc` as one argument; a CR
        // would end up inside it. Nothing here needs one.
        assert!(!script.contains('\r'));
        // Head and tail are adjacent and complete: the script opens with the
        // head (up to the version placeholder, the only thing that changes) and
        // closes with the tail, and assembly dropped nothing.
        let (head_before, head_after) = head
            .split_once(POSIX_FALLBACK_VERSION_PLACEHOLDER)
            .expect("head holds the placeholder");
        assert!(script.starts_with(head_before));
        assert!(script.ends_with(tail));
        assert_eq!(
            script.len(),
            // `head_before` and `head_after` are the head without the
            // placeholder, so the placeholder's own length is not subtracted
            // again here.
            (head_before.len() + head_after.len()) + tail.len() + env!("CARGO_PKG_VERSION").len()
        );
        assert!(script.trim_end().ends_with("exit 0"));
        // Every op the fallback advertises, in the script that serves it.
        for op in [
            "ping",
            "fs.list",
            "fs.read",
            "fs.stat",
            "git.discover",
            "git.status",
            "git.log",
        ] {
            assert!(script.contains(op), "missing op {op}");
        }
        // ... and no write op, and no forbidden dependency.
        for forbidden in [
            "fs.write",
            "fs.rename",
            "fs.remove",
            "fs.mkdir",
            "fs.upload",
            "python",
            "perl",
        ] {
            assert!(!script.contains(forbidden), "unexpected {forbidden}");
        }
    }

    #[test]
    fn fallback_script_never_splices_untrusted_text_unquoted() {
        // Every value that can hold arbitrary bytes must be handed to `b64`.
        // This is a coarse guard on a property that `tests/fallback.rs` proves
        // by running hostile bytes through the script for real.
        let script = posix_fallback_script();
        assert!(script.contains("message_b64"));
        for field in [
            "path_b64",
            "name_b64",
            "data_b64",
            "branch_b64",
            "message_b64",
            "root_b64",
            "git_dir_b64",
            "upstream_b64",
            "orig_path_b64",
            "author_b64",
            "email_b64",
            "refs_b64",
            "subject_b64",
            "parent_b64",
        ] {
            assert!(script.contains(field), "missing {field}");
        }
        // The base64 output of `b64` is what makes a frame unbreakable; if the
        // encoder were replaced by something that leaves quotes behind, this
        // would be the place to notice.
        assert!(script.contains("base64"));
        assert!(!script.contains("json.dump"));
    }
}

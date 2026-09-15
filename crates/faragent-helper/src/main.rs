//! `faragent-helper` — the remote-side half of the FarAgent command channel.
//!
//! Reads NDJSON requests on stdin, serves them, writes frames on stdout, and
//! stays up until `shutdown` or EOF. Diagnostics go to stderr, never stdout:
//! stdout is the frame stream and one stray line in it would be a protocol
//! violation (a client skips it, but a debugger's sanity does not).
//!
//! The transport starts this with `ssh -T` and all three stdio piped, so a
//! login banner may arrive *around* the frames — hence the line-by-line
//! "skip what does not parse" rule in [`proto::parse_line`].
//!
//! `--version` and `--help` are answered before stdin is touched. Additive, and
//! for one reason: the upload's own verification (`docs/*/acceptance.md`) asks
//! the binary that landed whether it runs, and without them that question had no
//! answer but a hang — the serving loop would sit on a stdin nobody was writing
//! to. An argument-less run is still exactly the serving loop.

use faragent_helper::proto::{self, Line};
use faragent_helper::{shared_writer, Outcome, Session};
use std::io::{BufReader, Write};

/// What `--help` prints. The usage line names the only real invocation.
const USAGE: &str = "\
usage: faragent-helper [--version | --help]

Serves the FarAgent helper protocol as one NDJSON request per line on stdin,
answering on stdout. Started by FarAgent over ssh with no arguments and no
terminal; not useful to run by hand except to check that the binary works.";

fn main() {
    if let Some(arg) = std::env::args().nth(1) {
        std::process::exit(meta(&arg));
    }
    std::process::exit(run());
}

/// `--version` / `--help`, or a usage error. The exit status is the answer.
fn meta(arg: &str) -> i32 {
    match arg {
        "--version" | "-V" => {
            // The same string `ping` answers with, so the acceptance check and
            // the protocol cannot report two different versions of one binary.
            println!("faragent-helper {}", env!("CARGO_PKG_VERSION"));
            0
        }
        "--help" | "-h" => {
            println!("{USAGE}");
            0
        }
        // An unknown flag is a usage error rather than a silent start: falling
        // through to the serving loop for a typo turns "wrong flag" into the
        // hang this whole branch exists to remove. Nothing in the app passes an
        // argument (`spawn_login_stdio_stream(REMOTE_HELPER_PATH)` sends the bare
        // path), so this can only be reached by hand.
        _ => {
            eprintln!("faragent-helper: unrecognized argument `{arg}`");
            eprintln!("{USAGE}");
            2
        }
    }
}

/// The serving loop. Returns the process exit status.
fn run() -> i32 {
    let stdin = std::io::stdin();
    let mut input = BufReader::new(stdin.lock());
    let mut session = Session::new(shared_writer(Box::new(std::io::stdout())));
    loop {
        match proto::read_line(&mut input) {
            // The peer closed the pipe: an orderly end, not a failure.
            Ok(Line::Eof) => return 0,
            Ok(Line::Oversized) => session.reject_oversized(),
            Ok(Line::Frame(line)) => {
                // Blank lines separate records in no framing scheme we use, but
                // a stray newline costs nothing to ignore.
                if line.iter().all(|b| b.is_ascii_whitespace()) {
                    continue;
                }
                if session.handle(&line) == Outcome::Exit {
                    return 0;
                }
            }
            Err(error) => {
                let _ = writeln!(std::io::stderr(), "faragent-helper: stdin: {error}");
                return 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::meta;

    /// The statuses, not the text: `println!` writes to the real stdout, and the
    /// point here is that each flag *returns* rather than falling into `run`.
    #[test]
    fn the_metadata_flags_answer_instead_of_reading_stdin() {
        assert_eq!(meta("--version"), 0);
        assert_eq!(meta("-V"), 0);
        assert_eq!(meta("--help"), 0);
        assert_eq!(meta("-h"), 0);
    }

    #[test]
    fn an_unrecognized_argument_is_a_usage_error_not_a_silent_start() {
        // 0 would be "answered", anything else would be a server nobody can
        // reach: the only safe status for a flag this binary does not know.
        assert_eq!(meta("--versionn"), 2);
        assert_eq!(meta("--serve"), 2);
    }
}

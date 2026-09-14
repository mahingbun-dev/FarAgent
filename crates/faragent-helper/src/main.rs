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

use faragent_helper::proto::{self, Line};
use faragent_helper::{shared_writer, Outcome, Session};
use std::io::{BufReader, Write};

fn main() {
    std::process::exit(run());
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

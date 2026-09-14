//! Op dispatch — one arm per op in the phase-1 set.

pub mod fs;
pub mod git;

use crate::proto::{ProtoError, Request};
use crate::Session;
use serde_json::{json, Value};

/// What an op asks the serving loop to do next.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Write `data` as the reply and keep serving.
    Reply(Value),
    /// Write the reply, then leave the loop and exit cleanly.
    Shutdown(Value),
}

/// The phase-1 op names, in the order the brief lists them. Exposed so a test
/// (or the app's helper manager) can assert the set is exactly this.
pub const OPS: [&str; 12] = [
    "ping",
    "fs.list",
    "fs.read",
    "fs.stat",
    "git.discover",
    "git.status",
    "git.branches",
    "git.diff",
    "git.log",
    "watch.subscribe",
    "watch.unsubscribe",
    "shutdown",
];

pub fn dispatch(session: &mut Session, req: &Request) -> Result<Action, ProtoError> {
    Ok(match req.op.as_str() {
        "ping" => Action::Reply(ping()),
        "fs.list" => Action::Reply(fs::list(req)?),
        "fs.read" => Action::Reply(fs::read(req)?),
        "fs.stat" => Action::Reply(fs::stat(req)?),
        "git.discover" => Action::Reply(git::discover_op(req)?),
        "git.status" => Action::Reply(git::status(req)?),
        "git.branches" => Action::Reply(git::branches(req)?),
        "git.diff" => Action::Reply(git::diff(req)?),
        "git.log" => Action::Reply(git::log(req)?),
        "watch.subscribe" => Action::Reply(crate::watch::subscribe(session.watchers_mut(), req)?),
        "watch.unsubscribe" => Action::Reply(crate::watch::unsubscribe(session.watchers_mut(), req)?),
        // The reply goes out first; the loop then unwinds so the caller sees
        // the process exit rather than a closed pipe.
        "shutdown" => Action::Shutdown(json!({ "bye": true })),
        other => {
            return Err(ProtoError::bad_request(format!(
                "unknown op `{other}`; this helper speaks: {}",
                OPS.join(", ")
            )))
        }
    })
}

/// A liveness probe: identity, not process state, because "alive" is exactly
/// "the reply arrived".
fn ping() -> Value {
    json!({
        "pong": true,
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "ops": OPS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_op_set_is_the_phase_one_set() {
        let mut sorted = OPS.to_vec();
        sorted.sort_unstable();
        let mut deduped = sorted.clone();
        deduped.dedup();
        assert_eq!(sorted, deduped, "no duplicate op names");
        assert_eq!(OPS.len(), 12);
        for op in OPS {
            assert!(op.is_empty() || !op.contains(' '), "{op}");
        }
    }
}

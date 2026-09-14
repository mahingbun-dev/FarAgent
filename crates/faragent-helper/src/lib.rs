//! The FarAgent remote helper.
//!
//! A long-lived process on the remote host speaking [`proto`] NDJSON frames on
//! stdio. The desktop app reaches it through
//! `OpenSshTransport::spawn_stdio_stream` (no PTY, all three stdio piped) and
//! asks it questions — list a directory, read a file, show a diff, watch for
//! changes — instead of running one script per question.
//!
//! The wire protocol lives in exactly one place: [`proto`]. Everything else
//! here (the ops, the subscriptions, the serving loop) only builds or reads
//! those frames.
//!
//! ```text
//! {"id":1,"op":"ping"}                                ->
//! {"id":1,"ok":true,"data":{"pong":true,...}}         <-
//! ```

pub mod ops;
pub mod proto;
pub mod watch;

use proto::{Frame, ProtoError, Request};
use serde_json::Value;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Where frames go. `Arc<Mutex<…>>` because the pusher thread in [`watch`]
/// writes while the serving loop is blocked on stdin.
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Wrap a writer for the session.
pub fn shared_writer(writer: Box<dyn Write + Send>) -> SharedWriter {
    Arc::new(Mutex::new(writer))
}

/// Write one frame, cap-enforced by [`proto::Frame::encode`].
///
/// A write error is deliberately swallowed: the reader is gone, and the loop
/// discovers that on its next read from stdin. Panicking here would take down
/// a process whose only problem is that its peer closed the pipe.
pub(crate) fn write_frame(out: &SharedWriter, frame: Frame) {
    let line = frame.encode();
    let Ok(mut writer) = out.lock() else {
        return;
    };
    if writer.write_all(&line).is_err() {
        return;
    }
    let _ = writer.flush();
}

/// What the serving loop should do after one line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Keep reading.
    Continue,
    /// `shutdown` was served; leave the loop.
    Exit,
}

/// One connection's state: where replies go, and what is being watched.
pub struct Session {
    out: SharedWriter,
    watchers: watch::Watchers,
}

impl Session {
    pub fn new(out: SharedWriter) -> Self {
        Self::with_poll_interval(out, watch::GIT_POLL_INTERVAL)
    }

    /// As [`Session::new`], with the git-metadata poll interval overridden —
    /// the tests use a short one so a commit is noticed in milliseconds.
    pub fn with_poll_interval(out: SharedWriter, poll: Duration) -> Self {
        let watchers = watch::Watchers::with_poll_interval(Arc::clone(&out), poll);
        Self { out, watchers }
    }

    pub fn out(&self) -> &SharedWriter {
        &self.out
    }

    pub fn emit(&self, frame: Frame) {
        write_frame(&self.out, frame);
    }

    pub(crate) fn watchers_mut(&mut self) -> &mut watch::Watchers {
        &mut self.watchers
    }

    /// Serve one inbound line. Malformed input is answered, never fatal — a
    /// client sending nonsense gets `bad_request` and the session lives on.
    pub fn handle(&mut self, line: &[u8]) -> Outcome {
        let request = match Request::from_line(line) {
            Ok(request) => request,
            Err(error) => {
                // The id may still be readable even when the rest is not; echo
                // it so the client can attribute the failure.
                self.emit(Frame::error(id_of(line), error));
                return Outcome::Continue;
            }
        };
        let id = request.id.clone();
        match ops::dispatch(self, &request) {
            Ok(ops::Action::Reply(data)) => {
                self.emit(Frame::reply(id, data));
                Outcome::Continue
            }
            Ok(ops::Action::Shutdown(data)) => {
                self.emit(Frame::reply(id, data));
                Outcome::Exit
            }
            Err(error) => {
                self.emit(Frame::error(id, error));
                Outcome::Continue
            }
        }
    }

    /// Answer a line that was too long to buffer. The line is already gone, so
    /// the reply carries a `null` id; the client sees `bad_request` and the
    /// stream resynchronises at the next newline.
    pub fn reject_oversized(&self) {
        self.emit(Frame::error(
            Value::Null,
            ProtoError::bad_request(format!(
                "request frame exceeds the {} byte cap",
                proto::MAX_FRAME_BYTES
            )),
        ));
    }
}

/// Best-effort `id` from a malformed frame.
fn id_of(line: &[u8]) -> Value {
    serde_json::from_slice::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").cloned())
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> (Session, Arc<Mutex<Vec<u8>>>) {
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        struct Tee(Arc<Mutex<Vec<u8>>>);
        impl Write for Tee {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let out = shared_writer(Box::new(Tee(Arc::clone(&buf))));
        (Session::new(out), buf)
    }

    fn read_frames(buf: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let text = buf.lock().unwrap().clone();
        String::from_utf8(text)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn ping_replies_and_keeps_serving() {
        let (mut session, buf) = session();
        assert_eq!(
            session.handle(br#"{"id":1,"op":"ping"}"#),
            Outcome::Continue
        );
        assert_eq!(
            session.handle(br#"{"id":2,"op":"ping"}"#),
            Outcome::Continue
        );
        let frames = read_frames(&buf);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["id"], json!(1));
        assert_eq!(frames[0]["data"]["pong"], json!(true));
        assert_eq!(frames[1]["id"], json!(2));
    }

    #[test]
    fn malformed_input_never_panics_and_stays_in_sync() {
        let (mut session, buf) = session();
        for line in [
            &b""[..],
            b"a login banner",
            b"{\"id\":7}",
            b"{\"id\":8,\"op\":42}",
            b"{\"id\":9,\"op\":\"fs.list\",\"path_b64\":\"!!\"}",
            b"{\"id\":10,\"op\":\"no.such.op\"}",
            b"[1,2,3]",
        ] {
            assert_eq!(session.handle(line), Outcome::Continue);
        }
        // Every one of them was answered, and the ones that had a readable id
        // came back under that id.
        let frames = read_frames(&buf);
        assert_eq!(frames.len(), 7);
        for frame in &frames {
            assert_eq!(frame["ok"], json!(false));
            assert_eq!(frame["error"]["code"], json!("bad_request"), "{frame}");
        }
        assert_eq!(frames[2]["id"], json!(7));
        assert_eq!(frames[6]["id"], json!(null));
        // The session is still usable afterwards.
        assert_eq!(
            session.handle(br#"{"id":11,"op":"ping"}"#),
            Outcome::Continue
        );
        let frames = read_frames(&buf);
        assert_eq!(frames.len(), 8);
        assert_eq!(frames[7]["id"], json!(11));
    }

    #[test]
    fn shutdown_asks_the_loop_to_stop() {
        let (mut session, buf) = session();
        assert_eq!(
            session.handle(br#"{"id":1,"op":"shutdown"}"#),
            Outcome::Exit
        );
        let frames = read_frames(&buf);
        assert_eq!(frames[0]["ok"], json!(true));
        assert_eq!(frames[0]["data"]["bye"], json!(true));
    }

    #[test]
    fn an_oversized_line_is_answered_then_forgotten() {
        let (session, buf) = session();
        session.reject_oversized();
        let frames = read_frames(&buf);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["id"], json!(null));
        assert_eq!(frames[0]["error"]["code"], json!("bad_request"));
    }

    #[test]
    fn bad_base64_is_rejected_with_the_callers_id() {
        let (mut session, buf) = session();
        session.handle(br#"{"id":"req-3","op":"fs.stat","path_b64":"not base64!"}"#);
        let frames = read_frames(&buf);
        assert_eq!(frames[0]["id"], json!("req-3"));
        assert_eq!(frames[0]["error"]["code"], json!("bad_request"));
    }
}

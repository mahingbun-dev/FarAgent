//! The helper channel: one framed NDJSON connection per host, driven from the
//! webview through three commands.
//!
//! This is the app-side twin of [`faragent_helper`]. It owns the *client* half
//! of the protocol: it writes request frames, reads reply frames, matches a
//! reply to the call that is waiting for it, and forwards the helper's
//! unsolicited pushes to the frontend. The wire types themselves are imported
//! from `faragent_helper::proto` — there is no second parser, no second
//! framing, and no restructuring of a frame anywhere in this file.
//!
//! # Shape of a session
//!
//! ```text
//!   helper_open(host)  ──►  probe os ──► ensure_helper ──► HelperMode
//!                                                        │
//!                              native ────────────────────┤
//!                              script fallback ──────────┤
//!                                                        ▼
//!                                          ssh -T  bash -lc …
//!                                                        │
//!   helper_call(id, op, args) ──► frame {"id":n,"op":…} ──┤
//!   helper_close(id)          ──► drop the stream ────────┤
//!                                                        ▼
//!                                   pump thread ──► Channel<HelperEvent>
//! ```
//!
//! # Request/reply matching
//!
//! Every call mints a request id from its session's counter, registers a
//! channel under that id, and *then* writes the frame — so a reply can never
//! arrive before there is somewhere to put it. The pump thread looks the id up
//! and hands the result to the single waiter, which is blocked on
//! [`HelperManager::call`]. An id nobody is waiting for (a reply that lost a
//! race with its own timeout, or the `null` id the remote uses for a frame it
//! could not attribute) is dropped: answering the wrong caller would be far
//! worse than forgetting one.
//!
//! A call that runs past [`CALL_TIMEOUT`] gives up, removes its registration
//! and reports [`HelperError::Timeout`]. The request is still outstanding on the
//! remote; its reply is simply dropped when it arrives. Nothing is leaked —
//! giving up on an answer must never leak a waiter.
//!
//! # Fallback
//!
//! [`faragent_service::helper`] decides whether the remote runs the native
//! binary or the bash script. Both speak the identical framed protocol over the
//! identical stdio channel, so the only difference here is the command line:
//! [`REMOTE_HELPER_PATH`] for the binary, the assembled script for the fallback.
//! Which one is in use travels back with the open reply ([`HelperModeDto`]) so
//! the UI can say so instead of degrading silently — the one outcome the
//! service module forbids.
//!
//! A Windows remote is refused outright: the framed channel is POSIX-only (a
//! `bash -lc` on the far side), and there is no second dialect of the *framed*
//! protocol to fall back to. The Windows dialect in `faragent_remote::win` is a
//! one-shot script channel, not this one.
//!
//! # Ownership
//!
//! A session is one [`CommandStream`], one pump thread, and one pending map.
//! Removing it from the map drops the stream, and [`CommandStream`]'s own `Drop`
//! kills the ssh child, reaps it and joins its stderr drain thread. The pump
//! thread does not need to be told to stop: killing the child closes the pipe
//! it is reading, so its next read returns EOF. Both halves therefore end
//! exactly once, whether the close came from the frontend
//! ([`HelperManager::close`]), from the remote hanging up, or from a second
//! `open` for the same host replacing the first.

use crate::dto::{shape_error, CommandError, Text};
use faragent_helper::proto::{self, ErrorBody, ErrorCode, Inbound, Line};
use faragent_remote::posix_fallback_script;
use faragent_service::helper::{self as service, FallbackReason, HelperMode, REMOTE_HELPER_PATH};
use faragent_transport::OpenSshTransport;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager;

/// How long one [`HelperManager::call`] waits for its reply.
///
/// Generous on purpose: the deadline exists so a dead remote surfaces as a
/// failed call instead of a spinner that never stops, not to bound a slow
/// `git diff`. Every op in the phase-1 set is a local read or a `git` run on
/// the remote.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// What the frontend sees
// ---------------------------------------------------------------------------

/// [`FallbackReason`] as JSON: the machine tag plus the same bilingual sentence
/// the TUI shows. The tag is what a UI switches on; the sentence is what it
/// displays.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackReasonDto {
    /// `unsupported_platform`, `no_local_artifact`, … — `FallbackReason::code`.
    pub code: String,
    pub message: Text,
}

impl From<&FallbackReason> for FallbackReasonDto {
    fn from(reason: &FallbackReason) -> Self {
        Self {
            code: reason.code().to_string(),
            message: reason.message().into(),
        }
    }
}

/// Which channel this session is on. The distinction is the reason the service
/// module exists, so it is the first thing the open reply carries.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelperModeDto {
    /// The verified native helper at `~/.faragent/bin/faragent-helper`.
    Native,
    /// The bash fallback, with the reason it was chosen.
    ScriptFallback { reason: FallbackReasonDto },
}

impl From<&HelperMode> for HelperModeDto {
    fn from(mode: &HelperMode) -> Self {
        match mode {
            HelperMode::Native => HelperModeDto::Native,
            HelperMode::ScriptFallback(reason) => HelperModeDto::ScriptFallback {
                reason: reason.into(),
            },
        }
    }
}

/// The reply to `helper_open`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperOpenDto {
    /// The handle `helper_call` / `helper_close` take.
    pub id: u64,
    pub mode: HelperModeDto,
    /// `mode` flattened, because that is what every caller actually branches on.
    pub native: bool,
}

/// A push (or the end of the channel) arriving on the caller's `Channel`.
///
/// Pushes are forwarded exactly as the wire delivered them — this layer does not
/// know what `fs.changed` or `git.changed` mean and must not pretend to. An
/// unknown event name is passed through, not dropped: a frontend that does not
/// recognise it can ignore it, but nothing else can decide that for it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelperEvent {
    /// One unsolicited frame from the remote (`event` + `data`, verbatim).
    Push { event: String, data: Value },
    /// The channel ended — the remote hung up, the connection broke, or the
    /// frontend stopped listening. Sent at most once per session.
    Closed { message: String },
}

/// Why a helper operation did not produce a value.
///
/// Serialized straight to the frontend as the rejection value, so the UI can
/// branch on `code` (the eight protocol codes) instead of parsing a sentence.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelperError {
    /// The remote answered `ok:false` — one of `proto::ErrorCode`'s eight, or
    /// `bad_request` for arguments this side refused to send at all.
    Remote { code: String, message: String },
    /// No reply within [`CALL_TIMEOUT`].
    Timeout { op: String, seconds: u64 },
    /// There is no connection to ask: never opened, already closed, or the
    /// stream died under the call.
    Disconnected { message: String },
}

impl HelperError {
    fn remote(code: ErrorCode, message: impl Into<String>) -> Self {
        HelperError::Remote {
            code: code.as_str().to_string(),
            message: message.into(),
        }
    }

    fn disconnected(message: impl Into<String>) -> Self {
        HelperError::Disconnected {
            message: message.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

/// Callers waiting for a reply, keyed by the request id they registered under.
type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, HelperError>>>>>;

/// A live helper connection.
///
/// The pieces are separate locks rather than one big mutex so that a write that
/// blocks on a wedged remote cannot hold the lock `close` needs — closing a
/// stuck connection is exactly when you need `close` to work.
struct Session {
    host: String,
    /// The far end's stdin. Moved out of the [`CommandStream`] so writing holds
    /// this lock and not the stream's.
    writer: Mutex<Box<dyn Write + Send>>,
    /// The child and its stderr tail, behind a lock only so the whole session is
    /// `Sync` (`tauri::State` demands it, and `Arc<Session>` demands `Sync` of
    /// its contents). Its reader lives in the pump thread and its writer is
    /// `writer` above; only the reap on close ever touches this.
    stream: Mutex<faragent_transport::CommandStream>,
    pending: Pending,
    /// Per-session request ids: monotonic, never reused within a session, and
    /// independent of the manager's session ids.
    next_request: AtomicU64,
}

struct Shared {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(0),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// The manager, registered once in `lib.rs` and cloned (it is an `Arc` inside)
/// into the blocking pool per command.
#[derive(Default)]
pub struct HelperManager {
    shared: Arc<Shared>,
}

impl Clone for HelperManager {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

/// Lock a mutex, ignoring poisoning: a panic in the pump thread must not turn
/// every later call into a panic of its own.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl HelperManager {
    /// Probe the remote, make sure the helper is usable, open the channel and
    /// start pumping. Returns the handle and which mode it landed in.
    pub fn open(
        &self,
        host: &str,
        resource_root: Option<&Path>,
        on_event: Channel<HelperEvent>,
    ) -> Result<HelperOpenDto, CommandError> {
        // Cached per host by `faragent_transport` (one `ssh` round trip the
        // first time, config afterwards), and the same call every other command
        // uses to learn a remote's OS.
        let os = faragent_transport::host_os(host).map_err(|e| shape_error(&e, host))?;
        let transport = OpenSshTransport::connect(host).map_err(|e| shape_error(&e, host))?;

        // The whole install decision. Never an error: every dead end is a
        // legitimate fallback carrying its reason.
        let mode = service::ensure_helper(&transport, os, resource_root);
        if let HelperMode::ScriptFallback(FallbackReason::WindowsRemote) = &mode {
            // No silent failure, and no pretending: `bash -lc` — the fallback's
            // own channel — does not exist on a Windows remote either.
            return Err(CommandError::Plain {
                message: FallbackReason::WindowsRemote.message().en,
            });
        }

        let mut stream = match &mode {
            HelperMode::Native => transport.spawn_login_stdio_stream(REMOTE_HELPER_PATH),
            // Identical wire format, identical channel; only the command line
            // differs. `bash -lc` for both, so the remote's login PATH is in
            // force either way.
            HelperMode::ScriptFallback(_) => {
                transport.spawn_login_stdio_stream(&posix_fallback_script())
            }
        }
        .map_err(|e| shape_error(&e, host))?;

        // The reader goes to the pump thread; the stream keeps the child.
        let reader = std::mem::replace(&mut stream.reader, Box::new(std::io::empty()));
        let writer = std::mem::replace(&mut stream.writer, Box::new(std::io::sink()));

        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let session = Arc::new(Session {
            host: host.to_string(),
            writer: Mutex::new(writer),
            stream: Mutex::new(stream),
            pending: Arc::clone(&pending),
            next_request: AtomicU64::new(0),
        });

        // One connection per host: a second open for the same host replaces the
        // first rather than stacking a second `ssh` beside it. The replaced
        // session is dropped *outside* the lock, so its kill+reap cannot stall
        // anyone else's `open`/`close`/`call`.
        let replaced: Vec<Arc<Session>> = {
            let mut sessions = lock(&self.shared.sessions);
            let stale: Vec<u64> = sessions
                .iter()
                .filter(|(_, s)| s.host == host)
                .map(|(key, _)| *key)
                .collect();
            let replaced = stale
                .into_iter()
                .filter_map(|key| sessions.remove(&key))
                .collect();
            sessions.insert(id, Arc::clone(&session));
            replaced
        };
        drop(replaced);

        let shared = Arc::clone(&self.shared);
        std::thread::spawn(move || pump(shared, id, reader, pending, session, on_event));

        Ok(HelperOpenDto {
            id,
            mode: (&mode).into(),
            native: mode.is_native(),
        })
    }

    /// Send one request and wait for its reply.
    pub fn call(&self, id: u64, op: &str, args: Value) -> Result<Value, HelperError> {
        let params = match args {
            Value::Null => Map::new(),
            Value::Object(params) => params,
            _ => {
                return Err(HelperError::remote(
                    ErrorCode::BadRequest,
                    "`args` must be a JSON object",
                ))
            }
        };

        let session = lock(&self.shared.sessions)
            .get(&id)
            .cloned()
            .ok_or_else(|| HelperError::disconnected(format!("no helper session {id} is open")))?;

        let request_id = session.next_request.fetch_add(1, Ordering::Relaxed) + 1;
        let line = encode_request(request_id, op, &params)?;

        // Registered before the frame is written: the pump thread can only
        // deliver a reply it has read, and it cannot read one that has not been
        // asked for yet.
        let (tx, rx) = mpsc::channel();
        lock(&session.pending).insert(request_id, tx);

        {
            let mut writer = lock(&session.writer);
            if let Err(error) = writer.write_all(&line).and_then(|()| writer.flush()) {
                lock(&session.pending).remove(&request_id);
                return Err(HelperError::disconnected(format!(
                    "writing to the helper channel failed: {error}"
                )));
            }
        }

        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                // Stop waiting, but do not stop the request: the remote's answer
                // is dropped if it ever arrives.
                lock(&session.pending).remove(&request_id);
                Err(HelperError::Timeout {
                    op: op.to_string(),
                    seconds: CALL_TIMEOUT.as_secs(),
                })
            }
            // The sender was dropped without a value: the session went away
            // while this call was in flight.
            Err(RecvTimeoutError::Disconnected) => {
                Err(HelperError::disconnected("the helper channel closed"))
            }
        }
    }

    /// Drop a session: kills the ssh child, reaps it, ends the pump thread.
    /// Idempotent — closing an id that is already gone is not an error.
    pub fn close(&self, id: u64) {
        // Dropped outside the lock: `CommandStream::drop` waits for the child.
        let removed = lock(&self.shared.sessions).remove(&id);
        drop(removed);
    }

    /// How many sessions are open. Tests only; the frontend has no business
    /// knowing, and a UI that showed it would be showing a leak detector.
    #[cfg(test)]
    fn open_sessions(&self) -> usize {
        lock(&self.shared.sessions).len()
    }
}

// ---------------------------------------------------------------------------
// The pump thread
// ---------------------------------------------------------------------------

/// Read frames until the stream ends, then answer every waiter.
///
/// `reader` is the far end's stdout; `on_event` returns `false` when the
/// frontend has stopped listening (a torn-down webview), which ends the loop
/// just as a hang-up would.
fn pump(
    shared: Arc<Shared>,
    id: u64,
    reader: Box<dyn Read + Send>,
    pending: Pending,
    session: Arc<Session>,
    on_event: Channel<HelperEvent>,
) {
    let mut reader = BufReader::new(reader);
    let mut reason = pump_frames(&mut reader, &pending, &|event| on_event.send(event).is_ok());

    // Reap: take the session out of the map, which drops the last `Arc` (this
    // thread's own, unless a call is mid-flight) and with it the child. The
    // stderr tail is the only evidence left when the remote dies without a
    // goodbye, so it rides along in the message.
    let removed = lock(&shared.sessions).remove(&id);
    let tail = lock(&session.stream).stderr_tail();
    if !tail.trim().is_empty() {
        reason = format!("{reason}: {}", tail.trim());
    }
    drop(removed);
    drop(session);

    let _ = on_event.send(HelperEvent::Closed { message: reason });
}

/// The frame loop, and the drain when it ends. Split from [`pump`] so it can be
/// driven by a `Cursor` in tests: everything here is protocol, nothing is a
/// process.
fn pump_frames<R: BufRead>(
    reader: &mut R,
    pending: &Pending,
    on_event: &dyn Fn(HelperEvent) -> bool,
) -> String {
    let reason = loop {
        match proto::read_line(reader) {
            Ok(Line::Frame(line)) => match proto::parse_line(&line) {
                Some(Inbound::Reply {
                    id,
                    ok,
                    data,
                    error,
                }) => {
                    // Only ids this side minted can have a waiter. `null` (the
                    // remote could not attribute the frame) and the odd stale
                    // reply fall through here.
                    if let Some(request_id) = pending_key(&id) {
                        if let Some(waiter) = lock(pending).remove(&request_id) {
                            // A send failure means the caller gave up on the
                            // timeout; the answer is simply dropped.
                            let _ = waiter.send(reply_result(ok, data, error));
                        }
                    }
                }
                // Pushes are the caller's business, verbatim.
                Some(Inbound::Event { event, data }) => {
                    if !on_event(HelperEvent::Push { event, data }) {
                        break "the frontend stopped listening to the helper channel".to_string();
                    }
                }
                // A banner, a log line, a fragment: not a frame.
                None => {}
            },
            // An oversized line is already consumed up to the next newline, so
            // the stream is back in sync. `proto` has nothing to say about it
            // because it is not a frame.
            Ok(Line::Oversized) => {}
            Ok(Line::Eof) => break "the remote closed the helper channel".to_string(),
            Err(error) => break format!("reading the helper channel failed: {error}"),
        }
    };

    // Every caller still waiting gets an answer rather than a hang. This is the
    // whole reason the pending map is shared with the pump thread.
    for (_, waiter) in std::mem::take(&mut *lock(pending)) {
        let _ = waiter.send(Err(HelperError::disconnected(reason.clone())));
    }
    reason
}

// ---------------------------------------------------------------------------
// Pure helpers (the tested part)
// ---------------------------------------------------------------------------

/// The request id a reply belongs to.
///
/// Only positive integers can match: request ids are minted from a counter
/// starting at 1, so `null`, a string, a float or 0 belong to nobody and must
/// not be routed to a waiter that happens to hold that key.
fn pending_key(id: &Value) -> Option<u64> {
    id.as_u64().filter(|request_id| *request_id > 0)
}

/// A reply frame as the waiting caller sees it.
///
/// An `ok:false` frame whose code is outside the protocol's closed set arrives
/// with no decoded error at all (`proto::parse_line` refuses the code), which is
/// a protocol violation rather than a caller error — reported as `internal`,
/// never as success.
fn reply_result(
    ok: bool,
    data: Option<Value>,
    error: Option<ErrorBody>,
) -> Result<Value, HelperError> {
    if ok {
        // A reply with no `data` is legal on the wire; `null` is what the
        // caller asked for.
        return Ok(data.unwrap_or(Value::Null));
    }
    match error {
        Some(body) => Err(HelperError::Remote {
            code: body.code.as_str().to_string(),
            message: body.message,
        }),
        None => Err(HelperError::remote(
            ErrorCode::Internal,
            "the remote sent an error code outside the protocol's set",
        )),
    }
}

/// One outbound request line.
///
/// `faragent_helper::proto` is the serving half, so it encodes replies and
/// pushes but has no request encoder; this builds the object its own
/// `Request::from_line` parses. The *framing* is still proto's: the JSON is one
/// line, and the cap is [`proto::MAX_FRAME_BYTES`], not a second constant.
///
/// `id` and `op` are the frame's identity: a caller's params cannot rewrite
/// them, or a call could answer under another call's id.
fn encode_request(id: u64, op: &str, params: &Map<String, Value>) -> Result<Vec<u8>, HelperError> {
    let mut frame = Map::with_capacity(params.len() + 2);
    frame.insert("id".to_string(), Value::from(id));
    frame.insert("op".to_string(), Value::from(op));
    for (key, value) in params {
        if key == "id" || key == "op" {
            continue;
        }
        frame.insert(key.clone(), value.clone());
    }
    let mut line = serde_json::to_vec(&Value::Object(frame)).map_err(|e| {
        HelperError::remote(
            ErrorCode::BadRequest,
            format!("the request could not be encoded: {e}"),
        )
    })?;
    if line.len() > proto::MAX_FRAME_BYTES {
        return Err(HelperError::remote(
            ErrorCode::TooLarge,
            format!(
                "the request needs {} bytes, more than the {}-byte frame cap",
                line.len(),
                proto::MAX_FRAME_BYTES
            ),
        ));
    }
    line.push(b'\n');
    Ok(line)
}

// ---------------------------------------------------------------------------
// The Tauri command surface
// ---------------------------------------------------------------------------

/// Run blocking work off the async runtime's worker threads. The twin of
/// `commands.rs`'s helper, duplicated rather than shared because that one is
/// typed to `CommandError` and this surface has its own error shape.
async fn blocking<T, F>(f: F) -> Result<T, HelperError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, HelperError> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(result) => result,
        Err(e) => Err(HelperError::disconnected(format!(
            "internal task failed: {e}"
        ))),
    }
}

#[tauri::command]
pub async fn helper_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, HelperManager>,
    host: String,
    on_event: Channel<HelperEvent>,
) -> Result<HelperOpenDto, CommandError> {
    // The bundled artifacts live at `<resource_dir>/helper/<platform>/…`, which
    // is exactly what `faragent_service::helper::load_local_artifact` walks.
    // `None` (no resource dir) is a legitimate fallback, not an error.
    let resource_root = app.path().resource_dir().ok();
    let manager = state.inner().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        manager.open(&host, resource_root.as_deref(), on_event)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(CommandError::Plain {
            message: format!("internal task failed: {e}"),
        }),
    }
}

#[tauri::command]
pub async fn helper_call(
    state: tauri::State<'_, HelperManager>,
    id: u64,
    op: String,
    args: Option<Value>,
) -> Result<Value, HelperError> {
    let manager = state.inner().clone();
    let args = args.unwrap_or(Value::Null);
    blocking(move || manager.call(id, &op, args)).await
}

#[tauri::command]
pub async fn helper_close(
    state: tauri::State<'_, HelperManager>,
    id: u64,
) -> Result<(), CommandError> {
    state.close(id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
//
// The pure half only: frame routing by id, the reply→result mapping, the
// request encoder, and the event/disconnect behaviour of the pump loop driven
// by a `Cursor` over canned bytes. What is *not* covered here needs a real ssh
// host: `open` (the service probe and the install decision), a real
// `CommandStream`, and the reap of the child process on close.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn line(value: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }

    // -- request encoding --------------------------------------------------

    #[test]
    fn a_request_is_one_line_carrying_id_op_and_params() {
        let params = Map::from_iter([
            ("path_b64".to_string(), json!("L3RtcA==")),
            ("limit".to_string(), json!(4096)),
        ]);
        let line = encode_request(7, "fs.read", &params).unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        assert_eq!(line.iter().filter(|b| **b == b'\n').count(), 1);
        // The exact frame is what the helper's own `Request::from_line` reads.
        let parsed = proto::Request::from_line(&line[..line.len() - 1]).unwrap();
        assert_eq!(parsed.id, json!(7));
        assert_eq!(parsed.op, "fs.read");
        assert_eq!(parsed.required_text("path_b64").unwrap(), "/tmp");
        assert_eq!(parsed.u64("limit").unwrap(), Some(4096));
    }

    #[test]
    fn a_request_cannot_have_its_identity_rewritten_by_params() {
        // A caller splatting an untrusted object into `args` must not be able to
        // answer under another call's id, or to smuggle a second op.
        let params = Map::from_iter([
            ("id".to_string(), json!(999)),
            ("op".to_string(), json!("shutdown")),
            ("recursive".to_string(), json!(true)),
        ]);
        let line = encode_request(1, "fs.list", &params).unwrap();
        let parsed = proto::Request::from_line(&line[..line.len() - 1]).unwrap();
        assert_eq!(parsed.id, json!(1), "the minted id wins");
        assert_eq!(parsed.op, "fs.list", "the requested op wins");
        assert_eq!(parsed.bool("recursive").unwrap(), Some(true));
    }

    #[test]
    fn an_oversized_request_is_refused_before_it_reaches_the_wire() {
        let params = Map::from_iter([(
            "path_b64".to_string(),
            json!("x".repeat(proto::MAX_FRAME_BYTES + 1)),
        )]);
        match encode_request(1, "fs.list", &params) {
            Err(HelperError::Remote { code, message }) => {
                assert_eq!(code, ErrorCode::TooLarge.as_str());
                assert!(message.contains("frame cap"), "{message}");
            }
            other => panic!("expected too_large, got {other:?}"),
        }
    }

    // -- reply routing -----------------------------------------------------

    #[test]
    fn only_a_minted_request_id_can_have_a_waiter() {
        assert_eq!(pending_key(&json!(1)), Some(1));
        assert_eq!(pending_key(&json!(9_000_000)), Some(9_000_000));
        // The remote's own id-less frame, and every other JSON shape, belong to
        // nobody: routing one of these would answer the wrong caller.
        assert_eq!(pending_key(&Value::Null), None);
        assert_eq!(pending_key(&json!(0)), None);
        assert_eq!(pending_key(&json!(-1)), None);
        assert_eq!(pending_key(&json!(1.5)), None);
        assert_eq!(pending_key(&json!("1")), None);
        assert_eq!(pending_key(&json!([1])), None);
    }

    #[test]
    fn a_reply_maps_onto_a_value_or_a_typed_error() {
        assert_eq!(
            reply_result(true, Some(json!({"pong": true})), None).unwrap(),
            json!({"pong": true})
        );
        // `data` is optional on the wire.
        assert_eq!(reply_result(true, None, None).unwrap(), Value::Null);
        // The error's code travels as a tag, not as prose.
        let error = reply_result(
            false,
            None,
            Some(ErrorBody {
                code: ErrorCode::Binary,
                message: "/tmp/blob is a binary file".into(),
            }),
        )
        .unwrap_err();
        assert_eq!(
            error,
            HelperError::Remote {
                code: "binary".into(),
                message: "/tmp/blob is a binary file".into(),
            }
        );
        // A code outside the closed set is a protocol violation, never a success
        // and never a silent drop.
        let outside = reply_result(false, Some(json!({})), None).unwrap_err();
        match outside {
            HelperError::Remote { code, .. } => assert_eq!(code, "internal"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_session_with_no_reply_answers_its_waiter_on_disconnect() {
        // The promise the whole design rests on: a stream that dies under a call
        // fails that call, it does not hang it.
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        lock(&pending).insert(1, tx);

        let mut reader = Cursor::new(Vec::new()); // immediate EOF
        let reason = pump_frames(&mut reader, &pending, &|_| true);

        assert!(reason.contains("closed"), "{reason}");
        match rx.try_recv() {
            Ok(Err(HelperError::Disconnected { message })) => assert_eq!(message, reason),
            other => panic!("expected a disconnect, got {other:?}"),
        }
        assert!(lock(&pending).is_empty(), "the waiter must not be leaked");
    }

    // -- the pump loop -----------------------------------------------------

    #[test]
    fn replies_go_to_their_own_caller_and_pushes_go_to_the_channel() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        lock(&pending).insert(1, tx1);
        lock(&pending).insert(2, tx2);

        let mut bytes = Vec::new();
        // A login banner is not a frame and is skipped.
        bytes.extend_from_slice(b"Welcome to Ubuntu 24.04!\n");
        // A push carries no id and is forwarded verbatim.
        bytes.extend(
            serde_json::to_vec(&json!({
                "event": "fs.changed",
                "data": { "subscription": 3, "path_b64": "L3RtcA==", "kind": "modify" }
            }))
            .unwrap(),
        );
        bytes.push(b'\n');
        // Replies arrive out of order and are still matched by id.
        bytes.extend(line(json!({"id": 2, "ok": true, "data": {"second": true}})));
        bytes.extend(line(
            json!({"id": 1, "ok": false, "error": {"code": "not_found", "message_b64": "L25vcGU="}}),
        ));
        // A reply nobody is waiting for is dropped, not misrouted.
        bytes.extend(line(json!({"id": 99, "ok": true, "data": {"stale": true}})));
        // The remote's un-attributable frame.
        bytes.extend(line(
            json!({"id": null, "ok": false, "error": {"code": "bad_request", "message_b64": ""}}),
        ));

        let events: Arc<Mutex<Vec<HelperEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let mut reader = Cursor::new(bytes);
        let reason = pump_frames(&mut reader, &pending, &move |event| {
            sink.lock().unwrap().push(event);
            true
        });
        assert_eq!(reason, "the remote closed the helper channel");

        // Each caller got its own answer, in the shape the protocol describes.
        assert_eq!(rx2.try_recv().unwrap().unwrap(), json!({"second": true}));
        match rx1.try_recv().unwrap() {
            Err(HelperError::Remote { code, message }) => {
                assert_eq!(code, "not_found");
                // `message_b64` decoded back to its sentence.
                assert_eq!(message, "/nope");
            }
            other => panic!("expected the remote error, got {other:?}"),
        }
        // The un-awaited reply and the `null`-id frame were dropped, not
        // delivered to whoever happened to be waiting.
        assert!(lock(&pending).is_empty(), "both waiters were consumed");

        let seen = events.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "one push, and no Closed before the drain");
        assert_eq!(
            seen[0],
            HelperEvent::Push {
                event: "fs.changed".into(),
                data: json!({"subscription": 3, "path_b64": "L3RtcA==", "kind": "modify"}),
            }
        );
    }

    #[test]
    fn an_oversized_line_does_not_desynchronise_the_stream() {
        // `proto::read_line` drains past the cap, so the next real frame still
        // arrives — the pump must keep reading rather than treat it as fatal.
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        lock(&pending).insert(1, tx);

        let mut bytes = vec![b'x'; proto::MAX_FRAME_BYTES + 8];
        bytes.push(b'\n');
        bytes.extend(line(json!({"id": 1, "ok": true, "data": {"pong": true}})));

        let mut reader = Cursor::new(bytes);
        let reason = pump_frames(&mut reader, &pending, &|_| true);
        assert_eq!(reason, "the remote closed the helper channel");
        assert_eq!(rx.try_recv().unwrap().unwrap(), json!({"pong": true}));
    }

    #[test]
    fn a_frontend_that_stops_listening_ends_the_loop_and_drains() {
        // The webview going away is a disconnect like any other: the pump must
        // stop (nobody can receive the pushes) and free every waiter.
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        lock(&pending).insert(1, tx);

        let mut bytes = Vec::new();
        bytes.extend(line(
            json!({"event": "git.changed", "data": {"subscription": 1}}),
        ));
        bytes.extend(line(json!({"id": 1, "ok": true, "data": {"pong": true}})));

        let mut reader = Cursor::new(bytes);
        let reason = pump_frames(&mut reader, &pending, &|_| false);
        assert!(
            reason.contains("stopped listening"),
            "the reason must name the real cause: {reason}"
        );
        // The reply behind the failed push was never read, so the waiter is
        // drained rather than left hanging.
        match rx.try_recv() {
            Ok(Err(HelperError::Disconnected { .. })) => {}
            other => panic!("expected a disconnect, got {other:?}"),
        }
        assert!(lock(&pending).is_empty());
    }

    // -- session bookkeeping -----------------------------------------------

    #[test]
    fn closing_an_unknown_session_is_not_an_error() {
        let manager = HelperManager::default();
        assert_eq!(manager.open_sessions(), 0);
        manager.close(42);
        assert_eq!(manager.open_sessions(), 0);
        // And a call against it is a clean disconnect, not a panic.
        match manager.call(42, "ping", Value::Null) {
            Err(HelperError::Disconnected { message }) => assert!(message.contains("42")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn call_refuses_arguments_that_are_not_an_object() {
        let manager = HelperManager::default();
        // The shape is checked before the session lookup, so this needs no
        // connection to hold.
        match manager.call(1, "ping", json!([1, 2])) {
            Err(HelperError::Disconnected { .. }) => {
                panic!("an array must be refused as `bad_request`, not as a disconnect")
            }
            Err(HelperError::Remote { code, .. }) => {
                assert_eq!(code, ErrorCode::BadRequest.as_str())
            }
            other => panic!("{other:?}"),
        }
    }

    // -- the mode surface --------------------------------------------------

    #[test]
    fn every_fallback_reason_reaches_the_frontend_with_a_tag_and_both_sentences() {
        let reasons = [
            FallbackReason::UnsupportedPlatform {
                os: "FreeBSD".into(),
                arch: "x86_64".into(),
            },
            FallbackReason::NoLocalArtifact {
                platform: "darwin-arm64".into(),
            },
            FallbackReason::NoChecksumTool { os: "Linux".into() },
            FallbackReason::ProbeFailed {
                detail: "ssh exited 255".into(),
            },
            FallbackReason::WindowsRemote,
            FallbackReason::UploadFailed {
                detail: "exit 3".into(),
            },
            FallbackReason::VerifyFailed {
                detail: "expected a, saw b".into(),
            },
            FallbackReason::NotExecutable { code: Some(126) },
        ];
        let mut codes = std::collections::HashSet::new();
        for reason in &reasons {
            let dto = FallbackReasonDto::from(reason);
            assert!(codes.insert(dto.code.clone()), "duplicate tag {dto:?}");
            assert_eq!(dto.code, reason.code());
            assert!(!dto.message.zh.trim().is_empty(), "{dto:?}");
            assert!(!dto.message.en.trim().is_empty(), "{dto:?}");
        }
        assert_eq!(codes.len(), reasons.len());

        // Native carries no reason at all — the UI must not be able to read a
        // downgrade out of a healthy connection.
        assert!(matches!(
            HelperModeDto::from(&HelperMode::Native),
            HelperModeDto::Native
        ));
        let fallback = HelperModeDto::from(&HelperMode::ScriptFallback(
            FallbackReason::NoChecksumTool { os: "Linux".into() },
        ));
        match fallback {
            HelperModeDto::ScriptFallback { reason } => {
                assert_eq!(reason.code, "no_checksum_tool");
            }
            HelperModeDto::Native => panic!("a fallback must not serialize as native"),
        }
    }

    #[test]
    fn the_mode_tags_are_snake_case_on_the_wire() {
        // The frontend switches on these exact strings.
        let native = serde_json::to_value(HelperModeDto::Native).unwrap();
        assert_eq!(native, json!({"kind": "native"}));
        let fallback = serde_json::to_value(HelperModeDto::from(&HelperMode::ScriptFallback(
            FallbackReason::WindowsRemote,
        )))
        .unwrap();
        assert_eq!(fallback["kind"], json!("script_fallback"));
        assert_eq!(fallback["reason"]["code"], json!("windows_remote"));
        assert!(fallback["reason"]["message"]["zh"].is_string());

        assert_eq!(
            serde_json::to_value(HelperEvent::Push {
                event: "fs.changed".into(),
                data: json!({"a": 1}),
            })
            .unwrap(),
            json!({"kind": "push", "event": "fs.changed", "data": {"a": 1}})
        );
        assert_eq!(
            serde_json::to_value(HelperEvent::Closed {
                message: "bye".into()
            })
            .unwrap(),
            json!({"kind": "closed", "message": "bye"})
        );
        assert_eq!(
            serde_json::to_value(HelperError::Timeout {
                op: "fs.read".into(),
                seconds: 60,
            })
            .unwrap(),
            json!({"kind": "timeout", "op": "fs.read", "seconds": 60})
        );
        assert_eq!(
            serde_json::to_value(HelperError::Remote {
                code: "binary".into(),
                message: "nope".into(),
            })
            .unwrap(),
            json!({"kind": "remote", "code": "binary", "message": "nope"})
        );
    }
}

//! The FarAgent remote-channel wire protocol: NDJSON frames on stdio.
//!
//! **This module is the only place the protocol is defined.** The helper
//! binary, its tests and any other peer (the desktop app's `HelperManager`)
//! build and read frames through these types; a second framing implementation
//! anywhere is a bug.
//!
//! # Frames
//!
//! One JSON object per line, `\n`-terminated. Requests, replies and pushes
//! share one namespace and are told apart by the presence of `id`:
//!
//! ```text
//! request  {"id":1,"op":"fs.list","path_b64":"L2hvbWUvbWUvYXBw"}
//! reply    {"id":1,"ok":true,"data":{...}}
//! error    {"id":1,"ok":false,"error":{"code":"not_found","message_b64":"..."}}
//! push     {"event":"fs.changed","data":{"root_b64":"..."}}       (no id)
//! ```
//!
//! There is deliberately **no magic marker line**. A peer reads line by line
//! and skips whatever does not parse as a frame, which is what tolerates a
//! login shell's banner. (The one-shot `FARAGENT_*_V1` marker scripts need a
//! marker because a script's stdout cannot otherwise be told from the banner;
//! a framed connection has a better way.)
//!
//! # Byte strings are base64
//!
//! Every value that can hold arbitrary bytes travels base64-encoded in a field
//! whose name ends in `_b64` — `path_b64`, `name_b64`, `data_b64`,
//! `branch_b64`, `message_b64`, `subject_b64`, … Base64 has no quoting rules,
//! so neither side escapes anything. That matters most for the bash fallback,
//! where escaping quotes, backslashes and control characters in paths is
//! exactly where such scripts go wrong.
//!
//! Pure scalars stay plain JSON: booleans, counts, byte sizes, enums
//! (`kind`, `status`, `code`) and git's hex object ids.
//!
//! # Frame cap
//!
//! One frame — the JSON line **without** its terminating newline — may not
//! exceed [`MAX_FRAME_BYTES`]. The cap is enforced in both directions: an
//! oversized inbound line is answered with `bad_request` and dropped up to the
//! next newline ([`read_line`]), and an oversized outbound frame is replaced
//! by a `too_large` error frame ([`Frame::encode`]).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::io::{BufRead, ErrorKind};

/// Largest single frame, in bytes, excluding the terminating newline.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Bytes `fs.read` returns when the request does not ask for a size.
pub const DEFAULT_READ_LIMIT: u64 = 256 * 1024;

/// Largest chunk one `fs.read` may return, whatever the request asks for.
pub const MAX_READ_CHUNK: u64 = 4 * 1024 * 1024;

/// Largest file `fs.read` will open at all. Beyond this the reader answers
/// `too_large` so a placeholder can be shown instead of streaming gigabytes.
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Cap on entries in one list-shaped response (`fs.list`, `git.diff`,
/// `git.branches`, `git.log`).
pub const MAX_LIST_ENTRIES: usize = 500;

/// The closed set of error codes. Nothing else may ever be sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Malformed frame, missing/unknown field, unknown op.
    BadRequest,
    /// Path (or ref) does not exist.
    NotFound,
    /// `fs.list` on something that is not a directory.
    NotADir,
    /// Exists but cannot be read (permissions, I/O, not a regular file).
    Unreadable,
    /// Too large to deliver in one frame (file, or the encoded reply itself).
    TooLarge,
    /// Text was requested but the content is not text.
    Binary,
    /// No `.git` found walking up from the given path.
    NotARepo,
    /// A `git` subprocess exited non-zero.
    GitFailed,
    /// Anything else — a bug on this side, never the caller's fault.
    Internal,
}

impl ErrorCode {
    /// The wire spelling. This is the closed list.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::NotFound => "not_found",
            ErrorCode::NotADir => "not_a_dir",
            ErrorCode::Unreadable => "unreadable",
            ErrorCode::TooLarge => "too_large",
            ErrorCode::Binary => "binary",
            ErrorCode::NotARepo => "not_a_repo",
            ErrorCode::GitFailed => "git_failed",
            ErrorCode::Internal => "internal",
        }
    }

    /// Parse a wire spelling. `None` for anything outside the closed set.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "bad_request" => ErrorCode::BadRequest,
            "not_found" => ErrorCode::NotFound,
            "not_a_dir" => ErrorCode::NotADir,
            "unreadable" => ErrorCode::Unreadable,
            "too_large" => ErrorCode::TooLarge,
            "binary" => ErrorCode::Binary,
            "not_a_repo" => ErrorCode::NotARepo,
            "git_failed" => ErrorCode::GitFailed,
            "internal" => ErrorCode::Internal,
            _ => return None,
        })
    }

    /// Every code, so a caller (or a test) can assert the set is closed.
    pub const ALL: [ErrorCode; 9] = [
        ErrorCode::BadRequest,
        ErrorCode::NotFound,
        ErrorCode::NotADir,
        ErrorCode::Unreadable,
        ErrorCode::TooLarge,
        ErrorCode::Binary,
        ErrorCode::NotARepo,
        ErrorCode::GitFailed,
        ErrorCode::Internal,
    ];
}

/// An op failure: the code the caller sees plus human detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtoError {
    pub code: ErrorCode,
    pub message: String,
}

impl ProtoError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn unreadable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unreadable, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl std::fmt::Display for ProtoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ProtoError {}

/// Base64 of arbitrary bytes — the only encoding the protocol allows for a
/// value that is not a pure scalar.
pub fn b64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Decode a `_b64` field. A bad payload is a `bad_request`, never a panic.
pub fn b64_decode(text: &str) -> Result<Vec<u8>, ProtoError> {
    STANDARD
        .decode(text.as_bytes())
        .map_err(|e| ProtoError::bad_request(format!("field is not valid base64: {e}")))
}

// ---------------------------------------------------------------------------
// Inbound: requests
// ---------------------------------------------------------------------------

/// One decoded request.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    /// Echoed back verbatim on the reply. `Value::Null` when the frame had no
    /// `id` (or parsing failed before reaching it).
    pub id: Value,
    pub op: String,
    params: Map<String, Value>,
}

impl Request {
    /// Parse one line. Anything that is not a JSON object carrying a string
    /// `op` is a `bad_request`.
    pub fn from_line(line: &[u8]) -> Result<Self, ProtoError> {
        let value: Value = serde_json::from_slice(line)
            .map_err(|e| ProtoError::bad_request(format!("line is not JSON: {e}")))?;
        let Value::Object(params) = value else {
            return Err(ProtoError::bad_request("frame is not a JSON object"));
        };
        let op = match params.get("op") {
            Some(Value::String(op)) => op.clone(),
            Some(_) => return Err(ProtoError::bad_request("`op` must be a string")),
            None => return Err(ProtoError::bad_request("frame has no `op`")),
        };
        let id = params.get("id").cloned().unwrap_or(Value::Null);
        Ok(Self { id, op, params })
    }

    /// A raw parameter, for the few ops that need to look before decoding.
    pub fn raw(&self, key: &str) -> Option<&Value> {
        self.params.get(key)
    }

    /// A parameter that must be a non-empty UTF-8 string (ops names, events,
    /// enum-valued flags).
    pub fn string(&self, key: &str) -> Result<Option<String>, ProtoError> {
        match self.params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(ProtoError::bad_request(format!("`{key}` must be a string"))),
        }
    }

    /// A required `*_b64` parameter, decoded to bytes. Paths are bytes here,
    /// not `String`: on a POSIX remote a filename need not be UTF-8.
    pub fn required_bytes(&self, key: &str) -> Result<Vec<u8>, ProtoError> {
        match self.bytes(key)? {
            Some(b) if !b.is_empty() => Ok(b),
            _ => Err(ProtoError::bad_request(format!("`{key}` is required"))),
        }
    }

    /// An optional `*_b64` parameter.
    pub fn bytes(&self, key: &str) -> Result<Option<Vec<u8>>, ProtoError> {
        match self.params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(b64_decode(s)?)),
            Some(_) => Err(ProtoError::bad_request(format!("`{key}` must be a base64 string"))),
        }
    }

    /// An optional unsigned integer parameter.
    pub fn u64(&self, key: &str) -> Result<Option<u64>, ProtoError> {
        match self.params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(n)) => n
                .as_u64()
                .map(Some)
                .ok_or_else(|| ProtoError::bad_request(format!("`{key}` must be a non-negative integer"))),
            Some(_) => Err(ProtoError::bad_request(format!("`{key}` must be an integer"))),
        }
    }

    /// An optional boolean parameter.
    pub fn bool(&self, key: &str) -> Result<Option<bool>, ProtoError> {
        match self.params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(ProtoError::bad_request(format!("`{key}` must be a boolean"))),
        }
    }

    /// A required non-empty UTF-8 string decoded from a `*_b64` field.
    pub fn required_text(&self, key: &str) -> Result<String, ProtoError> {
        let bytes = self.required_bytes(key)?;
        String::from_utf8(bytes)
            .map_err(|_| ProtoError::bad_request(format!("`{key}` is not valid UTF-8")))
    }
}

// ---------------------------------------------------------------------------
// Outbound: frames
// ---------------------------------------------------------------------------

/// One outbound frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// `{"id":…,"ok":true,"data":…}`
    Reply { id: Value, data: Value },
    /// `{"id":…,"ok":false,"error":{"code":…,"message_b64":…}}`
    Error {
        id: Value,
        code: ErrorCode,
        message: String,
    },
    /// `{"event":…,"data":…}` — a push; carries no `id`.
    Event { event: String, data: Value },
}

impl Frame {
    pub fn reply(id: Value, data: Value) -> Self {
        Frame::Reply { id, data }
    }

    pub fn error(id: Value, error: ProtoError) -> Self {
        Frame::Error {
            id,
            code: error.code,
            message: error.message,
        }
    }

    pub fn event(event: impl Into<String>, data: Value) -> Self {
        Frame::Event {
            event: event.into(),
            data,
        }
    }

    /// The JSON body, without the newline.
    pub fn to_value(&self) -> Value {
        match self {
            Frame::Reply { id, data } => json!({ "id": id, "ok": true, "data": data }),
            Frame::Error { id, code, message } => json!({
                "id": id,
                "ok": false,
                "error": {
                    "code": code.as_str(),
                    "message_b64": b64_encode(message.as_bytes()),
                },
            }),
            Frame::Event { event, data } => json!({ "event": event, "data": data }),
        }
    }

    /// Serialize to one NDJSON line, **cap-enforced**: a frame that would
    /// exceed [`MAX_FRAME_BYTES`] is replaced by a small `too_large` error
    /// frame, so a caller can never blow up a connection by answering a big
    /// request honestly.
    ///
    /// A push has no `id` to answer against, so the negligible case of an
    /// oversized one is reported as an id-less (`null`) error frame — a client
    /// keyed on the ids it sent ignores it, and the stream stays framed.
    /// Events are built from a subscription id and base64 paths, so nothing in
    /// phase 1 can reach the cap this way; it is a guard, not a path.
    pub fn encode(self) -> Vec<u8> {
        let line = self.to_line();
        if line.len().saturating_sub(1) <= MAX_FRAME_BYTES {
            return line;
        }
        let (id, message) = match self {
            Frame::Reply { id, .. } => (
                id,
                format!(
                    "the reply needs {} bytes, more than the {MAX_FRAME_BYTES} byte frame cap; \
                     ask for less (chunked `fs.read`, or a `files_only` `git.diff`)",
                    line.len()
                ),
            ),
            Frame::Error { id, .. } => (
                id,
                format!("the frame exceeds the {MAX_FRAME_BYTES} byte frame cap"),
            ),
            Frame::Event { .. } => (
                Value::Null,
                format!("the push exceeds the {MAX_FRAME_BYTES} byte frame cap"),
            ),
        };
        Frame::Error {
            id,
            code: ErrorCode::TooLarge,
            message,
        }
        .to_line()
    }

    fn to_line(&self) -> Vec<u8> {
        let mut line = serde_json::to_vec(&self.to_value())
            .unwrap_or_else(|_| b"{\"id\":null,\"ok\":false".to_vec());
        line.push(b'\n');
        line
    }
}

// ---------------------------------------------------------------------------
// Inbound: replies and pushes (the client half)
// ---------------------------------------------------------------------------

/// A decoded reply error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
}

/// What a client sees on the wire.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    /// A reply to one of our requests (`ok` true or false).
    Reply {
        id: Value,
        ok: bool,
        data: Option<Value>,
        error: Option<ErrorBody>,
    },
    /// An unsolicited push.
    Event { event: String, data: Value },
}

/// Parse one line, or `None` when it is not a frame — a banner, a log line, a
/// truncated fragment. A client loop skips `None` until the first real frame.
pub fn parse_line(line: &[u8]) -> Option<Inbound> {
    let value: Value = serde_json::from_slice(line).ok()?;
    let Value::Object(mut obj) = value else {
        return None;
    };
    if let Some(event) = obj.remove("event") {
        let event = event.as_str()?.to_string();
        return Some(Inbound::Event {
            event,
            data: obj.remove("data").unwrap_or(Value::Null),
        });
    }
    let id = obj.remove("id")?;
    let ok = obj.remove("ok")?.as_bool()?;
    let data = obj.remove("data");
    let error = obj.remove("error").and_then(|e| {
        let e = e.as_object()?;
        let code = ErrorCode::parse(e.get("code")?.as_str()?)?;
        let message = e
            .get("message_b64")
            .and_then(Value::as_str)
            .and_then(|s| b64_decode(s).ok())
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        Some(ErrorBody { code, message })
    });
    Some(Inbound::Reply { id, ok, data, error })
}

/// What [`read_line`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// One frame (no trailing newline, may be empty).
    Frame(Vec<u8>),
    /// A line longer than [`MAX_FRAME_BYTES`]; it has been discarded up to the
    /// next newline so the stream stays in sync.
    Oversized,
    /// The peer closed its end.
    Eof,
}

/// Read one `\n`-terminated line without ever buffering more than
/// [`MAX_FRAME_BYTES`]. On overflow the rest of the line is drained (not kept)
/// and [`Line::Oversized`] is returned, so a caller can answer `bad_request`
/// instead of letting a hostile or broken peer exhaust memory.
pub fn read_line<R: BufRead>(reader: &mut R) -> std::io::Result<Line> {
    let mut buf: Vec<u8> = Vec::new();
    let mut oversized = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            return Ok(if oversized {
                Line::Oversized
            } else if buf.is_empty() {
                Line::Eof
            } else {
                // A final line with no newline is still a line.
                Line::Frame(buf)
            });
        }
        match available.iter().position(|b| *b == b'\n') {
            Some(at) => {
                if !oversized {
                    if buf.len() + at > MAX_FRAME_BYTES {
                        oversized = true;
                        buf = Vec::new();
                    } else {
                        buf.extend_from_slice(&available[..at]);
                    }
                }
                reader.consume(at + 1);
                return Ok(if oversized { Line::Oversized } else { Line::Frame(buf) });
            }
            None => {
                let n = available.len();
                if !oversized {
                    if buf.len() + n > MAX_FRAME_BYTES {
                        oversized = true;
                        buf = Vec::new();
                    } else {
                        buf.extend_from_slice(available);
                    }
                }
                reader.consume(n);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn error_codes_are_the_closed_set() {
        // Exactly these nine, spelled exactly this way.
        let expected = [
            "bad_request",
            "not_found",
            "not_a_dir",
            "unreadable",
            "too_large",
            "binary",
            "not_a_repo",
            "git_failed",
            "internal",
        ];
        assert_eq!(ErrorCode::ALL.len(), expected.len());
        for (code, text) in ErrorCode::ALL.iter().zip(expected) {
            assert_eq!(code.as_str(), text);
            assert_eq!(ErrorCode::parse(text), Some(*code));
        }
        assert_eq!(ErrorCode::parse("no_such_code"), None);
        assert_eq!(ErrorCode::parse("Not_Found"), None);
    }

    #[test]
    fn error_code_serde_matches_as_str() {
        for code in ErrorCode::ALL {
            let json = serde_json::to_string(&code).unwrap();
            assert_eq!(json, format!("\"{}\"", code.as_str()));
            let back: ErrorCode = serde_json::from_str(&json).unwrap();
            assert_eq!(back, code);
        }
        // Outside the closed set cannot even be deserialized.
        assert!(serde_json::from_str::<ErrorCode>("\"nope\"").is_err());
    }

    #[test]
    fn request_parses_id_op_and_params() {
        let req = Request::from_line(br#"{"id":7,"op":"fs.list","path_b64":"L3RtcA=="}"#).unwrap();
        assert_eq!(req.id, json!(7));
        assert_eq!(req.op, "fs.list");
        assert_eq!(req.required_text("path_b64").unwrap(), "/tmp");
        // String ids round-trip too — the caller's id is echoed verbatim.
        let req = Request::from_line(br#"{"id":"abc","op":"ping"}"#).unwrap();
        assert_eq!(req.id, json!("abc"));
        // No id at all is legal to parse; the reply carries null.
        let req = Request::from_line(br#"{"op":"ping"}"#).unwrap();
        assert_eq!(req.id, Value::Null);
    }

    #[test]
    fn request_rejects_malformed_input_without_panicking() {
        // Only what `from_line` itself refuses: a frame that is not a JSON
        // object, or has no string `op`. Parameter *types* are checked when the
        // op reads them (see `typed_accessors_reject_wrong_types`).
        let cases: &[&[u8]] = &[
            b"",
            b"not json",
            b"[1,2,3]",
            b"\"a string\"",
            b"42",
            br#"{"id":1}"#,
            br#"{"id":1,"op":42}"#,
        ];
        for case in cases {
            match Request::from_line(case) {
                Err(err) => assert_eq!(
                    err.code,
                    ErrorCode::BadRequest,
                    "input {:?} gave {err:?}",
                    String::from_utf8_lossy(case)
                ),
                Ok(req) => panic!("should have failed: {req:?}"),
            }
        }
    }

    #[test]
    fn typed_accessors_reject_wrong_types() {
        // A frame can parse and still be wrong; the op's own accessor is what
        // answers `bad_request`, never a panic.
        let bad_b64 = Request::from_line(br#"{"id":1,"op":"fs.list","path_b64":"??"}"#)
            .expect("parses; the base64 is only checked on read");
        assert_eq!(
            bad_b64.required_bytes("path_b64").unwrap_err().code,
            ErrorCode::BadRequest
        );

        let wrong_types =
            Request::from_line(br#"{"id":1,"op":"ping","limit":-1,"recursive":"yes","p":7}"#)
                .unwrap();
        assert_eq!(wrong_types.u64("limit").unwrap_err().code, ErrorCode::BadRequest);
        assert_eq!(wrong_types.bool("recursive").unwrap_err().code, ErrorCode::BadRequest);
        assert_eq!(wrong_types.bytes("p").unwrap_err().code, ErrorCode::BadRequest);
        assert_eq!(wrong_types.string("p").unwrap_err().code, ErrorCode::BadRequest);

        // Missing is not the same as wrong: an absent key is `None`.
        assert_eq!(wrong_types.u64("offset").unwrap(), None);
        assert_eq!(wrong_types.bool("staged").unwrap(), None);
        assert_eq!(wrong_types.bytes("path_b64").unwrap(), None);
        // A required key that is absent is a `bad_request`.
        assert_eq!(
            wrong_types.required_bytes("path_b64").unwrap_err().code,
            ErrorCode::BadRequest
        );
        // Ids of every JSON type survive verbatim.
        for id in [json!(1), json!("a"), json!(null), json!({"k": [1]})] {
            let line = serde_json::to_vec(&json!({"id": id, "op": "ping"})).unwrap();
            assert_eq!(Request::from_line(&line).unwrap().id, id);
        }
    }

    #[test]
    fn reply_and_error_and_event_lines() {
        let line = Frame::reply(json!(1), json!({"pong": true})).encode();
        let text = String::from_utf8(line).unwrap();
        // One frame is one line, newline-terminated and never containing one.
        assert!(text.ends_with('\n'));
        assert_eq!(text.matches('\n').count(), 1, "{text:?}");
        // Object key order is not part of the protocol — the shape is.
        assert_eq!(
            serde_json::from_str::<Value>(text.trim_end()).unwrap(),
            json!({"id": 1, "ok": true, "data": {"pong": true}})
        );

        let line = Frame::error(json!(2), ProtoError::not_found("/nope")).encode();
        let text = String::from_utf8(line).unwrap();
        assert!(text.ends_with('\n'));
        let parsed = parse_line(text.trim_end().as_bytes()).unwrap();
        match parsed {
            Inbound::Reply { id, ok, error, .. } => {
                assert_eq!(id, json!(2));
                assert!(!ok);
                let error = error.unwrap();
                assert_eq!(error.code, ErrorCode::NotFound);
                assert_eq!(error.message, "/nope");
            }
            other => panic!("{other:?}"),
        }

        let line = Frame::event("fs.changed", json!({"path_b64": "L3RtcA=="})).encode();
        let text = String::from_utf8(line).unwrap();
        // No `id` on a push — that is how the two are told apart.
        assert!(!text.contains("\"id\""));
        match parse_line(text.trim_end().as_bytes()).unwrap() {
            Inbound::Event { event, data } => {
                assert_eq!(event, "fs.changed");
                assert_eq!(data["path_b64"], "L3RtcA==");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parse_line_skips_non_frames() {
        // A login banner, a blank line, a log line: all skipped silently.
        assert!(parse_line(b"").is_none());
        assert!(parse_line(b"Welcome to Ubuntu 24.04!").is_none());
        assert!(parse_line(b"[1,2]").is_none());
        assert!(parse_line(b"{\"id\":1}").is_none(), "no `ok`");
        assert!(parse_line(b"{\"op\":\"ping\"}").is_none(), "a request, not a reply");
        assert!(parse_line(b"{\"event\":42}").is_none(), "event must be a string");
        // `id` + `ok` is a reply; `data` is optional.
        assert!(parse_line(b"{\"id\":1,\"ok\":true}").is_some());
        assert!(parse_line(b"{\"id\":1,\"ok\":true,\"data\":null}").is_some());
        // An error code outside the closed set makes the reply unusable, but
        // the frame itself is still a frame — the reply arrives with no error
        // detail rather than blowing up the reader.
        assert!(parse_line(
            b"{\"id\":1,\"ok\":false,\"error\":{\"code\":\"made_up\",\"message_b64\":\"\"}}"
        )
        .is_some());
        match parse_line(
            b"{\"id\":1,\"ok\":false,\"error\":{\"code\":\"made_up\",\"message_b64\":\"\"}}",
        )
        .unwrap()
        {
            Inbound::Reply { error, .. } => assert!(error.is_none()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn encode_replaces_an_oversized_reply_with_too_large() {
        let big = "x".repeat(MAX_FRAME_BYTES + 1);
        let line = Frame::reply(json!(3), json!({ "data_b64": big })).encode();
        assert!(
            line.len() < 4096,
            "the replacement frame must itself be small: {}",
            line.len()
        );
        match parse_line(&line[..line.len() - 1]).unwrap() {
            Inbound::Reply { id, ok, error, .. } => {
                assert_eq!(id, json!(3), "the id must survive the substitution");
                assert!(!ok);
                let error = error.unwrap();
                assert_eq!(error.code, ErrorCode::TooLarge);
                assert!(error.message.contains("frame cap"), "{error:?}");
            }
            other => panic!("{other:?}"),
        }
        // A reply that exactly fills the cap is kept.
        let fits = "x".repeat(MAX_FRAME_BYTES - 64);
        let line = Frame::reply(json!(4), json!({ "data_b64": fits })).encode();
        assert!(matches!(
            parse_line(&line[..line.len() - 1]),
            Some(Inbound::Reply { ok: true, .. })
        ));
    }

    #[test]
    fn read_line_frames_and_oversize() {
        let mut r = Cursor::new(b"one\ntwo\nthree".to_vec());
        assert_eq!(read_line(&mut r).unwrap(), Line::Frame(b"one".to_vec()));
        assert_eq!(read_line(&mut r).unwrap(), Line::Frame(b"two".to_vec()));
        assert_eq!(read_line(&mut r).unwrap(), Line::Frame(b"three".to_vec()));
        assert_eq!(read_line(&mut r).unwrap(), Line::Eof);

        // A line past the cap is reported, then the stream resynchronises on
        // the next newline so following frames still work.
        let mut payload = vec![b'x'; MAX_FRAME_BYTES + 10];
        payload.push(b'\n');
        payload.extend_from_slice(b"{\"id\":1}\n");
        let mut r = Cursor::new(payload);
        assert_eq!(read_line(&mut r).unwrap(), Line::Oversized);
        assert_eq!(
            read_line(&mut r).unwrap(),
            Line::Frame(b"{\"id\":1}".to_vec())
        );
        assert_eq!(read_line(&mut r).unwrap(), Line::Eof);

        // An oversized final line with no newline is still reported.
        let mut r = Cursor::new(vec![b'x'; MAX_FRAME_BYTES + 1]);
        assert_eq!(read_line(&mut r).unwrap(), Line::Oversized);
        assert_eq!(read_line(&mut r).unwrap(), Line::Eof);
    }

    #[test]
    fn base64_roundtrip_including_non_utf8() {
        let raw: Vec<u8> = vec![0xff, 0x00, b'a', b'\n', 0x80];
        assert_eq!(b64_decode(&b64_encode(&raw)).unwrap(), raw);
        assert_eq!(b64_decode("!!!!").unwrap_err().code, ErrorCode::BadRequest);
        // Known vector, matching faragent-remote's win::b64.
        assert_eq!(b64_encode(b"abc"), "YWJj");
    }
}

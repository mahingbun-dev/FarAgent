#![cfg(unix)]
//! End-to-end tests for `faragent-helper`.
//!
//! The compiled binary is spawned as an ordinary **local subprocess** and
//! driven over real stdin/stdout — never through ssh, never with a mocked
//! filesystem. The filesystem and git fixtures are real temp directories with
//! a real `git init`, for the same reason `faragent-remote`'s `dirs` tests do
//! it that way: the things most likely to be wrong here are byte-level
//! (encodings, separators, quoting), and a mock would agree with whatever the
//! implementation happened to do.
//!
//! The client half is written exactly as the app's `HelperManager` should be:
//! read a line, hand it to [`proto::parse_line`], and skip whatever does not
//! come back as a frame. That is what makes the "no magic marker line" rule
//! real — one test runs the helper behind a login shell that prints a banner
//! first.
//!
//! `#[cfg(unix)]` because the fixtures use `/bin/bash`, `chmod` and unix
//! filenames; the crate itself builds and unit-tests on all three CI
//! platforms.

use faragent_helper::proto::{self, ErrorBody, ErrorCode, Inbound, MAX_FRAME_BYTES};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// Generous enough for a 2 s git poll plus a cold `git` on a loaded CI box.
const TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// The client half
// ---------------------------------------------------------------------------

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Vec<u8>>,
    /// Frames read but not yet matched by whoever asked.
    pending: VecDeque<Inbound>,
    /// Lines that were not frames at all: a banner, a blank line, a fragment.
    skipped: Vec<Vec<u8>>,
    next_id: u64,
}

impl Helper {
    fn start() -> Self {
        Self::from_command(binary())
    }

    /// The helper behind a login shell that prints a banner before exec'ing it
    /// — what a real `ssh -T host 'bash -lc …'` session looks like.
    fn start_behind_a_login_banner(banner: &str) -> Self {
        let mut cmd = Command::new("/bin/bash");
        cmd.arg("-lc").arg(format!(
            "printf '%s\\n' '{banner}'; exec '{}'",
            env!("CARGO_BIN_EXE_faragent-helper")
        ));
        Self::from_command(cmd)
    }

    fn start_with_env(envs: &[(&str, &str)]) -> Self {
        let mut cmd = binary();
        for (key, value) in envs {
            cmd.env(key, value);
        }
        Self::from_command(cmd)
    }

    fn from_command(mut cmd: Command) -> Self {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn faragent-helper");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        // A reader thread, so every wait can have a deadline: a blocking
        // `read_line` on a helper that hung would hang the suite instead of
        // failing it.
        let (tx, lines) = channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if line.last() == Some(&b'\n') {
                            line.pop();
                        }
                        if tx.send(line.clone()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines,
            pending: VecDeque::new(),
            skipped: Vec::new(),
            next_id: 1,
        }
    }

    fn write_raw(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        stdin.write_all(bytes).expect("write to the helper");
        stdin.flush().expect("flush to the helper");
    }

    fn send(&mut self, op: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let mut request = json!({ "id": id, "op": op });
        if let Value::Object(map) = params {
            for (key, value) in map {
                request[key] = value;
            }
        }
        self.send_value(&request);
        id
    }

    fn send_value(&mut self, value: &Value) {
        let mut line = serde_json::to_vec(value).expect("serialize a request");
        line.push(b'\n');
        self.write_raw(&line);
    }

    /// The next frame, from the queue or the wire, skipping non-frames.
    fn next_frame(&mut self, what: &str) -> Inbound {
        if let Some(frame) = self.pending.pop_front() {
            return frame;
        }
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "timed out waiting for {what}");
            match self.lines.recv_timeout(left) {
                Ok(line) => match proto::parse_line(&line) {
                    Some(frame) => return frame,
                    // A banner or a fragment: exactly what a client skips.
                    None => self.skipped.push(line),
                },
                Err(error) => panic!(
                    "waiting for {what}: {error} (skipped so far: {:?})",
                    self.skipped
                ),
            }
        }
    }

    /// The next frame matching `wanted`; anything else is kept for later.
    fn next_matching(&mut self, what: &str, wanted: impl Fn(&Inbound) -> bool) -> Inbound {
        let mut held = Vec::new();
        loop {
            let frame = self.next_frame(what);
            if wanted(&frame) {
                self.pending.extend(held);
                return frame;
            }
            held.push(frame);
        }
    }

    fn call_raw(&mut self, op: &str, params: Value) -> Inbound {
        let id = self.send(op, params);
        self.next_matching(
            &format!("the reply to {op}"),
            |frame| matches!(frame, Inbound::Reply { id: got, .. } if *got == json!(id)),
        )
    }

    /// A call that must succeed.
    fn call_ok(&mut self, op: &str, params: Value) -> Value {
        match self.call_raw(op, params) {
            Inbound::Reply {
                ok: true,
                data: Some(data),
                ..
            } => data,
            other => panic!("{op} was expected to succeed, got {other:?}"),
        }
    }

    /// A call that must fail, with the code the closed set allows.
    fn call_err(&mut self, op: &str, params: Value) -> ErrorBody {
        match self.call_raw(op, params) {
            Inbound::Reply {
                ok: false,
                error: Some(error),
                ..
            } => error,
            other => panic!("{op} was expected to fail, got {other:?}"),
        }
    }

    /// The next push with this name (other frames are kept).
    fn push(&mut self, event: &str) -> Value {
        let frame = self.next_matching(
            &format!("a `{event}` push"),
            |frame| matches!(frame, Inbound::Event { event: got, .. } if got == event),
        );
        data(&frame)
    }

    /// Close stdin, drain stdout, and reap the process.
    fn finish(mut self) -> (ExitStatus, Vec<Vec<u8>>, String) {
        drop(self.stdin.take());
        let mut stdout = Vec::new();
        let mut stderr_raw = Vec::new();
        if let Some(mut pipe) = self.child.stdout.take() {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut stdout);
        }
        if let Some(mut pipe) = self.child.stderr.take() {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut stderr_raw);
        }
        // Lossy rather than `unsafe`: nothing here promises stderr is UTF-8, and
        // a `String` built from invalid bytes is unsound to so much as format.
        let stderr = String::from_utf8_lossy(&stderr_raw).into_owned();
        let status = self.child.wait().expect("reap the helper");
        (status, self.skipped, stderr)
    }
}

/// The `data` of either frame kind. `Inbound` lives in the library crate, so a
/// test file cannot add inherent methods to it — this is a free function on
/// purpose, not a method the helper crate owes its callers.
fn data(frame: &Inbound) -> Value {
    match frame {
        Inbound::Event { data, .. } => data.clone(),
        Inbound::Reply { data, .. } => data.clone().unwrap_or(Value::Null),
    }
}

/// The `id` of a reply; a push has none.
fn id(frame: &Inbound) -> Value {
    match frame {
        Inbound::Reply { id, .. } => id.clone(),
        Inbound::Event { .. } => Value::Null,
    }
}

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_faragent-helper"))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn b64(bytes: &[u8]) -> String {
    proto::b64_encode(bytes)
}

fn path_b64(path: &Path) -> String {
    b64(path.as_os_str().as_bytes())
}

fn path_param(path: &Path) -> Value {
    json!({ "path_b64": path_b64(path) })
}

/// Every request in this file is expressed with `*_b64` paths, so the helper is
/// never handed a lossy string.
fn decode(value: &Value) -> Vec<u8> {
    proto::b64_decode(value.as_str().expect("a `_b64` field is a string"))
        .expect("a `_b64` field decodes")
}

fn decoded_text(value: &Value) -> String {
    String::from_utf8(decode(value)).expect("valid UTF-8")
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A repository with one commit, one modified file, one staged rename, one
/// staged addition and one untracked file — the shapes every git op has to
/// describe.
fn repo_fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main", "."]);
    // Identity per repository: CI machines have no global git identity, and a
    // commit without one fails.
    git(root, &["config", "user.email", "helper@example.test"]);
    git(root, &["config", "user.name", "Helper Test"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    std::fs::write(root.join("a.txt"), b"a\n").unwrap();
    std::fs::write(root.join("b.txt"), b"b\n").unwrap();
    std::fs::create_dir(root.join("sub")).unwrap();
    std::fs::write(root.join("sub/c.txt"), b"c\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-qm", "first commit"]);
    std::fs::write(root.join("a.txt"), b"a2\n").unwrap();
    git(root, &["mv", "b.txt", "renamed.txt"]);
    std::fs::write(root.join("untracked.txt"), b"new\n").unwrap();
    std::fs::write(root.join("staged.txt"), b"staged\n").unwrap();
    git(root, &["add", "staged.txt"]);
    dir
}

// ---------------------------------------------------------------------------
// The loop itself
// ---------------------------------------------------------------------------

#[test]
fn ping_round_trips_and_shutdown_exits_the_process() {
    let mut helper = Helper::start();
    let data = helper.call_ok("ping", json!({}));
    assert_eq!(data["pong"], json!(true));
    assert_eq!(data["version"], json!(env!("CARGO_PKG_VERSION")));
    assert!(data["pid"].as_u64().unwrap() > 0);
    assert_eq!(data["ops"], json!(faragent_helper::ops::OPS));

    let reply = helper.call_ok("shutdown", json!({}));
    assert_eq!(reply["bye"], json!(true));
    // `shutdown` really ends the process rather than only saying so.
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match helper.child.try_wait().expect("try_wait") {
            Some(status) => {
                assert!(status.success(), "shutdown should exit 0, got {status}");
                break;
            }
            None if Instant::now() >= deadline => panic!("the helper ignored `shutdown`"),
            None => thread::sleep(Duration::from_millis(25)),
        }
    }
    let (status, _, stderr) = helper.finish();
    assert!(status.success());
    assert!(stderr.is_empty(), "stderr should stay quiet: {stderr}");
}

#[test]
fn eof_on_stdin_exits_cleanly_too() {
    let helper = Helper::start();
    let (status, _, _) = helper.finish();
    assert!(status.success(), "EOF is an orderly end, got {status}");
}

#[test]
fn a_login_banner_before_the_first_frame_is_skipped() {
    let mut helper = Helper::start_behind_a_login_banner("FARAGENT TEST BANNER");
    let data = helper.call_ok("ping", json!({}));
    assert_eq!(data["pong"], json!(true));
    // The banner arrived on the same stream and was skipped, not parsed.
    assert!(
        helper
            .skipped
            .iter()
            .any(|line| line == b"FARAGENT TEST BANNER"),
        "the banner should have been seen and skipped: {:?}",
        helper.skipped
    );
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn malformed_frames_are_answered_and_the_session_survives() {
    let mut helper = Helper::start();
    // Not JSON, not an object, no op, an unknown op, an undecodable path and a
    // blank line — in one stream, ending with a request that must still work.
    helper.write_raw(b"this is not json\n");
    helper.write_raw(b"[1,2,3]\n");
    helper.write_raw(b"{\"id\":900}\n");
    helper.write_raw(b"{\"id\":901,\"op\":\"fs.list\",\"path_b64\":\"%%%\"}\n");
    helper.write_raw(b"{\"id\":902,\"op\":\"fs.delete_everything\"}\n");
    helper.write_raw(b"\n");
    let error = helper.call_err("fs.stat", path_param(Path::new("/no/such/path")));
    assert_eq!(error.code, ErrorCode::NotFound);
    // Five bad frames, five answers. The two that could not even be read as a
    // frame — not JSON at all, and a JSON array — carry no id, so their answers
    // come back id-less; the three that parsed far enough to expose an id are
    // answered under it. The connection stays in sync throughout.
    let mut ids = Vec::new();
    for _ in 0..5 {
        let frame = helper.next_matching("an error frame", |frame| {
            matches!(frame, Inbound::Reply { ok: false, .. })
        });
        ids.push(id(&frame));
    }
    assert_eq!(
        ids,
        vec![json!(null), json!(null), json!(900), json!(901), json!(902)]
    );
    let (status, _, _) = helper.finish();
    assert!(status.success(), "a bad frame must not be fatal");
}

#[test]
fn an_oversized_request_is_rejected_and_the_stream_resynchronises() {
    let mut helper = Helper::start();
    // One line past the cap, then a well-formed request on the next line.
    let mut huge = Vec::with_capacity(MAX_FRAME_BYTES + 32);
    huge.extend_from_slice(b"{\"id\":1,\"op\":\"ping\",\"junk\":\"");
    huge.resize(MAX_FRAME_BYTES + 16, b'x');
    huge.extend_from_slice(b"\"}\n");
    helper.write_raw(&huge);

    let rejected = helper.next_matching("the oversized-frame answer", |frame| {
        matches!(frame, Inbound::Reply { ok: false, .. })
    });
    match rejected {
        Inbound::Reply { error: Some(e), .. } => assert_eq!(e.code, ErrorCode::BadRequest),
        other => panic!("{other:?}"),
    }
    // The line was dropped up to its newline, not concatenated onto the next.
    let pong = helper.call_ok("ping", json!({}));
    assert_eq!(pong["pong"], json!(true));
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

// ---------------------------------------------------------------------------
// fs.*
// ---------------------------------------------------------------------------

#[test]
fn fs_list_stat_and_read_describe_real_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("plain.txt"), b"hello world\n").unwrap();
    std::fs::create_dir(root.join("nested")).unwrap();
    // Names a JSON string could carry only with escaping, and one it could not
    // carry at all: base64 is the whole point of `*_b64`.
    let candidates: Vec<std::ffi::OsString> = vec![
        "with space.txt".into(),
        "with\"quote.txt".into(),
        "with\nnewline.txt".into(),
        std::ffi::OsStr::from_bytes(b"not-utf8-\xff\xfe.txt").to_os_string(),
    ];
    // APFS (macOS) rejects a filename that is not valid UTF-8 with EILSEQ; HFS+
    // and Linux filesystems accept it. Keep whichever the filesystem took, so
    // the byte-exactness assertion still runs where it can.
    let awkward: Vec<std::ffi::OsString> = candidates
        .into_iter()
        .filter(|name| std::fs::write(root.join(name), b"x").is_ok())
        .collect();
    assert!(
        awkward.len() >= 3,
        "the UTF-8 names must be creatable: {awkward:?}"
    );

    let listed = helper_list(root);
    // Lossy: on a filesystem that stores the non-UTF-8 name, the helper
    // round-trips its exact bytes and this is the only way to compare them.
    let names: Vec<String> = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| String::from_utf8_lossy(&decode(&entry["name_b64"])).into_owned())
        .collect();
    for name in &awkward {
        let name = String::from_utf8_lossy(name.as_bytes()).into_owned();
        assert!(names.contains(&name), "{name:?} missing from {names:?}");
    }
    assert_eq!(
        decoded_text(&listed["path_b64"]),
        root.display().to_string()
    );
    assert_eq!(
        decoded_text(&listed["parent_b64"]),
        root.parent().unwrap().display().to_string()
    );

    let plain = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| decode(&entry["name_b64"]) == b"plain.txt")
        .expect("plain.txt is listed");
    assert_eq!(plain["kind"], json!("file"));
    assert_eq!(plain["size"], json!(12));

    let mut helper = Helper::start();
    let stat = helper.call_ok("fs.stat", path_param(&root.join("plain.txt")));
    assert_eq!(stat["kind"], json!("file"));
    assert_eq!(stat["size"], json!(12));
    assert_eq!(stat["is_symlink"], json!(false));

    let read = helper.call_ok("fs.read", path_param(&root.join("plain.txt")));
    assert_eq!(decode(&read["data_b64"]), b"hello world\n");
    assert_eq!(read["size"], json!(12));
    assert_eq!(read["eof"], json!(true));
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

fn helper_list(root: &Path) -> Value {
    let mut helper = Helper::start();
    let listed = helper.call_ok("fs.list", path_param(root));
    let (status, _, _) = helper.finish();
    assert!(status.success());
    listed
}

#[test]
fn fs_read_chunks_by_offset_and_limit() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("chunked.txt");
    let content: String = (0..1000)
        .map(|i| char::from(b'a' + (i % 26) as u8))
        .collect();
    std::fs::write(&file, &content).unwrap();
    let mut helper = Helper::start();

    let first = helper.call_ok(
        "fs.read",
        json!({ "path_b64": path_b64(&file), "offset": 0, "limit": 400 }),
    );
    assert_eq!(decode(&first["data_b64"]), &content.as_bytes()[..400]);
    assert_eq!(first["eof"], json!(false));
    assert_eq!(first["size"], json!(1000));

    let second = helper.call_ok(
        "fs.read",
        json!({ "path_b64": path_b64(&file), "offset": 400, "limit": 400 }),
    );
    assert_eq!(decode(&second["data_b64"]), &content.as_bytes()[400..800]);
    assert_eq!(second["eof"], json!(false));

    // The last chunk is short and reports the end.
    let third = helper.call_ok(
        "fs.read",
        json!({ "path_b64": path_b64(&file), "offset": 800, "limit": 400 }),
    );
    assert_eq!(decode(&third["data_b64"]), &content.as_bytes()[800..]);
    assert_eq!(third["eof"], json!(true));

    // An offset at or past the end is an empty read, not an error.
    let past = helper.call_ok(
        "fs.read",
        json!({ "path_b64": path_b64(&file), "offset": 5000, "limit": 10 }),
    );
    assert!(decode(&past["data_b64"]).is_empty());
    assert_eq!(past["eof"], json!(true));
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn fs_read_refuses_binaries_and_huge_files() {
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("image.bin");
    std::fs::write(&binary, [0x89, b'P', b'N', b'G', 0x00, 0x1a, 0x0a]).unwrap();
    // A file whose NUL is past the requested chunk: sniffing only the chunk
    // would call this text. The offset is inside the helper's head sniff (8 KiB,
    // git's own convention) so the head, not the chunk, is what catches it.
    let late = dir.path().join("late-nul.dat");
    let mut payload = vec![b'x'; 16 * 1024];
    payload[4 * 1024] = 0;
    std::fs::write(&late, &payload).unwrap();

    let mut helper = Helper::start();
    assert_eq!(
        helper.call_err("fs.read", path_param(&binary)).code,
        ErrorCode::Binary
    );
    assert_eq!(
        helper
            .call_err(
                "fs.read",
                json!({ "path_b64": path_b64(&late), "offset": 0, "limit": 100 })
            )
            .code,
        ErrorCode::Binary
    );

    let huge = dir.path().join("huge.bin");
    let file = std::fs::File::create(&huge).unwrap();
    file.set_len(proto::MAX_FILE_BYTES + 1).unwrap();
    drop(file);
    let error = helper.call_err("fs.read", path_param(&huge));
    assert_eq!(error.code, ErrorCode::TooLarge);
    assert!(error.message.contains("preview limit"), "{error:?}");
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn fs_errors_use_the_closed_set() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let file = root.join("a.txt");
    std::fs::write(&file, b"a\n").unwrap();
    let secret = root.join("secret");
    std::fs::create_dir(&secret).unwrap();
    std::fs::write(secret.join("inside.txt"), b"x").unwrap();
    std::fs::set_permissions(&secret, PermissionsExt::from_mode(0o000)).unwrap();
    // Under root, mode 000 is not actually denied; only assert if the OS says no.
    let denied = std::fs::read(secret.join("inside.txt")).is_err();

    let mut helper = Helper::start();
    assert_eq!(
        helper
            .call_err("fs.stat", path_param(&root.join("missing")))
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        helper.call_err("fs.list", path_param(&file)).code,
        ErrorCode::NotADir
    );
    if denied {
        assert_eq!(
            helper
                .call_err("fs.read", path_param(&secret.join("inside.txt")))
                .code,
            ErrorCode::Unreadable
        );
        assert_eq!(
            helper.call_err("fs.list", path_param(&secret)).code,
            ErrorCode::Unreadable
        );
    } else {
        eprintln!("running as root: skipping the permission-denied assertions");
    }
    // A missing `path_b64` is the caller's mistake.
    let missing = helper.call_err("fs.list", json!({}));
    assert_eq!(missing.code, ErrorCode::BadRequest);

    // The session is in sync throughout, and permissions were restored so the
    // temp dir can be cleaned up.
    std::fs::set_permissions(&secret, PermissionsExt::from_mode(0o755)).unwrap();
    let (status, _, _) = helper.finish();
    assert!(status.success());
    std::fs::set_permissions(&secret, PermissionsExt::from_mode(0o755)).unwrap();
}

#[test]
fn fs_list_reports_truncation_past_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for i in 0..(proto::MAX_LIST_ENTRIES + 3) {
        std::fs::write(root.join(format!("file-{i:04}.txt")), b"x").unwrap();
    }
    let listed = helper_list(root);
    assert_eq!(
        listed["entries"].as_array().unwrap().len(),
        proto::MAX_LIST_ENTRIES
    );
    assert_eq!(listed["truncated"], json!(true));
}

// ---------------------------------------------------------------------------
// git.*
// ---------------------------------------------------------------------------

#[test]
fn git_discover_walks_up_and_reports_when_there_is_no_repository() {
    let dir = repo_fixture();
    let root = dir.path().to_path_buf();
    let deep = root.join("sub");
    let mut helper = Helper::start();

    let found = helper.call_ok("git.discover", json!({ "root_b64": path_b64(&deep) }));
    assert_eq!(decode(&found["root_b64"]), root.as_os_str().as_bytes());
    assert_eq!(decoded_text(&found["path_b64"]), deep.display().to_string());
    assert_eq!(
        decoded_text(&found["name_b64"]),
        root.file_name().unwrap().to_string_lossy()
    );
    assert!(decoded_text(&found["git_dir_b64"]).ends_with("/.git"));

    let outside = tempfile::tempdir().unwrap();
    let error = helper.call_err(
        "git.discover",
        json!({ "root_b64": path_b64(outside.path()) }),
    );
    assert_eq!(error.code, ErrorCode::NotARepo);
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn git_status_reports_branch_and_every_change_kind() {
    let dir = repo_fixture();
    let root = dir.path();
    let mut helper = Helper::start();
    let status = helper.call_ok("git.status", json!({ "root_b64": path_b64(root) }));

    assert_eq!(decoded_text(&status["branch_b64"]), "main");
    assert_eq!(status["detached"], json!(false));
    assert_eq!(status["initial"], json!(false));
    assert_eq!(status["clean"], json!(false));
    assert_eq!(
        status["upstream_b64"],
        json!(null),
        "no upstream is configured"
    );
    assert_eq!(status["ahead"], json!(null));
    assert_eq!(status["oid"].as_str().unwrap().len(), 40);

    let files = status["files"].as_array().unwrap();
    let find = |name: &[u8]| -> Value {
        files
            .iter()
            .find(|entry| decode(&entry["path_b64"]) == name)
            .unwrap_or_else(|| panic!("{} missing from {files:?}", String::from_utf8_lossy(name)))
            .clone()
    };
    let modified = find(b"a.txt");
    assert_eq!(modified["status"], json!("modified"));
    assert_eq!(modified["staged"], json!(false));
    let renamed = find(b"renamed.txt");
    assert_eq!(renamed["status"], json!("renamed"));
    assert_eq!(renamed["staged"], json!(true));
    assert_eq!(decode(&renamed["orig_path_b64"]), b"b.txt");
    let added = find(b"staged.txt");
    assert_eq!(added["status"], json!("added"));
    assert_eq!(added["staged"], json!(true));
    let untracked = find(b"untracked.txt");
    assert_eq!(untracked["status"], json!("untracked"));
    assert_eq!(untracked["staged"], json!(false));

    // A clean repository says so.
    git(root, &["add", "-A"]);
    git(root, &["commit", "-qm", "second commit"]);
    let clean = helper.call_ok("git.status", json!({ "root_b64": path_b64(root) }));
    assert_eq!(clean["clean"], json!(true));
    assert_eq!(clean["files"].as_array().unwrap().len(), 0);
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn git_branches_and_log_describe_the_history() {
    let dir = repo_fixture();
    let root = dir.path();
    git(root, &["checkout", "-q", "-b", "feature", "main"]);
    git(root, &["checkout", "-q", "main"]);
    let mut helper = Helper::start();

    let branches = helper.call_ok("git.branches", json!({ "root_b64": path_b64(root) }));
    let names: Vec<String> = branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| decoded_text(&b["name_b64"]))
        .collect();
    assert!(names.contains(&"main".to_string()), "{names:?}");
    assert!(names.contains(&"feature".to_string()), "{names:?}");
    assert_eq!(decoded_text(&branches["current_b64"]), "main");
    let main = branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| decode(&b["name_b64"]) == b"main")
        .unwrap();
    assert_eq!(main["current"], json!(true));
    assert_eq!(main["remote"], json!(false));
    assert_eq!(main["oid"].as_str().unwrap().len(), 40);

    let log = helper.call_ok(
        "git.log",
        json!({ "root_b64": path_b64(root), "limit": 10 }),
    );
    let commits = log["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(log["truncated"], json!(false));
    assert_eq!(decoded_text(&commits[0]["subject_b64"]), "first commit");
    assert_eq!(decoded_text(&commits[0]["author_b64"]), "Helper Test");
    assert_eq!(
        decoded_text(&commits[0]["email_b64"]),
        "helper@example.test"
    );
    assert!(commits[0]["author_date"]
        .as_str()
        .unwrap()
        .starts_with("20"));
    assert_eq!(commits[0]["parents"].as_array().unwrap().len(), 0);
    let refs = decoded_text(&commits[0]["refs_b64"]);
    assert!(refs.contains("HEAD -> main"), "{refs:?}");

    // A second commit, and the page reports there is more behind it.
    git(
        root,
        &["commit", "-q", "--allow-empty", "-m", "second commit"],
    );
    let paged = helper.call_ok("git.log", json!({ "root_b64": path_b64(root), "limit": 1 }));
    assert_eq!(paged["commits"].as_array().unwrap().len(), 1);
    assert_eq!(paged["truncated"], json!(true));
    assert_eq!(
        decoded_text(&paged["commits"][0]["subject_b64"]),
        "second commit"
    );
    let skipped = helper.call_ok(
        "git.log",
        json!({ "root_b64": path_b64(root), "limit": 1, "skip": 1 }),
    );
    assert_eq!(
        decoded_text(&skipped["commits"][0]["subject_b64"]),
        "first commit"
    );
    assert_eq!(skipped["truncated"], json!(false));

    // A path filter narrows the history to the commits that touched it.
    let filtered = helper.call_ok(
        "git.log",
        json!({ "root_b64": path_b64(root), "limit": 10, "path_b64": path_b64(&root.join("a.txt")) }),
    );
    assert_eq!(filtered["commits"].as_array().unwrap().len(), 1);
    assert_eq!(
        decoded_text(&filtered["commits"][0]["subject_b64"]),
        "first commit"
    );
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn git_diff_covers_the_workspace_staging_area_and_a_single_path() {
    let dir = repo_fixture();
    let root = dir.path();
    let mut helper = Helper::start();

    let working = helper.call_ok("git.diff", json!({ "root_b64": path_b64(root) }));
    assert_eq!(working["files_only"], json!(false));
    assert_eq!(working["staged"], json!(false));
    let paths: Vec<Vec<u8>> = working["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| decode(&f["path_b64"]))
        .collect();
    assert_eq!(paths, vec![b"a.txt".to_vec()], "only the unstaged change");
    assert_eq!(working["files"][0]["status"], json!("modified"));
    let patch = decoded_text(&working["diff_b64"]);
    assert!(patch.contains("diff --git a/a.txt b/a.txt"), "{patch}");
    assert!(patch.contains("-a\n+a2\n"), "{patch}");
    assert_eq!(working["binary"], json!(false));

    let staged = helper.call_ok(
        "git.diff",
        json!({ "root_b64": path_b64(root), "staged": true }),
    );
    let staged_paths: Vec<Vec<u8>> = staged["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| decode(&f["path_b64"]))
        .collect();
    assert!(
        staged_paths.contains(&b"staged.txt".to_vec()),
        "{staged_paths:?}"
    );
    assert!(
        staged_paths.contains(&b"renamed.txt".to_vec()),
        "{staged_paths:?}"
    );
    let renamed = staged["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| decode(&f["path_b64"]) == b"renamed.txt")
        .unwrap();
    assert_eq!(renamed["status"], json!("renamed"));
    assert_eq!(decode(&renamed["orig_path_b64"]), b"b.txt");

    let single = helper.call_ok(
        "git.diff",
        json!({ "root_b64": path_b64(root), "path_b64": path_b64(&root.join("a.txt")) }),
    );
    assert_eq!(single["files"].as_array().unwrap().len(), 1);
    assert_eq!(
        decoded_text(&single["path_b64"]),
        root.join("a.txt").display().to_string()
    );

    let listed = helper.call_ok(
        "git.diff",
        json!({ "root_b64": path_b64(root), "files_only": true }),
    );
    assert_eq!(listed["files_only"], json!(true));
    assert_eq!(listed["diff_b64"], json!(null));

    // An empty resulting diff is an empty list, not an error.
    let clean = tempfile::tempdir().unwrap();
    git(clean.path(), &["init", "-q", "-b", "main", "."]);
    let empty = helper.call_ok("git.diff", json!({ "root_b64": path_b64(clean.path()) }));
    assert_eq!(empty["files"].as_array().unwrap().len(), 0);
    assert_eq!(
        empty["diff_b64"].as_str().unwrap(),
        "",
        "an empty patch is empty text"
    );

    let not_a_repo = tempfile::tempdir().unwrap();
    assert_eq!(
        helper
            .call_err(
                "git.diff",
                json!({ "root_b64": path_b64(not_a_repo.path()) })
            )
            .code,
        ErrorCode::NotARepo
    );
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn git_diff_falls_back_to_a_file_list_when_the_patch_is_too_big() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main", "."]);
    git(root, &["config", "user.email", "helper@example.test"]);
    git(root, &["config", "user.name", "Helper Test"]);
    // One line, rewritten: a patch of roughly twice the file's size, well past
    // what one frame can carry.
    let before = "a".repeat(4 * 1024 * 1024);
    let after = "b".repeat(4 * 1024 * 1024);
    std::fs::write(root.join("big.txt"), &before).unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-qm", "big file"]);
    std::fs::write(root.join("big.txt"), &after).unwrap();

    let mut helper = Helper::start();
    let diff = helper.call_ok("git.diff", json!({ "root_b64": path_b64(root) }));
    // The file list still arrives; the patch is reported as omitted rather
    // than blowing the frame cap or the connection.
    assert_eq!(diff["files_only"], json!(true), "{diff:.200}");
    assert_eq!(diff["diff_b64"], json!(null));
    assert_eq!(decoded_text(&diff["files"][0]["path_b64"]), "big.txt");
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn a_git_failure_is_git_failed_not_a_panic() {
    let dir = repo_fixture();
    let root = dir.path();
    // A HEAD that names an object which does not exist: discovery still
    // succeeds (there is a `.git`), and `git log` exits non-zero.
    std::fs::write(root.join(".git/HEAD"), format!("{}\n", "0".repeat(40))).unwrap();
    let mut helper = Helper::start();
    let error = helper.call_err("git.log", json!({ "root_b64": path_b64(root) }));
    assert_eq!(error.code, ErrorCode::GitFailed);
    assert!(!error.message.is_empty(), "the git diagnostic is forwarded");
    // Discovery is filesystem-only, so it still answers.
    let found = helper.call_ok("git.discover", json!({ "root_b64": path_b64(root) }));
    assert_eq!(decode(&found["root_b64"]), root.as_os_str().as_bytes());
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn a_missing_git_binary_is_internal() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".git")).unwrap();
    // No PATH, so the helper cannot spawn `git` at all. That is a condition of
    // the machine, not of the caller's request: `internal`.
    let mut helper = Helper::start_with_env(&[("PATH", "/nonexistent")]);
    let found = helper.call_ok("git.discover", json!({ "root_b64": path_b64(dir.path()) }));
    assert_eq!(
        decode(&found["root_b64"]),
        dir.path().as_os_str().as_bytes()
    );
    let error = helper.call_err("git.status", json!({ "root_b64": path_b64(dir.path()) }));
    assert_eq!(error.code, ErrorCode::Internal);
    assert!(error.message.contains("git"), "{error:?}");
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

// ---------------------------------------------------------------------------
// watch.*
// ---------------------------------------------------------------------------

#[test]
fn watch_subscribe_is_idempotent_and_pushes_fs_changed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut helper = Helper::start();

    let first = helper.call_ok("watch.subscribe", json!({ "path_b64": path_b64(&root) }));
    let id = first["subscription"].as_u64().unwrap();
    assert_eq!(first["already"], json!(false));
    assert_eq!(first["recursive"], json!(true));
    assert_eq!(decode(&first["path_b64"]), root.as_os_str().as_bytes());

    // Subscribing again is the same subscription, not a second one.
    let again = helper.call_ok("watch.subscribe", json!({ "path_b64": path_b64(&root) }));
    assert_eq!(again["already"], json!(true));
    assert_eq!(again["subscription"].as_u64().unwrap(), id);

    let file = root.join("created.txt");
    std::fs::write(&file, b"hello\n").unwrap();
    let pushed = helper.push("fs.changed");
    assert_eq!(pushed["subscription"].as_u64().unwrap(), id);
    assert_eq!(decode(&pushed["root_b64"]), root.as_os_str().as_bytes());
    assert_eq!(decode(&pushed["path_b64"]), file.as_os_str().as_bytes());
    assert!(
        ["created", "modified", "renamed", "other"].contains(&pushed["kind"].as_str().unwrap()),
        "unexpected kind: {pushed}"
    );

    // Unsubscribing by id reports the removal, and a second time is a no-op.
    let gone = helper.call_ok("watch.unsubscribe", json!({ "subscription": id }));
    assert_eq!(gone["removed"], json!(1));
    let gone_again = helper.call_ok("watch.unsubscribe", json!({ "subscription": id }));
    assert_eq!(gone_again["removed"], json!(0));
    // A request that names nothing at all is the caller's mistake.
    assert_eq!(
        helper.call_err("watch.unsubscribe", json!({})).code,
        ErrorCode::BadRequest
    );
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn a_subscription_named_by_path_can_also_be_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let mut helper = Helper::start();
    helper.call_ok(
        "watch.subscribe",
        json!({ "path_b64": path_b64(dir.path()) }),
    );
    let gone = helper.call_ok(
        "watch.unsubscribe",
        json!({ "path_b64": path_b64(dir.path()) }),
    );
    assert_eq!(gone["removed"], json!(1));
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn watch_pushes_git_changed_when_head_moves() {
    let dir = repo_fixture();
    let root = dir.path().to_path_buf();
    let mut helper = Helper::start();
    let subscribed = helper.call_ok("watch.subscribe", json!({ "path_b64": path_b64(&root) }));
    let id = subscribed["subscription"].as_u64().unwrap();
    assert!(
        subscribed["git_dir_b64"].is_string(),
        "a subscription inside a repository reports its git directory: {subscribed}"
    );

    // A checkout rewrites `.git/HEAD` — the branch name is longer than the old
    // one, so the change is visible even on a filesystem with one-second
    // timestamps.
    git(&root, &["checkout", "-q", "-b", "moved"]);
    let pushed = helper.push("git.changed");
    assert_eq!(pushed["subscription"].as_u64().unwrap(), id);
    assert_eq!(decode(&pushed["root_b64"]), root.as_os_str().as_bytes());
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

#[test]
fn a_subscription_outside_a_repository_never_pushes_git_changed() {
    let dir = tempfile::tempdir().unwrap();
    let mut helper = Helper::start();
    let subscribed = helper.call_ok(
        "watch.subscribe",
        json!({ "path_b64": path_b64(dir.path()) }),
    );
    assert_eq!(subscribed["git_dir_b64"], json!(null));
    // A write produces an fs.changed push and nothing else; the git poll has
    // nothing to compare.
    std::fs::write(dir.path().join("x.txt"), b"x").unwrap();
    let pushed = helper.push("fs.changed");
    assert_eq!(pushed["subscription"].as_u64().unwrap(), 1);
    let (status, _, _) = helper.finish();
    assert!(status.success());
}

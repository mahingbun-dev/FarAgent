//! The bash fallback channel, spoken to for real.
//!
//! Every assertion here crosses the wire: a request frame is written to the
//! script's stdin, one reply frame is read from its stdout and parsed with
//! `faragent_helper::proto` — the same `parse_line` the helper's own frames go
//! through. Nothing is asserted about the script text (that is `src/lib.rs`'s
//! job); if the script and the helper disagreed about a frame's shape, this is
//! where it would show.
//!
//! The fixtures are real: a real `bash`, a real temporary tree, a real `git
//! init` and real commits. Nothing is mocked, because the whole risk in a
//! hand-written shell protocol is what a real shell and a real `git` do.

#![cfg(unix)]

use faragent_helper::proto::{b64_decode, b64_encode, parse_line, ErrorCode, Inbound, Request};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Generous: a `git init` and a few commits are the slowest things here, and a
/// hung script must fail loudly rather than block a test run forever.
const TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/// Decode one `_b64` field's bytes. A missing or non-base64 field is a test
/// failure, not a panic in the harness.
fn bytes_of(value: &Value, key: &str) -> Vec<u8> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no string `{key}` in {value}"));
    b64_decode(text).unwrap_or_else(|e| panic!("`{key}` is not base64 ({e}): {value}"))
}

/// Decode one `_b64` field that is known to hold UTF-8.
fn text_of(value: &Value, key: &str) -> String {
    String::from_utf8(bytes_of(value, key)).unwrap_or_else(|e| panic!("`{key}` is not UTF-8: {e}"))
}

/// One field that travels plain, as a `&str`.
fn plain<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no plain string `{key}` in {value}"))
}

/// The bytes of a path as the OS holds them — a filename need not be UTF-8.
fn path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str().as_bytes().to_vec()
}

fn bytes_path(bytes: &[u8]) -> PathBuf {
    PathBuf::from(OsStr::from_bytes(bytes))
}

fn b64(bytes: &[u8]) -> String {
    b64_encode(bytes)
}

/// One reply frame, as `parse_line` read it.
#[derive(Debug)]
struct Reply {
    id: Value,
    ok: bool,
    data: Value,
    error: Option<(ErrorCode, String)>,
}

impl Reply {
    fn data(&self, ctx: &str) -> &Value {
        assert!(self.ok, "{ctx}: expected success, got {self:?}");
        &self.data
    }

    fn code(&self, ctx: &str) -> ErrorCode {
        assert!(!self.ok, "{ctx}: expected a failure, got {self:?}");
        match &self.error {
            Some((code, _)) => *code,
            // An `ok:false` frame whose code is outside the closed set does not
            // even parse into `error`, which is exactly what this asserts.
            None => panic!("{ctx}: failure with no recognised error code: {self:?}"),
        }
    }

    fn message(&self, ctx: &str) -> String {
        self.code(ctx);
        self.error.as_ref().expect("checked above").1.clone()
    }
}

/// A running fallback script, with a thread draining its stdout so a reply that
/// never comes surfaces as a timeout rather than a deadlock.
struct Fallback {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<String>,
    seen: Vec<String>,
}

impl Fallback {
    /// Start the script the way the transport does: `bash -lc '<script>'`, all
    /// three stdio piped, stdin the request channel.
    fn start(home: &Path) -> Fallback {
        Fallback::start_with(home, None, true)
    }

    /// Start it without a login shell and with a chosen `PATH`. Used to hide
    /// `base64` (and with it every external tool) from the script.
    fn start_with(home: &Path, path: Option<&str>, login: bool) -> Fallback {
        let script = faragent_remote::posix_fallback_script();
        let mut command = Command::new(bash());
        if login {
            command.arg("-lc").arg(&script);
        } else {
            command.arg("-c").arg(&script);
        }
        command
            .env("HOME", home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(path) = path {
            command.env("PATH", path);
        }
        let mut child = command.spawn().expect("spawn bash");
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        Fallback {
            child,
            stdin: Some(stdin),
            rx,
            seen: Vec::new(),
        }
    }

    fn write_line(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin still open");
        writeln!(stdin, "{line}").expect("write request");
        stdin.flush().expect("flush request");
    }

    /// Send one request. The frame is checked against the helper's own request
    /// parser first, so a test cannot pass by sending something the helper
    /// would have refused.
    fn send(&mut self, id: u64, op: &str, params: Value) {
        let mut obj = Map::new();
        obj.insert("id".to_string(), json!(id));
        obj.insert("op".to_string(), json!(op));
        if let Value::Object(params) = params {
            for (key, value) in params {
                obj.insert(key, value);
            }
        }
        let line = Value::Object(obj).to_string();
        if let Err(e) = Request::from_line(line.as_bytes()) {
            panic!("test frame is not a legal helper request: {e}: {line}");
        }
        self.write_line(&line);
    }

    /// The next frame on the wire, skipping whatever does not parse as one —
    /// which is how a client tolerates a login shell's banner.
    fn next_reply(&mut self) -> Reply {
        loop {
            let line = match self.rx.recv_timeout(TIMEOUT) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => {
                    panic!(
                        "no frame within {TIMEOUT:?}; frames so far: {:?}",
                        self.seen
                    )
                }
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("the script closed stdout; frames so far: {:?}", self.seen)
                }
            };
            match parse_line(line.trim_end().as_bytes()) {
                Some(Inbound::Reply {
                    id,
                    ok,
                    data,
                    error,
                }) => {
                    self.seen.push(line);
                    return Reply {
                        id,
                        ok,
                        data: data.unwrap_or(Value::Null),
                        error: error.map(|e| (e.code, e.message)),
                    };
                }
                Some(Inbound::Event { event, .. }) => {
                    panic!("unexpected push `{event}`: {line}")
                }
                None => {
                    self.seen.push(line);
                    continue;
                }
            }
        }
    }

    /// Send one request and return its reply, which must carry the same `id`.
    fn call(&mut self, id: u64, op: &str, params: Value) -> Reply {
        self.send(id, op, params);
        let reply = self.next_reply();
        assert_eq!(
            reply.id,
            json!(id),
            "the reply for id {id} carried another id (out of step?): {reply:?}"
        );
        reply
    }

    /// Close the request channel and wait for the script to notice EOF.
    fn close_and_wait(&mut self) -> ExitStatus {
        self.stdin = None;
        self.child.wait().expect("wait for the script")
    }
}

impl Drop for Fallback {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A `bash` to run the script under. An absolute path, so a test that clears
/// `PATH` for the child still starts a shell.
fn bash() -> &'static str {
    for candidate in ["/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"] {
        if Path::new(candidate).exists() {
            return candidate;
        }
    }
    "bash"
}

/// A temporary root, removed on drop. Deliberately not `canonicalize`d: the
/// script walks and prints paths as the caller spelled them, so the test does
/// too.
struct Temp(PathBuf);

impl Temp {
    fn new(tag: &str) -> Temp {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "faragent-fallback-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create temp root");
        Temp(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------
// A real repository, driven by the real `git`
// ---------------------------------------------------------------------------

/// A repository plus the environment the script's `git` needs in order to see
/// the same thing this test's `git` does.
struct Repo {
    root: PathBuf,
    home: PathBuf,
}

impl Repo {
    fn init(root: &Path, home: &Path) -> Repo {
        let repo = Repo {
            root: root.to_path_buf(),
            home: home.to_path_buf(),
        };
        repo.git(&["init", "-q", "-b", "main"]);
        // Identity locally, and no signing: the test must not depend on (or
        // touch) the machine's global git config, and `HOME` is a temp dir so
        // there is no global config to find.
        repo.git(&["config", "user.name", "A\"b\\c$(x)`y`"]);
        repo.git(&["config", "user.email", "a\"b\\c@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }

    fn git(&self, args: &[&str]) {
        let out = self.git_out(args);
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn git_out(&self, args: &[&str]) -> Output {
        Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .env("HOME", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("run git")
    }

    fn stdout(&self, args: &[&str]) -> String {
        let out = self.git_out(args);
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Write a file (creating parents), add it and commit it.
    fn commit_file(&self, name: &str, content: &str) {
        let path = self.root.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&path, content).expect("write file");
        self.git(&["add", "--", name]);
        self.git(&["commit", "-q", "-m", &format!("add {name}")]);
    }
}

/// Whether `git` can be run at all. The git tests skip (loudly) without it.
fn have_git() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn is_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

/// A `PATH` that resolves every tool the real one does *except* `base64`, so
/// the script's `command -v base64` probe fails while `sed`, `tr` and `stat`
/// still work. The point is a host without `base64`, not a host without a
/// shell's toolkit — hiding all of `PATH` would test something else entirely.
fn path_without_base64(tmp: &Path) -> Option<PathBuf> {
    let bin = tmp.join("bin");
    std::fs::create_dir_all(&bin).ok()?;
    let real = std::env::var_os("PATH")?;
    let mut linked = std::collections::HashSet::new();
    for dir in std::env::split_paths(&real) {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let name = entry.file_name();
            if name == OsStr::new("base64") || !linked.insert(name.clone()) {
                continue;
            }
            let path = entry.path();
            if path.is_file() || path.is_symlink() {
                let _ = std::os::unix::fs::symlink(&path, bin.join(&name));
            }
        }
    }
    if bin.join("base64").exists() || !bin.join("sed").exists() {
        return None;
    }
    Some(bin)
}

/// Assert one reply is a failure with `code`, and that the code is in the
/// helper's closed set.
fn record(seen: &mut Vec<ErrorCode>, reply: Reply, ctx: &str) -> ErrorCode {
    let code = reply.code(ctx);
    assert!(
        ErrorCode::ALL.contains(&code),
        "{ctx}: {code:?} is not in the closed error set"
    );
    seen.push(code);
    code
}

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

#[test]
fn ping_round_trips_through_the_helper_parser() {
    let tmp = Temp::new("ping");
    let mut fb = Fallback::start(tmp.path());
    let reply = fb.call(1, "ping", json!(null));
    let data = reply.data("ping");
    assert_eq!(data["pong"], json!(true));
    assert_eq!(data["version"], json!(env!("CARGO_PKG_VERSION")));
    // `$$` in the served shell: a real pid, not the helper's.
    assert!(data["pid"].as_u64().unwrap_or(0) > 0, "{data}");
    let ops: Vec<&str> = data["ops"]
        .as_array()
        .expect("ops is an array")
        .iter()
        .map(|v| v.as_str().expect("ops are strings"))
        .collect();
    // Advertises exactly the read-only subset, and nothing outside the helper's
    // vocabulary.
    assert_eq!(
        ops,
        vec![
            "ping",
            "fs.list",
            "fs.read",
            "fs.stat",
            "git.discover",
            "git.status",
            "git.log",
        ]
    );
    // An op the helper has and the fallback does not is refused, not ignored,
    // and the refusal names the op.
    let reply = fb.call(2, "watch.subscribe", json!({"dir_b64": ""}));
    assert_eq!(reply.code("watch.subscribe"), ErrorCode::BadRequest);
    assert!(reply.message("watch.subscribe").contains("watch.subscribe"));
    assert!(fb.close_and_wait().success(), "the script exits 0 on EOF");
}

// ---------------------------------------------------------------------------
// fs.stat
// ---------------------------------------------------------------------------

#[test]
fn fs_stat_reports_lstat_for_files_dirs_symlinks_and_dangling_links() {
    let tmp = Temp::new("stat");
    let root = tmp.path();
    std::fs::write(root.join("file.txt"), b"0123456789").expect("write");
    std::fs::create_dir(root.join("sub")).expect("mkdir");
    std::os::unix::fs::symlink("file.txt", root.join("link")).expect("symlink");
    std::os::unix::fs::symlink("nowhere", root.join("dangling")).expect("symlink");

    let mut fb = Fallback::start(root);

    // A regular file: every stat field comes from the file itself.
    let p = root.join("file.txt");
    let data = fb
        .call(1, "fs.stat", json!({"path_b64": b64(&path_bytes(&p))}))
        .data("fs.stat file")
        .clone();
    assert_eq!(data["kind"], json!("file"));
    assert_eq!(data["size"], json!(10));
    assert_eq!(data["is_symlink"], json!(false));
    assert_eq!(
        data["mode"],
        json!(mode_of(&p)),
        "st_mode, type bits included"
    );
    assert_eq!(data["mtime"], json!(mtime_of(&p)));
    assert_eq!(bytes_of(&data, "path_b64"), path_bytes(&p));

    // A directory.
    let p = root.join("sub");
    let data = fb
        .call(2, "fs.stat", json!({"path_b64": b64(&path_bytes(&p))}))
        .data("fs.stat dir")
        .clone();
    assert_eq!(data["kind"], json!("dir"));
    assert_eq!(data["is_symlink"], json!(false));
    assert_eq!(data["mode"], json!(mode_of(&p)));

    // A symlink: `size` and `mode` are the *link's*, not the target's, and the
    // link is not followed — the helper's `symlink_metadata`.
    let p = root.join("link");
    let data = fb
        .call(3, "fs.stat", json!({"path_b64": b64(&path_bytes(&p))}))
        .data("fs.stat symlink")
        .clone();
    assert_eq!(data["kind"], json!("symlink"));
    assert_eq!(data["is_symlink"], json!(true));
    assert_eq!(data["size"], json!(b"file.txt".len()));
    assert_eq!(data["mode"], json!(mode_of(&p)));

    // A dangling symlink still exists as a link: not `not_found`.
    let p = root.join("dangling");
    let data = fb
        .call(4, "fs.stat", json!({"path_b64": b64(&path_bytes(&p))}))
        .data("fs.stat dangling")
        .clone();
    assert_eq!(data["kind"], json!("symlink"));
    assert_eq!(data["size"], json!(b"nowhere".len()));
    assert_eq!(data["mode"], json!(mode_of(&p)));

    // A missing path is not_found, and the message names it.
    let p = root.join("nope");
    let reply = fb.call(5, "fs.stat", json!({"path_b64": b64(&path_bytes(&p))}));
    assert_eq!(reply.code("fs.stat missing"), ErrorCode::NotFound);
    assert!(reply.message("fs.stat missing").contains("nope"));
}

// ---------------------------------------------------------------------------
// fs.read
// ---------------------------------------------------------------------------

#[test]
fn fs_read_honours_offset_and_limit_and_reports_eof() {
    let tmp = Temp::new("read");
    let root = tmp.path();
    let body: &[u8] = b"hello world\nsecond line\n";
    std::fs::write(root.join("hello.txt"), body).expect("write");
    std::fs::write(root.join("empty.txt"), b"").expect("write");
    let file_b64 = b64(&path_bytes(&root.join("hello.txt")));

    let mut fb = Fallback::start(root);

    // The whole file: the default limit is far above its size.
    let data = fb
        .call(1, "fs.read", json!({"path_b64": file_b64}))
        .data("read whole")
        .clone();
    assert_eq!(bytes_of(&data, "data_b64"), body);
    assert_eq!(data["eof"], json!(true));
    assert_eq!(data["size"], json!(body.len()));

    // A window in the middle is not at EOF.
    let data = fb
        .call(
            2,
            "fs.read",
            json!({"path_b64": file_b64, "offset": 6, "limit": 5}),
        )
        .data("read window")
        .clone();
    assert_eq!(bytes_of(&data, "data_b64"), b"world");
    assert_eq!(data["eof"], json!(false));
    assert_eq!(data["size"], json!(body.len()));

    // A window that ends exactly on EOF is at EOF: 19 + 5 == 24.
    let data = fb
        .call(
            3,
            "fs.read",
            json!({"path_b64": file_b64, "offset": 19, "limit": 5}),
        )
        .data("read tail")
        .clone();
    assert_eq!(bytes_of(&data, "data_b64"), b"line\n");
    assert_eq!(data["eof"], json!(true));

    // An offset past EOF answers with nothing, not an error.
    let data = fb
        .call(4, "fs.read", json!({"path_b64": file_b64, "offset": 999}))
        .data("read past eof")
        .clone();
    assert_eq!(bytes_of(&data, "data_b64"), b"");
    assert_eq!(data["eof"], json!(true));
    assert_eq!(data["size"], json!(body.len()));

    // `limit: 0` clamps to one byte, exactly like the helper's `.clamp(1, …)`.
    let data = fb
        .call(5, "fs.read", json!({"path_b64": file_b64, "limit": 0}))
        .data("read limit 0")
        .clone();
    assert_eq!(bytes_of(&data, "data_b64"), b"h");

    // An empty file is at EOF immediately and reads as the empty chunk.
    let data = fb
        .call(
            6,
            "fs.read",
            json!({"path_b64": b64(&path_bytes(&root.join("empty.txt")))}),
        )
        .data("read empty")
        .clone();
    assert_eq!(bytes_of(&data, "data_b64"), b"");
    assert_eq!(data["eof"], json!(true));
    assert_eq!(data["size"], json!(0));
}

#[test]
fn fs_read_follows_a_symlink_and_reports_the_target_size() {
    let tmp = Temp::new("readlink");
    let root = tmp.path();
    let target: &[u8] = b"through the link";
    std::fs::write(root.join("target.txt"), target).expect("write");
    std::os::unix::fs::symlink("target.txt", root.join("link")).expect("symlink");
    let link = root.join("link");

    let mut fb = Fallback::start(root);
    let data = fb
        .call(1, "fs.read", json!({"path_b64": b64(&path_bytes(&link))}))
        .data("read via symlink")
        .clone();
    // The helper opens the path, so the *target's* bytes and size come back —
    // unlike `fs.stat`, which reports the link.
    assert_eq!(bytes_of(&data, "data_b64"), target);
    assert_eq!(data["size"], json!(target.len()));
    assert_eq!(data["eof"], json!(true));
}

#[test]
fn fs_read_detects_binary_at_the_head_and_beyond_the_sniff() {
    let tmp = Temp::new("binary");
    let root = tmp.path();
    std::fs::write(root.join("elf.dat"), b"ELF\x00\x01\x02binary").expect("write");
    // A NUL at byte 10 000 of a 20 000-byte file: invisible to the 8 KiB head
    // sniff, so only the per-chunk check can catch it.
    let mut mid = vec![b'a'; 10_000];
    mid.push(0);
    mid.resize(20_000, b'b');
    std::fs::write(root.join("mid.bin"), &mid).expect("write");
    std::fs::write(root.join("latin1.txt"), b"caf\xe9\n").expect("write");

    let mut fb = Fallback::start(root);

    // The head sniff.
    let reply = fb.call(
        1,
        "fs.read",
        json!({"path_b64": b64(&path_bytes(&root.join("elf.dat")))}),
    );
    assert_eq!(reply.code("read binary head"), ErrorCode::Binary);
    assert!(reply.message("read binary head").contains("binary file"));

    // The chunk check, past the sniffed head.
    let reply = fb.call(
        2,
        "fs.read",
        json!({
            "path_b64": b64(&path_bytes(&root.join("mid.bin"))),
            "offset": 9_500,
            "limit": 1_000,
        }),
    );
    assert_eq!(reply.code("read binary chunk"), ErrorCode::Binary);

    // The same file, a window that stops short of the NUL, is text.
    let data = fb
        .call(
            3,
            "fs.read",
            json!({
                "path_b64": b64(&path_bytes(&root.join("mid.bin"))),
                "offset": 0,
                "limit": 100,
            }),
        )
        .data("read text window")
        .clone();
    assert_eq!(bytes_of(&data, "data_b64"), vec![b'a'; 100]);
    assert_eq!(data["eof"], json!(false));

    // Invalid UTF-8 alone is not binary: a Latin-1 line previews.
    let data = fb
        .call(
            4,
            "fs.read",
            json!({"path_b64": b64(&path_bytes(&root.join("latin1.txt")))}),
        )
        .data("read latin1")
        .clone();
    assert_eq!(bytes_of(&data, "data_b64"), b"caf\xe9\n");
}

#[test]
fn fs_read_refuses_oversized_directories_and_missing_paths() {
    let tmp = Temp::new("readrefuse");
    let root = tmp.path();
    std::fs::create_dir(root.join("adir")).expect("mkdir");
    // Sparse: the size check must come before any read, and this is 300 MB
    // without occupying any of it.
    let huge = root.join("huge.dat");
    let f = std::fs::File::create(&huge).expect("create");
    f.set_len(300_000_000).expect("set_len");
    drop(f);

    let mut fb = Fallback::start(root);

    let reply = fb.call(1, "fs.read", json!({"path_b64": b64(&path_bytes(&huge))}));
    assert_eq!(reply.code("read oversized"), ErrorCode::TooLarge);
    assert!(reply.message("read oversized").contains("300000000"));

    let reply = fb.call(
        2,
        "fs.read",
        json!({"path_b64": b64(&path_bytes(&root.join("adir")))}),
    );
    assert_eq!(reply.code("read a directory"), ErrorCode::Unreadable);
    assert!(reply
        .message("read a directory")
        .contains("not a regular file"));

    let reply = fb.call(
        3,
        "fs.read",
        json!({"path_b64": b64(&path_bytes(&root.join("nope.txt")))}),
    );
    assert_eq!(reply.code("read missing"), ErrorCode::NotFound);
}

// ---------------------------------------------------------------------------
// fs.list
// ---------------------------------------------------------------------------

/// Names a shell would happily execute or re-split if anything ever inserted
/// them into a script text, plus a leading dash and a leading dot-dot. All are
/// legal on every Unix filesystem.
const HOSTILE_NAMES: [&str; 11] = [
    "sp ace.txt",
    "quote'.txt",
    "dquote\".txt",
    "dollar$(id).txt",
    "tick`.txt",
    "star*.txt",
    "new\nline.txt",
    "back\\slash.txt",
    "tab\tchar.txt",
    "-leading-dash.txt",
    "..almost.txt",
];

/// Create one file per hostile name, each holding its own name as content, and
/// return the names in raw bytes.
fn build_hostile_tree(dir: &Path) -> Vec<Vec<u8>> {
    let mut names = Vec::new();
    for name in HOSTILE_NAMES {
        let bytes = name.as_bytes().to_vec();
        std::fs::write(dir.join(bytes_path(&bytes)), &bytes).expect("write hostile");
        names.push(bytes);
    }
    names
}

#[test]
fn fs_list_reports_kinds_sizes_and_hostile_names_exactly() {
    let tmp = Temp::new("list");
    let root = tmp.path();
    let dir = root.join("tree");
    std::fs::create_dir_all(dir.join("subdir")).expect("mkdir");
    std::fs::write(dir.join("a.txt"), b"aaaa").expect("write");
    std::fs::write(dir.join(".hidden"), b"h").expect("write");
    std::os::unix::fs::symlink("a.txt", dir.join("link")).expect("symlink");
    std::os::unix::fs::symlink("nowhere", dir.join("dangling")).expect("symlink");
    let hostile = build_hostile_tree(&dir);

    let mut fb = Fallback::start(root);
    let data = fb
        .call(1, "fs.list", json!({"path_b64": b64(&path_bytes(&dir))}))
        .data("fs.list")
        .clone();

    assert_eq!(bytes_of(&data, "path_b64"), path_bytes(&dir));
    assert_eq!(bytes_of(&data, "parent_b64"), path_bytes(root));
    assert_eq!(data["truncated"], json!(false));

    let entries = data["entries"].as_array().expect("entries is an array");
    // 5 fixture entries + 11 hostile ones: nothing is dropped.
    assert_eq!(entries.len(), 5 + hostile.len());
    let mut by_name: BTreeMap<Vec<u8>, &Value> = BTreeMap::new();
    for entry in entries {
        let name = bytes_of(entry, "name_b64");
        assert!(
            by_name.insert(name.clone(), entry).is_none(),
            "duplicate name {name:?}"
        );
    }

    // Every hostile name comes back byte-for-byte, with the size of the file
    // that holds it.
    for name in &hostile {
        let entry = by_name
            .get(name)
            .unwrap_or_else(|| panic!("missing entry for {name:?}"));
        assert_eq!(entry["kind"], json!("file"), "{name:?}");
        assert_eq!(entry["is_symlink"], json!(false), "{name:?}");
        assert_eq!(entry["size"], json!(name.len()), "{name:?}");
    }

    // Kinds and sizes, exactly as the helper reports them.
    let entry = by_name.get(b"a.txt".as_slice()).expect("a.txt");
    assert_eq!(entry["kind"], json!("file"));
    assert_eq!(entry["size"], json!(4));
    assert_eq!(entry["mtime"], json!(mtime_of(&dir.join("a.txt"))));
    assert_eq!(entry["is_symlink"], json!(false));

    let entry = by_name.get(b"subdir".as_slice()).expect("subdir");
    assert_eq!(entry["kind"], json!("dir"));
    // Size is reported for regular files only.
    assert_eq!(entry["size"], json!(0));

    let entry = by_name.get(b"link".as_slice()).expect("link");
    assert_eq!(entry["kind"], json!("symlink"));
    assert_eq!(entry["is_symlink"], json!(true));
    assert_eq!(entry["size"], json!(0));

    let entry = by_name.get(b"dangling".as_slice()).expect("dangling");
    assert_eq!(entry["kind"], json!("symlink"));
    assert_eq!(entry["is_symlink"], json!(true));

    let entry = by_name.get(b".hidden".as_slice()).expect(".hidden");
    assert_eq!(entry["size"], json!(1));

    // The listing is sorted by the raw name bytes, as the helper sorts it.
    let names: Vec<Vec<u8>> = entries.iter().map(|e| bytes_of(e, "name_b64")).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "entries are not in raw byte order");

    // `.` and `..` are never entries.
    assert!(!by_name.contains_key(b".".as_slice()));
    assert!(!by_name.contains_key(b"..".as_slice()));
}

#[test]
fn fs_list_follows_a_symlinked_directory_and_refuses_a_file() {
    let tmp = Temp::new("listlink");
    let root = tmp.path();
    std::fs::create_dir_all(root.join("real/inner")).expect("mkdir");
    std::fs::write(root.join("real/inner/deep.txt"), b"deep\n").expect("write");
    std::os::unix::fs::symlink("real", root.join("dirlink")).expect("symlink");
    std::os::unix::fs::symlink("real/inner/deep.txt", root.join("filelink")).expect("symlink");
    std::fs::write(root.join("plain.txt"), b"x").expect("write");

    let mut fb = Fallback::start(root);

    // A symlinked directory lists like the directory it points at.
    let link = root.join("dirlink");
    let data = fb
        .call(1, "fs.list", json!({"path_b64": b64(&path_bytes(&link))}))
        .data("fs.list dirlink")
        .clone();
    assert_eq!(bytes_of(&data, "path_b64"), path_bytes(&link));
    let names: Vec<Vec<u8>> = data["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|e| bytes_of(e, "name_b64"))
        .collect();
    assert_eq!(names, vec![b"inner".to_vec()]);

    // A symlink to a *file* is not a directory.
    let reply = fb.call(
        2,
        "fs.list",
        json!({"path_b64": b64(&path_bytes(&root.join("filelink")))}),
    );
    assert_eq!(reply.code("fs.list filelink"), ErrorCode::NotADir);

    // Nor is a plain file, and the message names it.
    let reply = fb.call(
        3,
        "fs.list",
        json!({"path_b64": b64(&path_bytes(&root.join("plain.txt")))}),
    );
    assert_eq!(reply.code("fs.list file"), ErrorCode::NotADir);
    assert!(reply.message("fs.list file").contains("plain.txt"));

    // A missing path is not_found.
    let reply = fb.call(
        4,
        "fs.list",
        json!({"path_b64": b64(&path_bytes(&root.join("nope")))}),
    );
    assert_eq!(reply.code("fs.list missing"), ErrorCode::NotFound);

    // A directory that cannot be read is unreadable. Skipped as root, where the
    // mode bits stop nothing.
    use std::os::unix::fs::PermissionsExt;
    let secret = root.join("secret");
    std::fs::create_dir(&secret).expect("mkdir");
    std::fs::write(secret.join("s.txt"), b"s").expect("write");
    let mut perms = std::fs::metadata(&secret).expect("meta").permissions();
    perms.set_mode(0o000);
    std::fs::set_permissions(&secret, perms).expect("chmod");
    if !is_root() {
        let reply = fb.call(5, "fs.list", json!({"path_b64": b64(&path_bytes(&secret))}));
        assert_eq!(reply.code("fs.list secret"), ErrorCode::Unreadable);
    }
    let mut perms = std::fs::metadata(&secret).expect("meta").permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&secret, perms).expect("chmod back");
}

#[test]
fn fs_list_truncates_at_the_entry_cap() {
    let tmp = Temp::new("trunc");
    let root = tmp.path();
    let dir = root.join("many");
    std::fs::create_dir(&dir).expect("mkdir");
    // One past the helper's cap, so the flag must be set.
    for i in 0..=faragent_helper::proto::MAX_LIST_ENTRIES {
        std::fs::write(dir.join(format!("f{i:04}")), b"").expect("write");
    }

    let mut fb = Fallback::start(root);
    let data = fb
        .call(1, "fs.list", json!({"path_b64": b64(&path_bytes(&dir))}))
        .data("fs.list truncated")
        .clone();
    assert_eq!(data["truncated"], json!(true));
    let entries = data["entries"].as_array().expect("entries");
    assert_eq!(
        entries.len(),
        faragent_helper::proto::MAX_LIST_ENTRIES,
        "the cap is the helper's MAX_LIST_ENTRIES"
    );
}

// ---------------------------------------------------------------------------
// Hostile bytes, end to end
// ---------------------------------------------------------------------------

#[test]
fn hostile_paths_round_trip_through_read_and_stat() {
    let tmp = Temp::new("hostile");
    let root = tmp.path();
    let dir = root.join("tree");
    std::fs::create_dir(&dir).expect("mkdir");
    let mut names = build_hostile_tree(&dir);

    // A name that is not UTF-8 at all, where the filesystem accepts one. On a
    // filesystem that refuses it the round trip is not covered, and this says
    // so rather than pretending otherwise.
    let non_utf8 = b"caf\xe9.txt".to_vec();
    match std::fs::write(dir.join(bytes_path(&non_utf8)), &non_utf8) {
        Ok(()) => {
            eprintln!("note: the filesystem accepted a non-UTF-8 name; it IS round-tripped below");
            names.push(non_utf8);
        }
        Err(e) => {
            eprintln!("note: the filesystem refused a non-UTF-8 name ({e}); it is NOT covered")
        }
    }

    let mut fb = Fallback::start(root);
    let mut id = 1;
    for name in &names {
        let path = dir.join(bytes_path(name));
        let param = json!({"path_b64": b64(&path_bytes(&path))});

        let data = fb
            .call(id, "fs.read", param.clone())
            .data("read hostile")
            .clone();
        assert_eq!(bytes_of(&data, "data_b64"), *name, "read {name:?}");
        id += 1;

        let data = fb.call(id, "fs.stat", param).data("stat hostile").clone();
        assert_eq!(
            bytes_of(&data, "path_b64"),
            path_bytes(&path),
            "stat {name:?}"
        );
        assert_eq!(data["size"], json!(name.len()), "stat {name:?}");
        id += 1;
    }

    // Nothing in a name was ever evaluated by the shell: `$(id)` produced no
    // id, the backticks ran nothing, and no `*` expanded to another file.
    let reply = fb.call(
        id,
        "fs.stat",
        json!({"path_b64": b64(b"$(touch /tmp/faragent-fallback-should-not-exist)")}),
    );
    assert_eq!(
        reply.code("stat a command substitution"),
        ErrorCode::NotFound
    );
    assert!(
        !Path::new("/tmp/faragent-fallback-should-not-exist").exists(),
        "the shell evaluated a path"
    );

    // Bytes no filesystem here will hold as a *name* — this one (APFS) refuses
    // invalid UTF-8 outright — can still cross the wire, and the script must
    // carry them into a frame byte-exact. The echo of such a path in an error's
    // `message_b64` is where that shows: the failure quotes the path it was
    // given, and the quote comes back with every byte intact.
    let odd = b"no/such/\xff\xfe\x80".to_vec();
    let reply = fb.call(id + 1, "fs.stat", json!({"path_b64": b64(&odd)}));
    assert_eq!(reply.code("stat a non-UTF-8 path"), ErrorCode::NotFound);
    let frame = fb.seen.last().expect("the reply frame");
    let expected = [b"no such path: ".as_slice(), odd.as_slice()].concat();
    assert_eq!(
        raw_message_of(frame),
        expected,
        "the path was not carried byte-exact: {frame}"
    );
}

/// The `message_b64` of a reply frame, decoded — byte-exact, unlike
/// `parse_line`'s lossy `message`.
fn raw_message_of(frame: &str) -> Vec<u8> {
    let value: Value = serde_json::from_str(frame).expect("a frame is JSON");
    let text = value["error"]["message_b64"]
        .as_str()
        .expect("an error frame carries message_b64");
    b64_decode(text).expect("message_b64 is base64")
}

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

#[test]
fn bad_requests_use_the_closed_error_set_and_the_scripts_own_words() {
    let tmp = Temp::new("bad");
    let root = tmp.path();
    std::fs::write(root.join("f.txt"), b"x").expect("write");
    let good = b64(&path_bytes(&root.join("f.txt")));

    let mut fb = Fallback::start(root);
    let mut seen = Vec::new();

    // A missing required field: the code the helper uses, and the helper's own
    // wording for it.
    let reply = fb.call(1, "fs.stat", json!(null));
    assert_eq!(reply.message("no path_b64"), "`path_b64` is required");
    record(&mut seen, reply, "no path_b64");

    // A `*_b64` value outside the base64 alphabet is treated as absent …
    let reply = fb.call(2, "fs.stat", json!({"path_b64": "!!nope!!"}));
    assert_eq!(reply.message("garbage path_b64"), "`path_b64` is required");
    record(&mut seen, reply, "garbage path_b64");

    // … and one inside the alphabet but with a non-canonical length is refused
    // by name, the way the helper's `b64_decode` refuses it.
    let reply = fb.call(3, "fs.stat", json!({"path_b64": "AAAAA"}));
    assert!(reply.message("bad padding").contains("not valid base64"));
    record(&mut seen, reply, "bad padding");

    // A `*_b64` field of the wrong JSON type.
    record(
        &mut seen,
        fb.call(4, "fs.stat", json!({"path_b64": 7})),
        "non-string path_b64",
    );

    // An optional u64 that is a float, a negative, or a string.
    for (id, limit) in [(5, json!(1.5)), (6, json!(-1)), (7, json!("5"))] {
        let reply = fb.call(id, "fs.read", json!({"path_b64": good, "limit": limit}));
        assert_eq!(
            reply.message("bad limit"),
            "`limit` must be a non-negative integer"
        );
        record(&mut seen, reply, "bad limit");
    }
    let reply = fb.call(
        8,
        "fs.read",
        json!({"path_b64": good, "offset": json!(1.5)}),
    );
    assert_eq!(
        reply.message("bad offset"),
        "`offset` must be a non-negative integer"
    );
    record(&mut seen, reply, "bad offset");

    // A frame with no `op`.
    fb.write_line("{\"id\":9}");
    let reply = fb.next_reply();
    assert_eq!(reply.id, json!(9));
    record(&mut seen, reply, "no op");

    // A frame whose `op` is unknown, and one that would be a write.
    for (id, op) in [(10, "fs.write"), (11, "fs.rename")] {
        let reply = fb.call(id, op, json!({"path_b64": good}));
        assert!(reply.message("unknown op").contains(op));
        record(&mut seen, reply, "unknown op");
    }

    // Nothing outside the closed set came back: 8 single requests, a frame with
    // no `op`, and one bad request per unknown op.
    assert_eq!(seen.len(), 8 + 1 + 2, "{seen:?}");
}

#[test]
fn every_reachable_error_code_is_in_the_closed_set() {
    let tmp = Temp::new("codes");
    let root = tmp.path();
    std::fs::create_dir(root.join("dir")).expect("mkdir");
    std::fs::write(root.join("bin.dat"), b"\x00\x01").expect("write");
    std::fs::write(root.join("text.txt"), b"t").expect("write");
    let f = std::fs::File::create(root.join("huge.dat")).expect("create");
    f.set_len(300_000_000).expect("set_len");
    drop(f);
    let plain = root.join("plain");
    std::fs::create_dir(&plain).expect("mkdir");

    let mut fb = Fallback::start(root);
    let mut seen = Vec::new();

    record(&mut seen, fb.call(1, "fs.stat", json!(null)), "bad_request");
    record(
        &mut seen,
        fb.call(
            2,
            "fs.stat",
            json!({"path_b64": b64(&path_bytes(&root.join("nope")))}),
        ),
        "not_found",
    );
    record(
        &mut seen,
        fb.call(
            3,
            "fs.list",
            json!({"path_b64": b64(&path_bytes(&root.join("text.txt")))}),
        ),
        "not_a_dir",
    );
    record(
        &mut seen,
        fb.call(
            4,
            "fs.read",
            json!({"path_b64": b64(&path_bytes(&root.join("dir")))}),
        ),
        "unreadable",
    );
    record(
        &mut seen,
        fb.call(
            5,
            "fs.read",
            json!({"path_b64": b64(&path_bytes(&root.join("huge.dat")))}),
        ),
        "too_large",
    );
    record(
        &mut seen,
        fb.call(
            6,
            "fs.read",
            json!({"path_b64": b64(&path_bytes(&root.join("bin.dat")))}),
        ),
        "binary",
    );
    record(
        &mut seen,
        fb.call(
            7,
            "git.status",
            json!({"root_b64": b64(&path_bytes(&plain))}),
        ),
        "not_a_repo",
    );

    // `git_failed` and `internal` have their own tests; these seven are the
    // ones reachable from a single well-formed fixture.
    assert_eq!(
        seen,
        vec![
            ErrorCode::BadRequest,
            ErrorCode::NotFound,
            ErrorCode::NotADir,
            ErrorCode::Unreadable,
            ErrorCode::TooLarge,
            ErrorCode::Binary,
            ErrorCode::NotARepo,
        ]
    );
}

#[test]
fn malformed_input_is_answered_and_never_desynchronises_the_channel() {
    let tmp = Temp::new("desync");
    let root = tmp.path();
    std::fs::write(root.join("f.txt"), b"payload").expect("write");
    let f_b64 = b64(&path_bytes(&root.join("f.txt")));

    let mut fb = Fallback::start(root);

    // Not JSON at all.
    fb.write_line("this is not a frame");
    let reply = fb.next_reply();
    assert_eq!(reply.id, Value::Null);
    assert_eq!(reply.code("garbage line"), ErrorCode::BadRequest);

    // A blank line: the helper answers it too, so the fallback must not be
    // silent — a client counting replies would wait forever.
    fb.write_line("");
    let reply = fb.next_reply();
    assert_eq!(reply.id, Value::Null);
    assert_eq!(reply.code("blank line"), ErrorCode::BadRequest);

    // JSON, but not an object.
    fb.write_line("[1,2,3]");
    assert_eq!(fb.next_reply().code("array line"), ErrorCode::BadRequest);

    // A frame past the 8 MiB cap, refused by the reader before anything scans
    // it. The helper's answer has the same shape and the same null id.
    let mut huge = String::with_capacity(faragent_helper::proto::MAX_FRAME_BYTES + 64);
    huge.push_str("{\"id\":99,\"op\":\"fs.stat\",\"path_b64\":\"");
    huge.push_str(&"A".repeat(faragent_helper::proto::MAX_FRAME_BYTES));
    huge.push_str("\"}");
    fb.write_line(&huge);
    let reply = fb.next_reply();
    assert_eq!(
        reply.id,
        Value::Null,
        "the oversized reply carries a null id"
    );
    assert_eq!(reply.code("oversized frame"), ErrorCode::BadRequest);
    assert!(reply.message("oversized frame").contains("8388608"));

    // A JSON string where the request should be an object.
    fb.write_line("\"id\":42");
    assert_eq!(fb.next_reply().code("stray string"), ErrorCode::BadRequest);

    // After all that the channel is still in step: two well-formed requests are
    // answered, in order, each with its own id.
    let reply = fb.call(7, "fs.read", json!({"path_b64": f_b64.clone()}));
    assert_eq!(
        bytes_of(reply.data("read after garbage"), "data_b64"),
        b"payload"
    );
    let reply = fb.call(8, "fs.stat", json!({"path_b64": f_b64}));
    assert_eq!(reply.data("stat after garbage")["size"], json!(7));

    // And it shuts down cleanly on EOF.
    assert!(fb.close_and_wait().success());
}

#[test]
fn a_host_without_base64_reports_internal_rather_than_lying() {
    let tmp = Temp::new("nobase64");
    let Some(bin) = path_without_base64(tmp.path()) else {
        panic!("could not build a PATH without `base64`");
    };
    // No login shell (so no profile can put `base64` back on `PATH`) and a
    // `PATH` of symlinks to everything but `base64`: `b64` cannot encode a
    // frame, and the script says so instead of emitting a frame it cannot
    // spell. The reply still carries the request's own id — a client waiting
    // for id 1 is answered, not left hanging on a null id.
    let mut fb = Fallback::start_with(tmp.path(), bin.to_str(), false);
    fb.write_line("{\"id\":1,\"op\":\"ping\"}");
    let reply = fb.next_reply();
    assert_eq!(reply.id, json!(1));
    assert_eq!(reply.code("no base64"), ErrorCode::Internal);
    // The message is empty: there is no `base64` with which to encode it. The
    // frame is still a frame, which is the property that matters.
    assert_eq!(reply.message("no base64"), "");
    // Any later request gets the same answer, rather than the channel falling
    // quiet or the script dying.
    fb.write_line("{\"id\":2,\"op\":\"fs.stat\"}");
    let reply = fb.next_reply();
    assert_eq!(reply.id, json!(2));
    assert_eq!(reply.code("no base64, again"), ErrorCode::Internal);
    assert!(fb.close_and_wait().success());
}

// ---------------------------------------------------------------------------
// git.*
// ---------------------------------------------------------------------------

/// A repository with three commits, an upstream the branch is ahead of and
/// behind, and one file in every state `status --porcelain=v2` reports.
fn git_fixture(tag: &str) -> (Temp, Repo) {
    let tmp = Temp::new(tag);
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).expect("mkdir");
    let repo = Repo::init(&root, tmp.path());
    repo.commit_file("one.txt", "one\n");
    repo.commit_file("two.txt", "two\n");
    repo.commit_file("sub/deep.txt", "deep\n");

    // An upstream one commit ahead of the local branch: `behind` is 1.
    let origin = tmp.path().join("origin.git");
    let out = Command::new("git")
        .args(["init", "-q", "--bare", "-b", "main"])
        .arg(&origin)
        .env("HOME", tmp.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git init --bare");
    assert!(out.status.success(), "bare init failed");
    repo.git(&[
        "remote",
        "add",
        "origin",
        origin.to_str().expect("utf8 path"),
    ]);
    repo.git(&["push", "-q", "-u", "origin", "main"]);
    repo.git(&["commit", "-q", "--allow-empty", "-m", "upstream only"]);
    repo.git(&["push", "-q"]);
    // Back to the pushed tip's parent, so the local branch is behind by one and
    // the worktree states below are added on top of a known commit.
    repo.git(&["reset", "-q", "--hard", "HEAD~1"]);

    // One file in each state, plus a pure rename with hostile bytes on both
    // sides (a pure rename is what makes git report `R100` and the old path).
    repo.commit_file("old name.txt", "rename me\n");
    repo.git(&["mv", "old name.txt", "new'name'$.txt"]);
    std::fs::write(root.join("one.txt"), "changed\n").expect("write");
    std::fs::write(root.join("staged.txt"), "staged\n").expect("write");
    repo.git(&["add", "staged.txt"]);
    std::fs::write(root.join("gone.txt"), "gone\n").expect("write");
    repo.git(&["add", "gone.txt"]);
    std::fs::remove_file(root.join("gone.txt")).expect("remove");
    std::fs::write(root.join("untracked.txt"), "").expect("write");
    std::fs::write(root.join("a b'c$(x)`y`.txt"), "x").expect("write");
    repo.git(&["add", "a b'c$(x)`y`.txt"]);
    (tmp, repo)
}

fn skip_without_git() -> bool {
    if have_git() {
        return false;
    }
    eprintln!("note: no `git` on PATH; the git.* fallback tests did NOT run");
    true
}

#[test]
fn git_discover_walks_up_to_the_worktree_root() {
    if skip_without_git() {
        return;
    }
    let (tmp, repo) = git_fixture("discover");
    let mut fb = Fallback::start(tmp.path());

    // From the root: root, git dir and name all come back.
    let data = fb
        .call(
            1,
            "git.discover",
            json!({"root_b64": b64(&path_bytes(&repo.root))}),
        )
        .data("discover at root")
        .clone();
    assert_eq!(bytes_of(&data, "path_b64"), path_bytes(&repo.root));
    assert_eq!(bytes_of(&data, "root_b64"), path_bytes(&repo.root));
    assert_eq!(
        bytes_of(&data, "git_dir_b64"),
        path_bytes(&repo.root.join(".git"))
    );
    assert_eq!(text_of(&data, "name_b64"), "repo");

    // From a subdirectory: the same repository, and `path` is what was asked.
    let sub = repo.root.join("sub");
    let data = fb
        .call(
            2,
            "git.discover",
            json!({"root_b64": b64(&path_bytes(&sub))}),
        )
        .data("discover from subdir")
        .clone();
    assert_eq!(bytes_of(&data, "path_b64"), path_bytes(&sub));
    assert_eq!(bytes_of(&data, "root_b64"), path_bytes(&repo.root));
    assert_eq!(text_of(&data, "name_b64"), "repo");

    // A trailing slash is not part of the repository's name.
    let slashed = format!("{}/", repo.root.display());
    let data = fb
        .call(
            3,
            "git.discover",
            json!({"root_b64": b64(slashed.as_bytes())}),
        )
        .data("discover with trailing slash")
        .clone();
    assert_eq!(text_of(&data, "name_b64"), "repo");

    // Outside any repository: not_a_repo, and the message names the directory.
    let plain = tmp.path().join("plain");
    std::fs::create_dir_all(&plain).expect("mkdir");
    let reply = fb.call(
        4,
        "git.discover",
        json!({"root_b64": b64(&path_bytes(&plain))}),
    );
    assert_eq!(reply.code("discover outside"), ErrorCode::NotARepo);
    assert!(reply.message("discover outside").contains("plain"));
}

#[test]
fn git_status_reports_branch_counts_and_every_file_state() {
    if skip_without_git() {
        return;
    }
    let (tmp, repo) = git_fixture("status");
    let head = repo.stdout(&["rev-parse", "HEAD"]);
    let mut fb = Fallback::start(tmp.path());

    let data = fb
        .call(
            1,
            "git.status",
            json!({"root_b64": b64(&path_bytes(&repo.root))}),
        )
        .data("git.status")
        .clone();

    assert_eq!(bytes_of(&data, "path_b64"), path_bytes(&repo.root));
    assert_eq!(bytes_of(&data, "root_b64"), path_bytes(&repo.root));
    assert_eq!(text_of(&data, "branch_b64"), "main");
    // The oid travels plain (it is hex), not base64.
    assert_eq!(plain(&data, "oid"), head);
    assert_eq!(data["detached"], json!(false));
    assert_eq!(data["initial"], json!(false));
    assert_eq!(text_of(&data, "upstream_b64"), "origin/main");
    assert_eq!(data["ahead"], json!(1));
    assert_eq!(data["behind"], json!(1));
    assert_eq!(data["clean"], json!(false));
    assert_eq!(data["truncated"], json!(false));

    // Every file state, named exactly as the helper names it.
    let mut states: BTreeMap<Vec<u8>, (String, bool, Vec<u8>)> = BTreeMap::new();
    for entry in data["files"].as_array().expect("files is an array") {
        let path = bytes_of(entry, "path_b64");
        let orig = match entry.get("orig_path_b64") {
            None | Some(Value::Null) => Vec::new(),
            Some(_) => bytes_of(entry, "orig_path_b64"),
        };
        let status = plain(entry, "status").to_string();
        let staged = entry["staged"].as_bool().expect("staged bool");
        states.insert(path, (status, staged, orig));
    }
    let expect = |name: &str, status: &str, staged: bool| {
        let got = states
            .get(name.as_bytes())
            .unwrap_or_else(|| panic!("no entry for {name:?}: {states:?}"));
        assert_eq!(got.0, status, "{name:?}");
        assert_eq!(got.1, staged, "{name:?}");
    };
    expect("one.txt", "modified", false);
    expect("staged.txt", "added", true);
    expect("gone.txt", "added", true);
    expect("untracked.txt", "untracked", false);
    expect("a b'c$(x)`y`.txt", "added", true);

    // The rename: the new path is the entry, the old path is `orig_path_b64`,
    // and both are byte-exact — including the space and the quote.
    let got = states
        .get(b"new'name'$.txt".as_slice())
        .expect("the renamed file is an entry");
    assert_eq!(got.0, "renamed");
    assert!(got.1, "a rename is a staged change");
    assert_eq!(got.2, b"old name.txt".to_vec());

    // The same answer from a subdirectory of the worktree.
    let sub = repo.root.join("sub");
    let data = fb
        .call(2, "git.status", json!({"root_b64": b64(&path_bytes(&sub))}))
        .data("git.status from subdir")
        .clone();
    assert_eq!(bytes_of(&data, "root_b64"), path_bytes(&repo.root));
    assert_eq!(data["files"].as_array().expect("files").len(), states.len());

    // A clean repository: no files, and no upstream to count against.
    let clean = tmp.path().join("clean");
    std::fs::create_dir_all(&clean).expect("mkdir");
    let clean_repo = Repo::init(&clean, tmp.path());
    clean_repo.commit_file("a.txt", "a\n");
    let data = fb
        .call(
            3,
            "git.status",
            json!({"root_b64": b64(&path_bytes(&clean))}),
        )
        .data("git.status clean")
        .clone();
    assert_eq!(data["clean"], json!(true));
    assert_eq!(data["files"], json!([]));
    assert_eq!(data["upstream_b64"], Value::Null);
    assert_eq!(data["ahead"], Value::Null);
    assert_eq!(data["behind"], Value::Null);

    // A repository with no commits: `initial` and a null oid.
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).expect("mkdir");
    Repo::init(&empty, tmp.path());
    let data = fb
        .call(
            4,
            "git.status",
            json!({"root_b64": b64(&path_bytes(&empty))}),
        )
        .data("git.status initial")
        .clone();
    assert_eq!(data["initial"], json!(true));
    assert_eq!(data["oid"], Value::Null);
    assert_eq!(text_of(&data, "branch_b64"), "main");
    assert_eq!(data["clean"], json!(true));

    // A bundle of directories that is not in any repository, named in the
    // message. (A path *inside* a repository answers with that repository —
    // including a path that does not exist, which is how the helper's walk
    // behaves too; the next case pins that down.)
    let outside = tmp.path().join("outside/deeper");
    let reply = fb.call(
        5,
        "git.status",
        json!({"root_b64": b64(&path_bytes(&outside))}),
    );
    assert_eq!(reply.code("status outside"), ErrorCode::NotARepo);
    assert!(reply.message("status outside").contains("outside/deeper"));

    // A path that does not exist but *is* inside the worktree resolves to the
    // worktree, the way walking up from it does.
    let inside = clean.join("does/not/exist");
    let data = fb
        .call(
            6,
            "git.status",
            json!({"root_b64": b64(&path_bytes(&inside))}),
        )
        .data("git.status at a missing path inside a repo")
        .clone();
    assert_eq!(bytes_of(&data, "root_b64"), path_bytes(&clean));
}

#[test]
fn git_status_reports_a_conflicted_merge() {
    if skip_without_git() {
        return;
    }
    let tmp = Temp::new("conflict");
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).expect("mkdir");
    let repo = Repo::init(&root, tmp.path());
    repo.commit_file("c.txt", "base\n");
    repo.git(&["checkout", "-q", "-b", "other"]);
    std::fs::write(root.join("c.txt"), "other\n").expect("write");
    repo.git(&["commit", "-q", "-am", "other side"]);
    repo.git(&["checkout", "-q", "main"]);
    std::fs::write(root.join("c.txt"), "main\n").expect("write");
    repo.git(&["commit", "-q", "-am", "main side"]);
    // The conflict is the fixture: git must fail here, and leave stages behind.
    let out = repo.git_out(&["merge", "other"]);
    assert!(!out.status.success(), "the merge was expected to conflict");

    let mut fb = Fallback::start(tmp.path());
    let data = fb
        .call(
            1,
            "git.status",
            json!({"root_b64": b64(&path_bytes(&root))}),
        )
        .data("git.status during a conflict")
        .clone();
    let entry = data["files"]
        .as_array()
        .expect("files")
        .iter()
        .find(|e| bytes_of(e, "path_b64") == b"c.txt")
        .expect("the conflicted file is an entry");
    // The unmerged record is an 11-field `u` line, not the 9-field `1` line: a
    // parser that confuses the two would report a path of `<h2> <h3> c.txt`.
    assert_eq!(plain(entry, "status"), "conflicted");
    assert_eq!(plain(entry, "index"), "U");
    assert_eq!(plain(entry, "worktree"), "U");
    assert_eq!(entry["staged"], json!(true));
}

#[test]
fn git_status_truncates_at_the_entry_cap() {
    if skip_without_git() {
        return;
    }
    let tmp = Temp::new("statustrunc");
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).expect("mkdir");
    let repo = Repo::init(&root, tmp.path());
    repo.commit_file("keep.txt", "k\n");
    for i in 0..=faragent_helper::proto::MAX_LIST_ENTRIES {
        std::fs::write(root.join(format!("u{i:04}.txt")), b"").expect("write");
    }

    let mut fb = Fallback::start(tmp.path());
    let data = fb
        .call(
            1,
            "git.status",
            json!({"root_b64": b64(&path_bytes(&root))}),
        )
        .data("git.status truncated")
        .clone();
    assert_eq!(data["truncated"], json!(true));
    assert_eq!(
        data["files"].as_array().expect("files").len(),
        faragent_helper::proto::MAX_LIST_ENTRIES
    );
    // A truncated listing is not a clean repository.
    assert_eq!(data["clean"], json!(false));
}

#[test]
fn git_log_is_newest_first_and_honours_limit_skip_and_path() {
    if skip_without_git() {
        return;
    }
    let (tmp, repo) = git_fixture("log");
    let head = repo.stdout(&["rev-parse", "HEAD"]);
    let head_short = repo.stdout(&["rev-parse", "--short", "HEAD"]);
    let total: usize = repo
        .stdout(&["rev-list", "--count", "HEAD"])
        .parse()
        .expect("commit count");
    let mut fb = Fallback::start(tmp.path());

    let data = fb
        .call(
            1,
            "git.log",
            json!({"root_b64": b64(&path_bytes(&repo.root))}),
        )
        .data("git.log")
        .clone();
    assert_eq!(bytes_of(&data, "root_b64"), path_bytes(&repo.root));
    assert_eq!(data["limit"], json!(50));
    assert_eq!(data["skip"], json!(0));
    assert_eq!(data["truncated"], json!(false));
    let commits = data["commits"].as_array().expect("commits");
    assert_eq!(commits.len(), total);

    let first = &commits[0];
    assert_eq!(plain(first, "hash"), head);
    assert_eq!(plain(first, "short"), head_short);
    // The fixture's identity is hostile on purpose; it travels base64, so it
    // stays byte-exact on the wire.
    assert_eq!(text_of(first, "author_b64"), "A\"b\\c$(x)`y`");
    assert_eq!(text_of(first, "email_b64"), "a\"b\\c@example.com");
    assert_eq!(text_of(first, "refs_b64"), "HEAD -> main");
    // The tip is the rename source's commit, not the upstream-only one: that
    // commit is on `origin/main` and the fixture reset past it.
    assert_eq!(text_of(first, "subject_b64"), "add old name.txt");
    assert_eq!(first["parents"].as_array().expect("parents").len(), 1);
    // Dates travel plain, as ISO 8601 — the shape `is_date` admits.
    assert_eq!(
        plain(first, "author_date"),
        repo.stdout(&["log", "-1", "--format=%aI", head.as_str()])
    );
    assert_eq!(
        plain(first, "commit_date"),
        repo.stdout(&["log", "-1", "--format=%cI", head.as_str()])
    );
    // Newest first: the second entry is the tip's parent.
    assert_eq!(
        plain(&commits[1], "hash"),
        repo.stdout(&["rev-parse", "HEAD~1"])
    );
    // A root commit has no parents, and `refs_b64` is null when no ref points
    // at it.
    let last = &commits[commits.len() - 1];
    assert_eq!(last["parents"], json!([]));
    assert_eq!(last["refs_b64"], Value::Null);

    // `limit` truncates, and says so.
    let data = fb
        .call(
            2,
            "git.log",
            json!({"root_b64": b64(&path_bytes(&repo.root)), "limit": 2}),
        )
        .data("git.log limit=2")
        .clone();
    assert_eq!(data["limit"], json!(2));
    assert_eq!(data["commits"].as_array().expect("commits").len(), 2);
    assert_eq!(data["truncated"], json!(true));

    // `skip` pages, and the last page is not truncated.
    let data = fb
        .call(
            3,
            "git.log",
            json!({"root_b64": b64(&path_bytes(&repo.root)), "limit": 2, "skip": total - 1}),
        )
        .data("git.log skip")
        .clone();
    assert_eq!(data["commits"].as_array().expect("commits").len(), 1);
    assert_eq!(data["truncated"], json!(false));

    // A `path_b64` filter is the helper's `-- <path>`.
    let only = repo.root.join("one.txt");
    let data = fb
        .call(
            4,
            "git.log",
            json!({
                "root_b64": b64(&path_bytes(&repo.root)),
                "path_b64": b64(&path_bytes(&only)),
            }),
        )
        .data("git.log path")
        .clone();
    let commits = data["commits"].as_array().expect("commits");
    assert_eq!(commits.len(), 1);
    assert_eq!(text_of(&commits[0], "subject_b64"), "add one.txt");

    // A `limit` with more digits than any u64 is clamped to the cap rather than
    // overflowing a shell integer. (The helper refuses such a number outright,
    // because serde_json cannot parse it — a documented divergence, benign
    // because no client sends one.)
    fb.write_line(&format!(
        "{{\"id\":5,\"op\":\"git.log\",\"root_b64\":\"{}\",\"limit\":9999999999999999999999999}}",
        b64(&path_bytes(&repo.root))
    ));
    let reply = fb.next_reply();
    assert_eq!(reply.id, json!(5));
    assert_eq!(reply.data("git.log huge limit")["limit"], json!(500));

    // A bad `skip` is a bad_request, like any other optional u64.
    let reply = fb.call(
        6,
        "git.log",
        json!({"root_b64": b64(&path_bytes(&repo.root)), "skip": json!(-1)}),
    );
    assert_eq!(reply.code("git.log bad skip"), ErrorCode::BadRequest);
    assert_eq!(
        reply.message("git.log bad skip"),
        "`skip` must be a non-negative integer"
    );
}

#[test]
fn git_log_tolerates_a_subject_containing_the_record_separator() {
    if skip_without_git() {
        return;
    }
    let tmp = Temp::new("logsep");
    let root = tmp.path().join("repo");
    std::fs::create_dir_all(&root).expect("mkdir");
    let repo = Repo::init(&root, tmp.path());
    repo.commit_file("a.txt", "a\n");
    // A raw 0x1e in a subject splits one commit into two records, the second of
    // which is not a commit at all. It must be skipped without counting toward
    // the page — otherwise every later commit shifts by one.
    repo.git(&["commit", "-q", "--allow-empty", "-m", "record\x1eseparator"]);
    repo.git(&["commit", "-q", "--allow-empty", "-m", "after"]);
    repo.git(&["commit", "-q", "--allow-empty", "-m", "last"]);

    let mut fb = Fallback::start(tmp.path());
    let data = fb
        .call(1, "git.log", json!({"root_b64": b64(&path_bytes(&root))}))
        .data("git.log with a separator in a subject")
        .clone();
    let commits = data["commits"].as_array().expect("commits");
    assert_eq!(commits.len(), 4, "one record was not a commit: {commits:?}");
    let subjects: Vec<String> = commits.iter().map(|c| text_of(c, "subject_b64")).collect();
    assert_eq!(subjects, vec!["last", "after", "record", "add a.txt"]);
}

#[test]
fn git_ops_report_git_failed_and_not_a_repo() {
    if skip_without_git() {
        return;
    }
    let tmp = Temp::new("gitfail");
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).expect("mkdir");
    Repo::init(&empty, tmp.path());
    let plain = tmp.path().join("plain/deeper");
    std::fs::create_dir_all(&plain).expect("mkdir");

    let mut fb = Fallback::start(tmp.path());

    // `git log` in a repository with no commits: git's own failure travels as
    // `git_failed`, carrying git's diagnostic.
    let reply = fb.call(1, "git.log", json!({"root_b64": b64(&path_bytes(&empty))}));
    assert_eq!(reply.code("log in an empty repo"), ErrorCode::GitFailed);
    let message = reply.message("log in an empty repo");
    assert!(message.contains("does not have any commits"), "{message:?}");

    // A missing `root_b64` is a bad_request, not a not_a_repo.
    let reply = fb.call(2, "git.status", json!(null));
    assert_eq!(reply.code("git.status without root"), ErrorCode::BadRequest);
    assert_eq!(
        reply.message("git.status without root"),
        "`root_b64` is required"
    );

    // A directory that is not in any repository.
    let reply = fb.call(3, "git.log", json!({"root_b64": b64(&path_bytes(&plain))}));
    assert_eq!(reply.code("log outside a repo"), ErrorCode::NotARepo);
    assert!(reply.message("log outside a repo").contains("deeper"));

    // A path that does not exist is still not_a_repo: discovery walks up from a
    // path that is not there, which is what the helper's walk does too.
    let reply = fb.call(
        4,
        "git.discover",
        json!({"root_b64": b64(&path_bytes(&tmp.path().join("no/such/dir")))}),
    );
    assert_eq!(reply.code("discover a missing path"), ErrorCode::NotARepo);
}

#[test]
fn git_discover_reads_a_linked_worktree_gitdir_file() {
    if skip_without_git() {
        return;
    }
    let (tmp, repo) = git_fixture("worktree");
    let linked = tmp.path().join("linked");
    repo.git(&[
        "worktree",
        "add",
        "-q",
        "--detach",
        linked.to_str().expect("utf8 path"),
    ]);
    // `.git` in a linked worktree is a *file* naming the real git dir.
    assert!(linked.join(".git").is_file(), "expected a .git file");

    let mut fb = Fallback::start(tmp.path());
    let data = fb
        .call(
            1,
            "git.discover",
            json!({"root_b64": b64(&path_bytes(&linked))}),
        )
        .data("discover a linked worktree")
        .clone();
    assert_eq!(bytes_of(&data, "root_b64"), path_bytes(&linked));
    let git_dir = bytes_of(&data, "git_dir_b64");
    let git_dir = Path::new(OsStr::from_bytes(&git_dir));
    assert!(
        git_dir.join("HEAD").is_file(),
        "the path read from the `gitdir:` line is not a git dir: {git_dir:?}"
    );

    let data = fb
        .call(
            2,
            "git.status",
            json!({"root_b64": b64(&path_bytes(&linked))}),
        )
        .data("status in a linked worktree")
        .clone();
    assert_eq!(bytes_of(&data, "root_b64"), path_bytes(&linked));
    assert_eq!(data["detached"], json!(true), "the fixture detached it");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// The mode the helper would report: the whole `st_mode`, file-type bits
/// included, of the *link* itself.
fn mode_of(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path)
        .expect("symlink_metadata")
        .mode() as u64
}

fn mtime_of(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path)
        .expect("symlink_metadata")
        .mtime() as u64
}

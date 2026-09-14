//! `git.discover`, `git.status`, `git.branches`, `git.diff`, `git.log`.
//!
//! Every op takes `root_b64` — the directory the caller is looking at, which
//! may be any directory *inside* the worktree — and walks up to find the
//! repository, so a workspace that is a subdirectory of a repo behaves the
//! same as the repo root. Replies echo both the requested path and the
//! repository root they resolved to.
//!
//! Output is always parsed from a porcelain/`--format` stream with `-z` or
//! `%x1f` field separators, never from the human format: those are stable
//! across git versions and locales, and `-z` additionally disables
//! `core.quotepath` quoting so a path comes back as the exact bytes on disk.

use crate::ops::fs::{path_bytes, path_from_bytes};
use crate::proto::{self, ErrorCode, ProtoError, Request, MAX_LIST_ENTRIES};
use serde_json::{json, Value};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Default `git.log` page size when the request does not say.
pub const DEFAULT_LOG_LIMIT: u64 = 50;

/// Largest patch `git.diff` will hold in memory. Any patch that would need
/// more is reported as a file list instead — the same thing an explicit
/// `files_only` asks for. Chosen so the base64 form still fits the frame cap.
pub const MAX_PATCH_BYTES: usize = 6 * 1024 * 1024;

fn b64_of(path: &Path) -> String {
    proto::b64_encode(&path_bytes(path))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Is this directory the root of a worktree? A `.git` **file** counts: that is
/// what a linked worktree or a submodule checkout has.
fn is_repo_dir(dir: &Path) -> bool {
    match std::fs::symlink_metadata(dir.join(".git")) {
        Ok(meta) => meta.is_dir() || meta.is_file(),
        Err(_) => false,
    }
}

/// Walk up from `start` to the directory that holds `.git`.
pub fn discover(start: &Path) -> Result<PathBuf, ProtoError> {
    let mut cur: PathBuf = start.to_path_buf();
    loop {
        if is_repo_dir(&cur) {
            return Ok(cur);
        }
        match cur.parent() {
            // `parent()` of a bare relative name is `""`; treat that as "not
            // found" rather than re-testing the empty path forever.
            Some(parent) if !parent.as_os_str().is_empty() => cur = parent.to_path_buf(),
            _ => {
                return Err(ProtoError::new(
                    ErrorCode::NotARepo,
                    format!("no `.git` in {} or any parent directory", start.display()),
                ))
            }
        }
    }
}

/// The real git directory of a worktree: `.git` itself, or — for a worktree or
/// submodule, where `.git` is a file — the path that file points at.
pub fn git_dir(repo: &Path) -> PathBuf {
    let dot = repo.join(".git");
    if dot.is_dir() {
        return dot;
    }
    if let Ok(text) = std::fs::read_to_string(&dot) {
        if let Some(rest) = text.lines().next().and_then(|l| l.strip_prefix("gitdir:")) {
            let target = Path::new(rest.trim());
            return if target.is_absolute() {
                target.to_path_buf()
            } else {
                repo.join(target)
            };
        }
    }
    dot
}

/// The repository a request names, or `not_a_repo`.
fn repo_of(req: &Request) -> Result<(PathBuf, PathBuf), ProtoError> {
    let asked = path_from_bytes(&req.required_bytes("root_b64")?);
    let repo = discover(&asked)?;
    Ok((asked, repo))
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

fn command(root: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    // Never take the index lock (the user's own git may be running), never
    // prompt for credentials, and pin the locale so porcelain and error text
    // are the same everywhere. `-z`/`--format` make the *parsing* locale-proof
    // already; this only keeps stderr stable for the diagnostics we forward.
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    cmd
}

fn spawn_error(root: &Path, e: std::io::Error) -> ProtoError {
    if e.kind() == ErrorKind::NotFound {
        ProtoError::internal("`git` was not found on PATH on the remote")
    } else {
        ProtoError::internal(format!("cannot run git in {}: {e}", root.display()))
    }
}

/// Newest `MAX_ERROR_BYTES` of a git failure, as the caller sees it.
const MAX_ERROR_BYTES: usize = 2048;

fn git_failed(status: &std::process::ExitStatus, stderr: &[u8]) -> ProtoError {
    let mut detail = text(stderr).trim().to_string();
    if detail.is_empty() {
        detail = format!("git exited with {status}");
    }
    if detail.len() > MAX_ERROR_BYTES {
        detail.truncate(MAX_ERROR_BYTES);
        detail.push('…');
    }
    ProtoError::new(ErrorCode::GitFailed, detail)
}

/// Run git and return its stdout whole. Used for the ops whose output is
/// inherently small (`status`, `branches`, `log`).
fn run_git(root: &Path, args: &[&str]) -> Result<Vec<u8>, ProtoError> {
    let out = command(root, args)
        .output()
        .map_err(|e| spawn_error(root, e))?;
    if !out.status.success() {
        return Err(git_failed(&out.status, &out.stderr));
    }
    Ok(out.stdout)
}

/// Run git and keep at most `limit` bytes of stdout. The boolean is true when
/// the output had to be cut short — in which case the child is killed rather
/// than allowed to pour a gigabyte into a pipe nobody is draining.
///
/// stderr is drained on its own thread: reading stdout to EOF while a chatty
/// child blocks on a full stderr pipe would deadlock.
fn run_git_limited(
    root: &Path,
    args: &[&str],
    limit: usize,
) -> Result<(Vec<u8>, bool), ProtoError> {
    let mut child: Child = command(root, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| spawn_error(root, e))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProtoError::internal("git stdout was not piped"))?;
    let stderr_pipe = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut sink = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        if sink.len() < MAX_ERROR_BYTES {
                            sink.extend_from_slice(&chunk[..n]);
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }
        sink
    });
    let mut buf = Vec::new();
    let mut over = false;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() + n > limit {
                    over = true;
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stderr_thread.join();
                return Err(ProtoError::internal(format!("cannot read git output: {e}")));
            }
        }
    }
    drop(stdout);
    let status = if over {
        let _ = child.kill();
        child.wait()
    } else {
        child.wait()
    }
    .map_err(|e| ProtoError::internal(format!("cannot wait for git: {e}")))?;
    let stderr = stderr_thread.join().unwrap_or_default();
    if !over && !status.success() {
        return Err(git_failed(&status, &stderr));
    }
    Ok((buf, over))
}

// ---------------------------------------------------------------------------
// git.discover
// ---------------------------------------------------------------------------

pub fn discover_op(req: &Request) -> Result<Value, ProtoError> {
    let (asked, repo) = repo_of(req)?;
    let name = repo
        .file_name()
        .map(|n| proto::b64_encode(&path_bytes(Path::new(n))))
        .unwrap_or_default();
    Ok(json!({
        "path_b64": b64_of(&asked),
        "root_b64": b64_of(&repo),
        "git_dir_b64": b64_of(&git_dir(&repo)),
        "name_b64": name,
    }))
}

// ---------------------------------------------------------------------------
// git.status
// ---------------------------------------------------------------------------

/// One letter of a porcelain v2 XY pair as the status the UI shows.
fn letter_status(letter: u8) -> &'static str {
    match letter {
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "copied",
        b'T' => "typechange",
        _ => "modified",
    }
}

/// A file record, keyed by the bytes git reported.
struct FileEntry {
    path: Vec<u8>,
    orig_path: Option<Vec<u8>>,
    index: String,
    worktree: String,
    staged: bool,
    status: &'static str,
}

impl FileEntry {
    fn to_value(&self) -> Value {
        json!({
            "path_b64": proto::b64_encode(&self.path),
            "orig_path_b64": self.orig_path.as_ref().map(|p| proto::b64_encode(p)),
            "index": self.index,
            "worktree": self.worktree,
            "staged": self.staged,
            "status": self.status,
        })
    }
}

/// Parse `--porcelain=v2 --branch -z`. See `git status`'s "Porcelain Format
/// Version 2" documentation for the record shapes.
fn parse_status(raw: &[u8]) -> (StatusHead, Vec<FileEntry>, bool) {
    let mut head = StatusHead::default();
    let mut files = Vec::new();
    let mut truncated = false;
    let tokens: Vec<&[u8]> = raw.split(|b| *b == 0).collect();
    let mut i = 0;
    while i < tokens.len() {
        let rec = tokens[i];
        i += 1;
        if rec.is_empty() {
            continue;
        }
        if let Some(header) = rec.strip_prefix(b"# ") {
            head.apply(header);
            continue;
        }
        if files.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        match rec[0] {
            // Ordinary and unmerged changes: 9 fields, path last (it may
            // contain spaces, which is why this is a splitn).
            b'1' | b'u' => {
                let parts = split_fields(rec, 9);
                if parts.len() < 9 {
                    continue;
                }
                files.push(entry_from_xy(
                    parts[1],
                    parts[8].to_vec(),
                    None,
                    rec[0] == b'u',
                ));
            }
            // Rename/copy: 10 fields (the score is its own field), and the
            // original path is the *next* NUL-terminated token.
            b'2' => {
                let parts = split_fields(rec, 10);
                if parts.len() < 10 {
                    continue;
                }
                let orig = tokens.get(i).filter(|t| !t.is_empty()).map(|t| t.to_vec());
                if orig.is_some() {
                    i += 1;
                }
                files.push(entry_from_xy(parts[1], parts[9].to_vec(), orig, false));
            }
            // Untracked.
            b'?' => {
                let parts = split_fields(rec, 2);
                if parts.len() < 2 {
                    continue;
                }
                files.push(FileEntry {
                    path: parts[1].to_vec(),
                    orig_path: None,
                    index: "?".to_string(),
                    worktree: "?".to_string(),
                    staged: false,
                    status: "untracked",
                });
            }
            // `!` is ignored (only with `--ignored`); anything else is a record
            // kind this version does not know — skip it rather than fail the
            // whole status.
            _ => {}
        }
    }
    (head, files, truncated)
}

/// The first `n` space-separated fields of a record; field `n-1` keeps the
/// rest verbatim, which is how a path containing spaces survives.
fn split_fields(record: &[u8], n: usize) -> Vec<&[u8]> {
    record.splitn(n, |b| *b == b' ').collect()
}

fn entry_from_xy(
    xy: &[u8],
    path: Vec<u8>,
    orig_path: Option<Vec<u8>>,
    unmerged: bool,
) -> FileEntry {
    let x = xy.first().copied().unwrap_or(b'.');
    let y = xy.get(1).copied().unwrap_or(b'.');
    let staged = x != b'.' && x != b'?';
    let status = if unmerged {
        "conflicted"
    } else if staged {
        letter_status(x)
    } else {
        letter_status(y)
    };
    FileEntry {
        path,
        orig_path,
        index: (x as char).to_string(),
        worktree: (y as char).to_string(),
        staged,
        status,
    }
}

#[derive(Default)]
struct StatusHead {
    branch: Option<String>,
    oid: Option<String>,
    detached: bool,
    initial: bool,
    upstream: Option<String>,
    ahead: Option<u64>,
    behind: Option<u64>,
}

impl StatusHead {
    fn apply(&mut self, header: &[u8]) {
        let Some(space) = header.iter().position(|b| *b == b' ') else {
            return;
        };
        let (key, value) = header.split_at(space);
        let value = &value[1..];
        match key {
            b"branch.oid" => {
                if value == b"(initial)" {
                    self.initial = true;
                } else {
                    self.oid = Some(text(value));
                }
            }
            b"branch.head" => {
                if value == b"(detached)" {
                    self.detached = true;
                } else {
                    self.branch = Some(text(value));
                }
            }
            b"branch.upstream" => self.upstream = Some(text(value)),
            b"branch.ab" => {
                // `+<ahead> -<behind>`
                for part in value.split(|b| *b == b' ') {
                    let Some((sign, digits)) = part.split_first() else {
                        continue;
                    };
                    let Ok(n) = text(digits).parse::<u64>() else {
                        continue;
                    };
                    match sign {
                        b'+' => self.ahead = Some(n),
                        b'-' => self.behind = Some(n),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

pub fn status(req: &Request) -> Result<Value, ProtoError> {
    let (asked, repo) = repo_of(req)?;
    let raw = run_git(
        &repo,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
    )?;
    let (head, files, truncated) = parse_status(&raw);
    // `clean` is about the repository, not about the list we could fit: a
    // status that had to be truncated is not clean either way.
    let clean = files.is_empty() && !truncated;
    let files: Vec<Value> = files.iter().map(FileEntry::to_value).collect();
    Ok(json!({
        "path_b64": b64_of(&asked),
        "root_b64": b64_of(&repo),
        "branch_b64": head.branch.as_ref().map(|b| proto::b64_encode(b.as_bytes())),
        "oid": head.oid,
        "detached": head.detached,
        "initial": head.initial,
        "upstream_b64": head.upstream.as_ref().map(|u| proto::b64_encode(u.as_bytes())),
        "ahead": head.ahead,
        "behind": head.behind,
        "files": files,
        "clean": clean,
        "truncated": truncated,
    }))
}

// ---------------------------------------------------------------------------
// git.branches
// ---------------------------------------------------------------------------

pub fn branches(req: &Request) -> Result<Value, ProtoError> {
    let (_asked, repo) = repo_of(req)?;
    let raw = run_git(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut list = Vec::new();
    let mut current: Option<String> = None;
    let mut truncated = false;
    for record in raw.split(|b| *b == b'\n') {
        if record.is_empty() {
            continue;
        }
        if list.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        let fields: Vec<&[u8]> = record.split(|b| *b == 0).collect();
        if fields.len() < 4 {
            continue;
        }
        let short = text(fields[0]);
        let full = text(fields[1]);
        let oid = text(fields[2]);
        let upstream = fields[3];
        let is_head = fields[4] == b"*";
        let remote = full.starts_with("refs/remotes/");
        // `refs/remotes/origin/HEAD` is a symbolic alias, not a branch.
        if full.ends_with("/HEAD") {
            continue;
        }
        if is_head && current.is_none() {
            current = Some(short.clone());
        }
        list.push(json!({
            "name_b64": proto::b64_encode(short.as_bytes()),
            "full_b64": proto::b64_encode(full.as_bytes()),
            "oid": oid,
            "upstream_b64": if upstream.is_empty() { Value::Null } else { json!(proto::b64_encode(upstream)) },
            "current": is_head,
            "remote": remote,
        }));
    }
    Ok(json!({
        "root_b64": b64_of(&repo),
        "current_b64": current.map(|c| proto::b64_encode(c.as_bytes())),
        "branches": list,
        "truncated": truncated,
    }))
}

// ---------------------------------------------------------------------------
// git.diff
// ---------------------------------------------------------------------------

/// The one-letter status of a `--name-status` record.
fn name_status_code(code: &[u8]) -> &'static str {
    match code.first().copied().unwrap_or(b'M') {
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "copied",
        b'T' => "typechange",
        _ => "modified",
    }
}

fn parse_name_status(raw: &[u8]) -> (Vec<Value>, bool) {
    let tokens: Vec<&[u8]> = raw.split(|b| *b == 0).collect();
    let mut files = Vec::new();
    let mut truncated = false;
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        i += 1;
        if token.is_empty() {
            continue;
        }
        if files.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        let status = name_status_code(token);
        // A rename/copy record carries two paths — old, then new; the rest
        // carry exactly one.
        let is_rename = matches!(token.first(), Some(&b'R') | Some(&b'C'));
        let (orig, path) = if is_rename {
            let orig = tokens.get(i).filter(|t| !t.is_empty()).map(|t| t.to_vec());
            let path = tokens
                .get(i + 1)
                .filter(|t| !t.is_empty())
                .map(|t| t.to_vec());
            i += 2;
            (orig, path)
        } else {
            let path = tokens.get(i).filter(|t| !t.is_empty()).map(|t| t.to_vec());
            i += 1;
            (None, path)
        };
        let Some(path) = path else { continue };
        files.push(json!({
            "path_b64": proto::b64_encode(&path),
            "orig_path_b64": orig.as_ref().map(|p| proto::b64_encode(p)),
            "status": status,
        }));
    }
    (files, truncated)
}

pub fn diff(req: &Request) -> Result<Value, ProtoError> {
    // The requested directory is not echoed: `root_b64` is the resolved
    // repository and `path_b64` is the diff target, which is what a caller
    // needs to line the reply up with its request.
    let (_asked, repo) = repo_of(req)?;
    let staged = req.bool("staged")?.unwrap_or(false);
    let files_only = req.bool("files_only")?.unwrap_or(false);
    let path = match req.bytes("path_b64")? {
        Some(bytes) if !bytes.is_empty() => Some(path_from_bytes(&bytes)),
        _ => None,
    };
    let mut base: Vec<&str> = vec!["diff", "-M", "--no-color", "--no-ext-diff"];
    if staged {
        base.push("--cached");
    }

    let mut name_args = base.clone();
    name_args.push("--name-status");
    name_args.push("-z");
    if let Some(path) = path.as_ref() {
        name_args.push("--");
        name_args.push(path.to_str().ok_or_else(|| {
            ProtoError::bad_request("`path_b64` is not valid UTF-8 and git paths must be")
        })?);
    }
    let raw = run_git(&repo, &name_args)?;
    let (files, truncated) = parse_name_status(&raw);

    if files_only {
        return Ok(json!({
            "path_b64": path.as_ref().map(|p| b64_of(p)),
            "root_b64": b64_of(&repo),
            "staged": staged,
            "files": files,
            "truncated": truncated,
            "files_only": true,
            "diff_b64": Value::Null,
            "binary": false,
        }));
    }

    let mut patch_args = base;
    patch_args.push("--");
    if let Some(path) = path.as_ref() {
        patch_args.push(path.to_str().ok_or_else(|| {
            ProtoError::bad_request("`path_b64` is not valid UTF-8 and git paths must be")
        })?);
    }
    let (patch, overflowed) = run_git_limited(&repo, &patch_args, MAX_PATCH_BYTES)?;
    // A patch too big to deliver is not an error: the file list is already the
    // useful half of the answer, and the caller can then ask per file.
    let binary = patch.windows(13).any(|w| w == b"Binary files ");
    Ok(json!({
        "path_b64": path.as_ref().map(|p| b64_of(p)),
        "root_b64": b64_of(&repo),
        "staged": staged,
        "files": files,
        "truncated": truncated,
        "files_only": overflowed,
        "diff_b64": if overflowed { Value::Null } else { json!(proto::b64_encode(&patch)) },
        "binary": binary,
    }))
}

// ---------------------------------------------------------------------------
// git.log
// ---------------------------------------------------------------------------

/// `%x1f`-separated fields, `%x1e` between commits. Both are control bytes no
/// sane commit message contains, and unlike a space they survive an empty
/// field.
const LOG_FORMAT: &str = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%P%x1f%D%x1f%s%x1e";

pub fn log(req: &Request) -> Result<Value, ProtoError> {
    let (_asked, repo) = repo_of(req)?;
    let limit = req
        .u64("limit")?
        .unwrap_or(DEFAULT_LOG_LIMIT)
        .clamp(1, MAX_LIST_ENTRIES as u64);
    let skip = req.u64("skip")?.unwrap_or(0);
    let path = match req.bytes("path_b64")? {
        Some(bytes) if !bytes.is_empty() => Some(path_from_bytes(&bytes)),
        _ => None,
    };
    // One extra: if it comes back there is another page, without a second
    // process to ask.
    let max_count = format!("--max-count={}", limit + 1);
    let skip_arg = format!("--skip={skip}");
    let format = format!("--format={LOG_FORMAT}");
    let mut args: Vec<&str> = vec!["log", &max_count, &skip_arg, &format];
    if let Some(path) = path.as_ref() {
        args.push("--");
        args.push(path.to_str().ok_or_else(|| {
            ProtoError::bad_request("`path_b64` is not valid UTF-8 and git paths must be")
        })?);
    }
    let raw = run_git(&repo, &args)?;
    let mut commits = Vec::new();
    let mut truncated = false;
    for record in raw.split(|b| *b == 0x1e) {
        // Each record is `fields\x1e\n`; the newline git appends belongs to the
        // separator, not the last field.
        let record = record.strip_prefix(b"\n").unwrap_or(record);
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        if record.is_empty() {
            continue;
        }
        if commits.len() >= limit as usize {
            truncated = true;
            break;
        }
        let fields: Vec<&[u8]> = record.split(|b| *b == 0x1f).collect();
        if fields.len() < 9 {
            continue;
        }
        let parents: Vec<Value> = text(fields[6])
            .split_whitespace()
            .map(|p| json!(p))
            .collect();
        commits.push(json!({
            "hash": text(fields[0]),
            "short": text(fields[1]),
            "author_b64": proto::b64_encode(fields[2]),
            "email_b64": proto::b64_encode(fields[3]),
            "author_date": text(fields[4]),
            "commit_date": text(fields[5]),
            "parents": parents,
            "refs_b64": if fields[7].is_empty() { Value::Null } else { json!(proto::b64_encode(fields[7])) },
            "subject_b64": proto::b64_encode(fields[8]),
        }));
    }
    Ok(json!({
        "root_b64": b64_of(&repo),
        "limit": limit,
        "skip": skip,
        "commits": commits,
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The byte layout probed from a real repository, so the parser is pinned
    /// to what git actually emits and not to what the docs suggest.
    #[test]
    fn status_parses_every_record_kind() {
        let raw = b"# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0\
                    # branch.ab +2 -3\0\
                    1 .M N... 100644 100644 100644 aaa bbb a.txt\0\
                    2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt\0b.txt\0\
                    ? untracked.txt\0";
        let (head, files, truncated) = parse_status(raw);
        assert!(!truncated);
        assert_eq!(head.branch.as_deref(), Some("main"));
        assert_eq!(head.oid.as_deref(), Some("abc123"));
        assert_eq!(head.upstream.as_deref(), Some("origin/main"));
        assert_eq!((head.ahead, head.behind), (Some(2), Some(3)));
        assert!(!head.detached);

        let plain: Vec<Value> = files.iter().map(FileEntry::to_value).collect();
        assert_eq!(plain.len(), 3);
        assert_eq!(plain[0]["status"], "modified");
        assert_eq!(plain[0]["index"], ".");
        assert_eq!(plain[0]["worktree"], "M");
        assert_eq!(plain[0]["staged"], false);
        assert_eq!(plain[0]["path_b64"], proto::b64_encode(b"a.txt"));
        assert_eq!(plain[1]["status"], "renamed");
        assert_eq!(plain[1]["staged"], true);
        assert_eq!(plain[1]["path_b64"], proto::b64_encode(b"renamed.txt"));
        assert_eq!(plain[1]["orig_path_b64"], proto::b64_encode(b"b.txt"));
        assert_eq!(plain[2]["status"], "untracked");
    }

    #[test]
    fn status_handles_a_path_containing_spaces() {
        let raw = b"1 .M N... 100644 100644 100644 aaa bbb has a space.txt\0";
        let (_, files, _) = parse_status(raw);
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].to_value()["path_b64"],
            proto::b64_encode(b"has a space.txt")
        );
    }

    #[test]
    fn status_reads_a_detached_initial_head() {
        let raw = b"# branch.oid (initial)\0# branch.head (detached)\0";
        let (head, files, _) = parse_status(raw);
        assert!(head.initial);
        assert!(head.detached);
        assert_eq!(head.branch, None);
        assert_eq!(head.oid, None);
        assert!(files.is_empty());
    }

    #[test]
    fn name_status_parses_renames() {
        let raw = b"M\0a.txt\0A\0new.txt\0R100\0old.txt\0newer.txt\0";
        let (files, truncated) = parse_name_status(raw);
        assert!(!truncated);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0]["status"], "modified");
        assert_eq!(files[0]["path_b64"], proto::b64_encode(b"a.txt"));
        assert_eq!(files[1]["status"], "added");
        assert_eq!(files[2]["status"], "renamed");
        assert_eq!(files[2]["path_b64"], proto::b64_encode(b"newer.txt"));
        assert_eq!(files[2]["orig_path_b64"], proto::b64_encode(b"old.txt"));
    }

    #[test]
    fn discover_walks_up_to_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let deep = repo.join("a").join("b");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir(repo.join(".git")).unwrap();
        assert_eq!(discover(&deep).unwrap(), repo);
        assert_eq!(discover(&repo).unwrap(), repo);
        assert_eq!(discover(dir.path()).unwrap_err().code, ErrorCode::NotARepo);
    }

    #[test]
    fn git_dir_follows_a_worktree_file() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let real = dir.path().join("real-git-dir");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(repo.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        assert_eq!(git_dir(&repo), real);
        // A plain `.git` directory wins.
        std::fs::remove_file(repo.join(".git")).unwrap();
        std::fs::create_dir(repo.join(".git")).unwrap();
        assert_eq!(git_dir(&repo), repo.join(".git"));
    }
}

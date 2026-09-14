//! `fs.list`, `fs.read`, `fs.stat` — read-only filesystem access.
//!
//! Paths arrive as `path_b64` bytes and go back out as `*_b64` strings, so a
//! file name containing a quote, a backslash, a tab or a newline round-trips
//! unchanged. On POSIX the conversion is byte-exact; on Windows — where the
//! helper is never deployed but must still compile — it is lossy UTF-8, which
//! is all a JS frontend could represent anyway.

use crate::proto::{
    self, ErrorCode, ProtoError, Request, DEFAULT_READ_LIMIT, MAX_FILE_BYTES, MAX_LIST_ENTRIES,
    MAX_READ_CHUNK,
};
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Bytes of a path, as they go on the wire.
pub fn path_bytes(path: &Path) -> Vec<u8> {
    os_bytes(path.as_os_str())
}

/// A `*_b64` path field back to a `PathBuf`.
pub fn path_from_bytes(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        PathBuf::from(std::ffi::OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

fn os_bytes(name: &OsStr) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        name.as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        name.to_string_lossy().into_owned().into_bytes()
    }
}

fn b64_of(path: &Path) -> String {
    proto::b64_encode(&path_bytes(path))
}

/// Map an I/O failure onto the closed error set.
fn io_error(path: &Path, e: std::io::Error) -> ProtoError {
    let shown = path.display();
    match e.kind() {
        ErrorKind::NotFound => ProtoError::not_found(format!("no such path: {shown}")),
        ErrorKind::PermissionDenied => {
            ProtoError::unreadable(format!("permission denied: {shown}"))
        }
        _ => ProtoError::unreadable(format!("cannot read {shown}: {e}")),
    }
}

/// The `kind` enum. `symlink` is reported for the link itself, never followed.
fn kind_of(meta: &std::fs::Metadata) -> &'static str {
    let ft = meta.file_type();
    if ft.is_symlink() {
        "symlink"
    } else if ft.is_dir() {
        "dir"
    } else if ft.is_file() {
        "file"
    } else {
        "other"
    }
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mode_of(meta: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.mode()
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        0
    }
}

/// `..` of a path as the file tree understands it: `/` stays `/`, and a
/// single-component relative path falls back to `.` — the same convention the
/// shipping `FARAGENT_DIRS_V1` script and its parser use.
fn parent_dir(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        Some(_) => PathBuf::from("."),
        None => path.to_path_buf(),
    }
}

/// Is this chunk non-text? A NUL byte is the classic marker and is what git
/// itself uses; invalid UTF-8 alone is *not* treated as binary, because a
/// Latin-1 source file should still be previewable.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

/// Up to 8 KiB from the head of the file, for binary detection.
const SNIFF_BYTES: u64 = 8 * 1024;

pub fn list(req: &Request) -> Result<Value, ProtoError> {
    let path = path_from_bytes(&req.required_bytes("path_b64")?);
    let meta = std::fs::symlink_metadata(&path).map_err(|e| io_error(&path, e))?;
    // A symlinked directory lists like `ls` would: follow the link.
    let is_dir = if meta.file_type().is_symlink() {
        std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
    } else {
        meta.is_dir()
    };
    if !is_dir {
        return Err(ProtoError::new(
            ErrorCode::NotADir,
            format!("not a directory: {}", path.display()),
        ));
    }
    let read = std::fs::read_dir(&path).map_err(|e| io_error(&path, e))?;
    let mut entries: Vec<(Vec<u8>, &'static str, u64, u64)> = Vec::new();
    let mut truncated = false;
    for entry in read {
        let entry = entry.map_err(|e| io_error(&path, e))?;
        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        let name = os_bytes(&entry.file_name());
        // `DirEntry::metadata` does not traverse symlinks, so a symlink is
        // reported as a symlink rather than as its target.
        let (kind, size, mtime) = match entry.metadata() {
            Ok(m) => (
                kind_of(&m),
                if m.is_file() { m.len() } else { 0 },
                mtime_secs(&m),
            ),
            Err(_) => ("other", 0, 0),
        };
        entries.push((name, kind, size, mtime));
    }
    // Deterministic order; the caller's tree renders it as it comes.
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|(name, kind, size, mtime)| {
            json!({
                "name_b64": proto::b64_encode(&name),
                "kind": kind,
                "size": size,
                "mtime": mtime,
                "is_symlink": kind == "symlink",
            })
        })
        .collect();
    Ok(json!({
        "path_b64": b64_of(&path),
        "parent_b64": b64_of(&parent_dir(&path)),
        "entries": entries,
        "truncated": truncated,
    }))
}

pub fn stat(req: &Request) -> Result<Value, ProtoError> {
    let path = path_from_bytes(&req.required_bytes("path_b64")?);
    let meta = std::fs::symlink_metadata(&path).map_err(|e| io_error(&path, e))?;
    Ok(json!({
        "path_b64": b64_of(&path),
        "kind": kind_of(&meta),
        "size": meta.len(),
        "mtime": mtime_secs(&meta),
        "mode": mode_of(&meta),
        "is_symlink": meta.file_type().is_symlink(),
    }))
}

pub fn read(req: &Request) -> Result<Value, ProtoError> {
    let path = path_from_bytes(&req.required_bytes("path_b64")?);
    let offset = req.u64("offset")?.unwrap_or(0);
    let limit = req
        .u64("limit")?
        .unwrap_or(DEFAULT_READ_LIMIT)
        .clamp(1, MAX_READ_CHUNK);
    let meta = std::fs::metadata(&path).map_err(|e| io_error(&path, e))?;
    if !meta.is_file() {
        return Err(ProtoError::unreadable(format!(
            "not a regular file: {}",
            path.display()
        )));
    }
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Err(ProtoError::new(
            ErrorCode::TooLarge,
            format!(
                "{} is {size} bytes, more than the {MAX_FILE_BYTES} byte preview limit",
                path.display()
            ),
        ));
    }
    let mut file = File::open(&path).map_err(|e| io_error(&path, e))?;
    // Sniff the head of the file, not just the requested chunk: a chunk taken
    // from the middle of an archive carries no NUL and would look like text.
    let mut sniff = vec![0u8; SNIFF_BYTES.min(size) as usize];
    let sniffed = read_full(&mut file, &mut sniff).map_err(|e| io_error(&path, e))?;
    sniff.truncate(sniffed);
    if looks_binary(&sniff) {
        return Err(ProtoError::new(
            ErrorCode::Binary,
            format!("{} is a binary file ({size} bytes)", path.display()),
        ));
    }
    let start = offset.min(size);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| io_error(&path, e))?;
    let want = (size - start).min(limit) as usize;
    let mut buf = vec![0u8; want];
    let filled = read_full(&mut file, &mut buf).map_err(|e| io_error(&path, e))?;
    buf.truncate(filled);
    if looks_binary(&buf) {
        return Err(ProtoError::new(
            ErrorCode::Binary,
            format!("{} is a binary file ({size} bytes)", path.display()),
        ));
    }
    Ok(json!({
        "data_b64": proto::b64_encode(&buf),
        "eof": start + filled as u64 >= size,
        "size": size,
    }))
}

/// Read until `buf` is full or the file ends; returns the bytes read.
fn read_full(file: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(op: &str, params: Value) -> Request {
        let mut obj = serde_json::Map::new();
        obj.insert("id".into(), json!(1));
        obj.insert("op".into(), json!(op));
        if let Value::Object(map) = params {
            for (k, v) in map {
                obj.insert(k, v);
            }
        }
        Request::from_line(&serde_json::to_vec(&Value::Object(obj)).unwrap()).unwrap()
    }

    fn b64(bytes: &[u8]) -> String {
        proto::b64_encode(bytes)
    }

    #[test]
    fn parent_dir_matches_the_dirs_v1_convention() {
        assert_eq!(parent_dir(Path::new("/")), PathBuf::from("/"));
        assert_eq!(parent_dir(Path::new("/home/me")), PathBuf::from("/home"));
        assert_eq!(parent_dir(Path::new("/home")), PathBuf::from("/"));
        assert_eq!(parent_dir(Path::new("solo")), PathBuf::from("."));
    }

    #[test]
    fn path_bytes_round_trip() {
        for raw in ["/tmp/a b", "/tmp/quote\"and'apostrophe", "/tmp/tab\there"] {
            assert_eq!(path_from_bytes(&path_bytes(Path::new(raw))), PathBuf::from(raw));
        }
    }

    #[test]
    fn missing_path_is_not_found() {
        let req = request("fs.stat", json!({ "path_b64": b64(b"/no/such/path/at/all") }));
        assert_eq!(stat(&req).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn listing_a_file_is_not_a_dir() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        let req = request("fs.list", json!({ "path_b64": b64(&path_bytes(&file)) }));
        assert_eq!(list(&req).unwrap_err().code, ErrorCode::NotADir);
    }

    #[test]
    fn read_refuses_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let req = request("fs.read", json!({ "path_b64": b64(&path_bytes(dir.path())) }));
        assert_eq!(read(&req).unwrap_err().code, ErrorCode::Unreadable);
    }
}

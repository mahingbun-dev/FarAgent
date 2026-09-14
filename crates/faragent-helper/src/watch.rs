//! Push subscriptions: `watch.subscribe`, `watch.unsubscribe`, and the
//! `fs.changed` / `git.changed` frames they produce.
//!
//! Two mechanisms, because one is not enough:
//!
//! * the [`notify`] crate reports what changes under a watched directory;
//! * a periodic stat of `.git/HEAD` and `.git/index` catches what `notify`
//!   does not — git writes those files through temporary names and renames
//!   them into place, and on several platforms the resulting event storm is
//!   coalesced or attributed to a path the watcher no longer recognises.
//!
//! Subscriptions are **idempotent**: subscribing to a path that is already
//! watched (with the same recursion) returns the existing id and
//! `already: true` instead of adding a second watch, so a client may
//! re-subscribe on every reconnect without piling up duplicates.

use crate::ops::git;
use crate::ops::fs::{path_bytes, path_from_bytes};
use crate::proto::{self, ProtoError, Request};
use crate::SharedWriter;
use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};

/// How often the git metadata is re-stat'ed. Slow enough to cost nothing,
/// quick enough that a commit shows up within one UI beat.
pub const GIT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// `(len, mtime)` of a git metadata file. The length is in the comparison
/// because a filesystem with one-second timestamps may otherwise see a commit
/// as "no change".
type Stamp = Option<(u64, SystemTime)>;

fn stamp(path: &Path) -> Stamp {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    Some((meta.len(), mtime))
}

struct Entry {
    id: u64,
    path: PathBuf,
    recursive: bool,
    /// The real git directory when the watched path is inside a repository.
    git_dir: Option<PathBuf>,
    /// Last seen `(HEAD, index)` stamps; `None` until first observed.
    git_stamp: Option<(Stamp, Stamp)>,
}

struct Inner {
    next_id: u64,
    entries: Vec<Entry>,
}

/// The subscription table plus the thread that turns watcher callbacks into
/// push frames.
pub struct Watchers {
    inner: Arc<Mutex<Inner>>,
    out: SharedWriter,
    poll: Duration,
    /// Held for as long as the session lives. The watcher owns the handler
    /// closure, which owns the channel sender: dropping the watcher is what
    /// ends the pump thread.
    watcher: Option<RecommendedWatcher>,
    pump: Option<JoinHandle<()>>,
}

impl Watchers {
    pub fn new(out: SharedWriter) -> Self {
        Self::with_poll_interval(out, GIT_POLL_INTERVAL)
    }

    pub fn with_poll_interval(out: SharedWriter, poll: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                next_id: 1,
                entries: Vec::new(),
            })),
            out,
            poll,
            watcher: None,
            pump: None,
        }
    }

    /// Start the watcher and its pump thread, once. No-op after the first
    /// call, and no-op-able before any subscription exists.
    fn ensure_pump(&mut self) -> Result<(), ProtoError> {
        if self.pump.is_some() {
            return Ok(());
        }
        let (tx, rx) = channel();
        let watcher = RecommendedWatcher::new(
            move |res| {
                // A closed receiver means the pump is gone; the send just fails.
                let _ = tx.send(res);
            },
            notify::Config::default(),
        )
        .map_err(|e| ProtoError::internal(format!("cannot start a filesystem watcher: {e}")))?;
        let inner = Arc::clone(&self.inner);
        let out = Arc::clone(&self.out);
        let poll = self.poll;
        self.pump = Some(thread::spawn(move || pump(rx, inner, out, poll)));
        self.watcher = Some(watcher);
        Ok(())
    }

    fn watch(&mut self, path: &Path, recursive: bool) -> Result<(), ProtoError> {
        let Some(watcher) = self.watcher.as_mut() else {
            return Err(ProtoError::internal("watcher was not started"));
        };
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        watcher.watch(path, mode).map_err(|e| {
            ProtoError::unreadable(format!("cannot watch {}: {e}", path.display()))
        })
    }

    fn unwatch(&mut self, path: &Path) {
        if let Some(watcher) = self.watcher.as_mut() {
            let _ = watcher.unwatch(path);
        }
    }

    /// Is this exact watch already registered? Returns its id if so.
    fn find(&self, path: &Path, recursive: bool) -> Option<u64> {
        let inner = self.inner.lock().ok()?;
        inner
            .entries
            .iter()
            .find(|e| e.path == path && e.recursive == recursive)
            .map(|e| e.id)
    }

    pub fn subscribe(
        &mut self,
        path: PathBuf,
        recursive: bool,
    ) -> Result<(u64, bool, Option<PathBuf>), ProtoError> {
        // Idempotence is decided before anything is registered: a repeat
        // subscribe must not add a second watch entry to the OS watcher.
        let git_dir = git::discover(&path).ok().map(|repo| git::git_dir(&repo));
        if let Some(id) = self.find(&path, recursive) {
            return Ok((id, true, git_dir));
        }
        self.ensure_pump()?;
        self.watch(&path, recursive)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| ProtoError::internal("the subscription table is poisoned"))?;
        if let Some(entry) = inner
            .entries
            .iter()
            .find(|e| e.path == path && e.recursive == recursive)
        {
            // Another caller won the race between `find` and the lock.
            return Ok((entry.id, true, git_dir));
        }
        let id = inner.next_id;
        inner.next_id += 1;
        inner.entries.push(Entry {
            id,
            path,
            recursive,
            git_dir: git_dir.clone(),
            git_stamp: None,
        });
        Ok((id, false, git_dir))
    }

    /// Drop every subscription matching the id and/or the path. Returns how
    /// many were removed.
    pub fn unsubscribe(&mut self, id: Option<u64>, path: Option<&Path>) -> usize {
        let matches = |entry: &Entry| {
            id.map(|id| entry.id == id).unwrap_or(false)
                || path.map(|p| entry.path == p).unwrap_or(false)
        };
        let (removed, to_unwatch) = {
            let Ok(mut inner) = self.inner.lock() else {
                return 0;
            };
            let candidates: Vec<PathBuf> = inner
                .entries
                .iter()
                .filter(|e| matches(e))
                .map(|e| e.path.clone())
                .collect();
            let before = inner.entries.len();
            inner.entries.retain(|e| !matches(e));
            let survivors: Vec<PathBuf> = inner.entries.iter().map(|e| e.path.clone()).collect();
            let orphans: Vec<PathBuf> = candidates
                .into_iter()
                .filter(|candidate| !survivors.iter().any(|survivor| survivor == candidate))
                .collect();
            (before - inner.entries.len(), orphans)
        };
        // Stop watching a path only once no surviving subscription names it:
        // the same directory can be watched recursively and not.
        for path in to_unwatch {
            self.unwatch(&path);
        }
        removed
    }
}

/// Read one line for the `notify` handler's channel, waking every `poll` to
/// check the git metadata.
fn pump(
    rx: Receiver<notify::Result<notify::Event>>,
    inner: Arc<Mutex<Inner>>,
    out: SharedWriter,
    poll: Duration,
) {
    loop {
        match rx.recv_timeout(poll) {
            Ok(Ok(event)) => emit_fs(&inner, &out, &event),
            // A watcher-level failure is not fatal and not the client's
            // business; the pump keeps serving the other subscriptions.
            Ok(Err(_)) => {}
            Err(RecvTimeoutError::Timeout) => emit_git(&inner, &out),
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn kind_of(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Remove(_) => Some("removed"),
        EventKind::Modify(ModifyKind::Name(_)) => Some("renamed"),
        EventKind::Modify(_) => Some("modified"),
        // Access events fire on every read; pushing them would be noise.
        EventKind::Access(_) => None,
        _ => Some("other"),
    }
}

fn emit_fs(inner: &Arc<Mutex<Inner>>, out: &SharedWriter, event: &notify::Event) {
    let Some(kind) = kind_of(&event.kind) else {
        return;
    };
    let Some(path) = event.paths.first() else {
        return;
    };
    let Ok(guard) = inner.lock() else {
        return;
    };
    // The most specific subscription that covers this path owns the event.
    let owner = guard
        .entries
        .iter()
        .filter(|e| path.starts_with(&e.path))
        .max_by_key(|e| e.path.as_os_str().len());
    let Some(owner) = owner else {
        return;
    };
    let data = json!({
        "subscription": owner.id,
        "root_b64": proto::b64_encode(&path_bytes(&owner.path)),
        "path_b64": proto::b64_encode(&path_bytes(path)),
        "kind": kind,
    });
    drop(guard);
    crate::write_frame(out, proto::Frame::event("fs.changed", data));
}

fn emit_git(inner: &Arc<Mutex<Inner>>, out: &SharedWriter) {
    let mut frames = Vec::new();
    {
        let Ok(mut guard) = inner.lock() else {
            return;
        };
        for entry in guard.entries.iter_mut() {
            let Some(git_dir) = entry.git_dir.as_ref() else {
                continue;
            };
            let now = (
                stamp(&git_dir.join("HEAD")),
                stamp(&git_dir.join("index")),
            );
            let first = entry.git_stamp.is_none();
            if entry.git_stamp.as_ref() == Some(&now) {
                continue;
            }
            entry.git_stamp = Some(now);
            // The first observation only primes the comparison; pushing on it
            // would announce a change that did not happen.
            if first {
                continue;
            }
            frames.push(proto::Frame::event(
                "git.changed",
                json!({
                    "subscription": entry.id,
                    "root_b64": proto::b64_encode(&path_bytes(&entry.path)),
                }),
            ));
        }
    }
    for frame in frames {
        crate::write_frame(out, frame);
    }
}

/// `watch.subscribe`: `path_b64` (required), `recursive` (default true).
pub fn subscribe(watchers: &mut Watchers, req: &Request) -> Result<Value, ProtoError> {
    let path = path_from_bytes(&req.required_bytes("path_b64")?);
    let recursive = req.bool("recursive")?.unwrap_or(true);
    let (id, already, git_dir) = watchers.subscribe(path.clone(), recursive)?;
    Ok(json!({
        "subscription": id,
        "path_b64": proto::b64_encode(&path_bytes(&path)),
        "recursive": recursive,
        "already": already,
        "git_dir_b64": git_dir.map(|d| proto::b64_encode(&path_bytes(&d))),
    }))
}

/// `watch.unsubscribe`: `subscription` (id) and/or `path_b64`.
pub fn unsubscribe(watchers: &mut Watchers, req: &Request) -> Result<Value, ProtoError> {
    let id = req.u64("subscription")?;
    let path = match req.bytes("path_b64")? {
        Some(bytes) if !bytes.is_empty() => Some(path_from_bytes(&bytes)),
        _ => None,
    };
    if id.is_none() && path.is_none() {
        return Err(ProtoError::bad_request(
            "`watch.unsubscribe` needs `subscription` and/or `path_b64`",
        ));
    }
    let removed = watchers.unsubscribe(id, path.as_deref());
    Ok(json!({ "removed": removed }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sink() -> (SharedWriter, Arc<Mutex<Vec<u8>>>) {
        let buf = Arc::new(Mutex::new(Vec::new()));
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
        (Arc::new(Mutex::new(Box::new(Tee(Arc::clone(&buf))))), buf)
    }

    #[test]
    fn subscribe_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let (out, _buf) = sink();
        let mut watchers = Watchers::new(out);
        let (first, already, _) = watchers.subscribe(dir.path().to_path_buf(), true).unwrap();
        assert!(!already);
        let (second, already, _) = watchers.subscribe(dir.path().to_path_buf(), true).unwrap();
        assert!(already, "a repeat subscribe must report itself");
        assert_eq!(first, second, "and reuse the id");
        // The recursion flag is part of the identity: a different mode is a
        // different watch.
        let (third, already, _) = watchers.subscribe(dir.path().to_path_buf(), false).unwrap();
        assert!(!already);
        assert_ne!(first, third);
        assert_eq!(watchers.unsubscribe(Some(first), None), 1);
        assert_eq!(watchers.unsubscribe(Some(first), None), 0);
    }
}

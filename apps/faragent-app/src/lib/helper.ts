/**
 * The helper channel, from the frontend's side.
 *
 * `src-tauri/src/helper.rs` owns one framed NDJSON connection per host and
 * answers three commands; this module turns them into something a panel can
 * `await`:
 *
 * ```ts
 * const helper = await openHelper("build-01.farm.internal", {
 *   onPush: (event) => console.log(event.event, event.data),
 *   onClosed: (message) => setStatus(message),
 * });
 * const tree = await helper.listDir("/srv/app");
 * await helper.close();
 * ```
 *
 * Three things are deliberately *not* hidden from the caller:
 *
 * 1. **The mode.** `connection.mode` says whether the remote is running the
 *    verified native helper or the bash fallback, and why. A UI that did not
 *    show this would be degrading silently, which is the one outcome
 *    `faragent_service::helper` exists to prevent. `helperFallbackNotice()`
 *    turns it into the sentence the TUI shows.
 * 2. **The wire's byte-ness.** Paths and file contents travel base64-encoded
 *    because they are not necessarily UTF-8. This module decodes them into
 *    `Uint8Array` (never a lossy `String`), and `decodeText()` is there for the
 *    overwhelming majority that *are* UTF-8.
 * 3. **The error's `code`.** A failed op rejects with a `HelperError` carrying
 *    the protocol's own code, so a caller branches on `not_a_repo` rather than
 *    matching prose.
 */

import { Channel } from "@tauri-apps/api/core";
import { b64ToBytes, bytesToB64 } from "./bytes.ts";
import { asDiagnosis, ipc, pick } from "./ipc.ts";
import type { Lang, Text } from "./ipc.ts";

// ---------------------------------------------------------------------------
// The protocol's closed sets, mirrored
// ---------------------------------------------------------------------------

/**
 * The twelve op names the helper speaks (`faragent_helper::ops::OPS`, in the
 * same order). `ping`'s reply carries this list too, so a caller can check the
 * remote agrees.
 */
export const HELPER_OPS = [
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
] as const;

export type HelperOp = (typeof HELPER_OPS)[number];

/**
 * The protocol's closed error set (`proto::ErrorCode`). `bad_request` is also
 * what this side uses for a call it refused to put on the wire.
 */
export const HELPER_ERROR_CODES = [
  "bad_request",
  "not_found",
  "not_a_dir",
  "unreadable",
  "too_large",
  "binary",
  "not_a_repo",
  "git_failed",
  "internal",
] as const;

export type HelperErrorCode = (typeof HELPER_ERROR_CODES)[number];

/** `FallbackReason::code` — the eight reasons a remote is on the bash script. */
export const FALLBACK_REASONS = [
  "unsupported_platform",
  "no_local_artifact",
  "no_checksum_tool",
  "probe_failed",
  "windows_remote",
  "upload_failed",
  "verify_failed",
  "not_executable",
] as const;

export type FallbackReasonCode = (typeof FALLBACK_REASONS)[number];

// ---------------------------------------------------------------------------
// Shapes the caller works in (decoded from the wire's snake_case, b64 JSON)
// ---------------------------------------------------------------------------

/** `fs` entries: the link itself, never followed. */
export type FsKind = "file" | "dir" | "symlink" | "other";

export interface FsListEntry {
  name: Uint8Array;
  kind: FsKind;
  /** Bytes for a regular file, `0` otherwise. */
  size: number;
  /** Seconds since the epoch, `0` when the remote could not read it. */
  mtime: number;
  isSymlink: boolean;
}

export interface FsList {
  path: Uint8Array;
  parent: Uint8Array;
  /** Sorted by name on the remote; the tree renders it as it comes. */
  entries: FsListEntry[];
  /** The remote hit its 500-entry cap; `entries` is not the whole directory. */
  truncated: boolean;
}

export interface FsStat {
  path: Uint8Array;
  kind: FsKind;
  size: number;
  mtime: number;
  /** Unix mode bits, `0` on a remote that has none (Windows). */
  mode: number;
  isSymlink: boolean;
}

export interface FsRead {
  data: Uint8Array;
  /** `data` reached the end of the file: no need to ask for an offset. */
  eof: boolean;
  /** The whole file's size, not the chunk's. */
  size: number;
}

export interface GitDiscover {
  /** Where the caller asked from. */
  path: Uint8Array;
  /** The repository root `discover` walked up to. */
  root: Uint8Array;
  gitDir: Uint8Array;
  /** The root's basename. */
  name: Uint8Array;
}

export type GitFileStatus =
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "modified"
  /** Only ever on a `git.status` entry: `?` in porcelain v2. */
  | "untracked"
  /** Only ever on a `git.status` entry: an unmerged `u` record. */
  | "conflicted";

export interface GitStatusFile {
  path: Uint8Array;
  /** Set for a rename or a copy: the path it came from. */
  origPath: Uint8Array | null;
  /** Porcelain v2 XY, as two letters — `".M"`, `"R."`, `"UU"`. */
  index: string;
  worktree: string;
  staged: boolean;
  status: GitFileStatus;
}

export interface GitStatus {
  path: Uint8Array;
  root: Uint8Array;
  /** `null` on an unborn HEAD. */
  branch: Uint8Array | null;
  oid: string | null;
  detached: boolean;
  /** A repository with no commits yet. */
  initial: boolean;
  upstream: Uint8Array | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  /** No changes *and* nothing was cut off — the caveat matters. */
  clean: boolean;
  /** The remote hit its 500-file cap. */
  truncated: boolean;
}

export interface GitBranch {
  name: Uint8Array;
  full: Uint8Array;
  oid: string;
  upstream: Uint8Array | null;
  current: boolean;
  remote: boolean;
}

export interface GitBranches {
  root: Uint8Array;
  current: Uint8Array | null;
  branches: GitBranch[];
  truncated: boolean;
}

export interface GitDiffFile {
  path: Uint8Array;
  origPath: Uint8Array | null;
  status: GitFileStatus;
}

export interface GitDiff {
  /** The diff target, or `null` when the whole repository was diffed. */
  path: Uint8Array | null;
  root: Uint8Array;
  staged: boolean;
  files: GitDiffFile[];
  /** The *file list* was cut off, not the patch. */
  truncated: boolean;
  /**
   * The patch was too big to deliver, so only `files` is here. Not an error:
   * the file list is the half a caller can act on, and it can then ask per
   * file.
   */
  filesOnly: boolean;
  /** `null` when `filesOnly` — see above. */
  diff: Uint8Array | null;
  /** The patch contains `Binary files … differ`. */
  binary: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: Uint8Array;
  email: Uint8Array;
  /** ISO-8601, as git wrote it. */
  authorDate: string;
  commitDate: string;
  parents: string[];
  /** Decorations (`HEAD -> main, origin/main`), or `null`. */
  refs: Uint8Array | null;
  subject: Uint8Array;
}

export interface GitLog {
  root: Uint8Array;
  limit: number;
  skip: number;
  commits: GitCommit[];
  truncated: boolean;
}

export interface WatchSubscription {
  /** The id `unsubscribe` takes, and what a push names as `subscription`. */
  subscription: number;
  path: Uint8Array;
  recursive: boolean;
  /** This exact watch was already registered; the id is the existing one. */
  already: boolean;
  /** The resolved git directory, when the watched path is in a repository. */
  gitDir: Uint8Array | null;
}

export interface Ping {
  pong: true;
  version: string;
  pid: number;
  /** The remote's op set — `HELPER_OPS` when both ends agree. */
  ops: string[];
}

// -------------------------------------------------------------- mode / events

/** `HelperModeDto` from `helper.rs`. */
export type HelperMode =
  | { kind: "native" }
  | { kind: "script_fallback"; reason: { code: string; message: Text } };

export interface HelperOpen {
  id: number;
  mode: HelperMode;
  /** `mode.kind === "native"`, lifted so the common branch is one property. */
  native: boolean;
}

/**
 * A frame from the helper that no call asked for.
 *
 * `event` is passed through, not interpreted: this module knows `fs.changed`
 * and `git.changed` exist but refuses to guess at a name it has not seen.
 */
export type HelperEvent =
  | { kind: "push"; event: string; data: unknown }
  | { kind: "closed"; message: string };

/** A `fs.changed` push's `data`, when the caller has recognised the name. */
export interface FsChanged {
  subscription: number;
  root: Uint8Array;
  path: Uint8Array;
  kind: "created" | "removed" | "renamed" | "modified" | "other";
}

/** A `git.changed` push's `data`. */
export interface GitChanged {
  subscription: number;
  root: Uint8Array;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * How a helper call failed.
 *
 * - `remote` — the helper answered `ok:false`; `code` is the protocol's.
 * - `timeout` — no reply inside `helper.rs`'s 60s `CALL_TIMEOUT`. The request is
 *   still outstanding on the remote and its reply is simply dropped.
 * - `disconnected` — there is nothing to ask: the session was never open, was
 *   closed, or the stream died. A call in flight fails this way rather than
 *   hanging.
 * - `open` — `helper_open` itself failed (no route, no auth, a Windows remote).
 *   Its `message` is the backend's plain text; a connection *diagnosis* rides
 *   along in `cause` for `asDiagnosis()`.
 */
export type HelperFailureKind = "remote" | "timeout" | "disconnected" | "open";

export class HelperError extends Error {
  readonly kind: HelperFailureKind;
  /** The protocol code, for `kind === "remote"`; `null` otherwise. */
  readonly code: string | null;
  /** The op that failed, when the backend named it. */
  readonly op: string | null;
  /** The timeout's budget in seconds, for `kind === "timeout"`. */
  readonly seconds: number | null;
  /** The rejection as it arrived, before any unwrapping. */
  readonly cause: unknown;

  constructor(
    kind: HelperFailureKind,
    message: string,
    fields: {
      code?: string | null;
      op?: string | null;
      seconds?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "HelperError";
    this.kind = kind;
    this.code = fields.code ?? null;
    this.op = fields.op ?? null;
    this.seconds = fields.seconds ?? null;
    this.cause = fields.cause;
  }

  /** True when asking again on a fresh connection could plausibly work. */
  get retryable(): boolean {
    return this.kind === "timeout" || this.kind === "disconnected";
  }

  /** One of `HELPER_ERROR_CODES`, without narrowing a `string` for the caller. */
  get errorCode(): HelperErrorCode | null {
    return this.code === null || !isHelperErrorCode(this.code) ? null : this.code;
  }

  /**
   * Normalise anything `invoke` rejected with into a `HelperError`.
   *
   * Three shapes reach here, and all three are real: the tagged object this
   * backend's own errors serialize to, the same object wrapped in a `payload`
   * key, and a bare string from a command whose error type is a `CommandError`
   * (`helper_open` is one).
   */
  static from(e: unknown): HelperError {
    if (e instanceof HelperError) return e;
    const value = e && typeof e === "object" && "payload" in e ? e.payload : e;
    if (value && typeof value === "object" && "kind" in value) {
      const v = value as {
        kind: string;
        code?: unknown;
        message?: unknown;
        op?: unknown;
        seconds?: unknown;
      };
      const message =
        typeof v.message === "string" && v.message.length > 0
          ? v.message
          : fallbackText(e);
      if (v.kind === "remote") {
        return new HelperError("remote", message, {
          code: typeof v.code === "string" ? v.code : null,
          cause: e,
        });
      }
      if (v.kind === "timeout") {
        return new HelperError("timeout", message, {
          op: typeof v.op === "string" ? v.op : null,
          seconds: typeof v.seconds === "number" ? v.seconds : null,
          cause: e,
        });
      }
      if (v.kind === "disconnected") {
        return new HelperError("disconnected", message, { cause: e });
      }
      // A `CommandError` — `helper_open`'s failure shape.
      return new HelperError("open", message, { cause: e });
    }
    return new HelperError("open", fallbackText(e), { cause: e });
  }
}

function fallbackText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isHelperErrorCode(code: string): code is HelperErrorCode {
  return (HELPER_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * One sentence for any helper failure, in the user's language.
 *
 * A `remote` error is the helper's own English text (the protocol does not
 * localise), so it is passed through rather than disguised; an `open` failure
 * that carries a connection diagnosis uses that diagnosis's localized summary.
 */
export function helperErrorText(e: unknown, lang: Lang): string {
  const error = HelperError.from(e);
  if (error.kind === "open") {
    const diagnosis = asDiagnosis(e);
    if (diagnosis) return pick(diagnosis.summary, lang);
  }
  return error.message;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** The overwhelming majority of paths are UTF-8; this is for those. */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A path the caller typed, as the wire wants it. */
export function encodePath(path: string): string {
  return bytesToB64(new TextEncoder().encode(path));
}

type Wire = Record<string, unknown>;

function obj(value: unknown): Wire {
  return value && typeof value === "object" ? (value as Wire) : {};
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function bytes(value: unknown): Uint8Array {
  return typeof value === "string" ? b64ToBytes(value) : new Uint8Array(0);
}

function maybeBytes(value: unknown): Uint8Array | null {
  return typeof value === "string" && value.length > 0 ? b64ToBytes(value) : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function kind(value: unknown): FsKind {
  return value === "file" || value === "dir" || value === "symlink" ? value : "other";
}

function fileStatus(value: unknown): GitFileStatus {
  switch (value) {
    case "added":
    case "deleted":
    case "renamed":
    case "copied":
    case "typechange":
    case "untracked":
    case "conflicted":
      return value;
    default:
      return "modified";
  }
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

type PushHandler = (event: { event: string; data: unknown }) => void;
type ClosedHandler = (message: string) => void;

/**
 * One open helper channel.
 *
 * Obtained from `openHelper`; never constructed by a caller. Every method
 * rejects with a `HelperError`. `close()` is idempotent and safe to call from a
 * React effect's cleanup: a second call, and a call after the remote already
 * hung up, both resolve.
 */
export class HelperConnection {
  readonly id: number;
  readonly mode: HelperMode;
  readonly native: boolean;
  /** The host this connection was opened against. */
  readonly host: string;

  private pushHandlers = new Set<PushHandler>();
  private closedHandlers = new Set<ClosedHandler>();
  private closed = false;
  private closedMessage: string | null = null;
  private shuttingDown = false;

  constructor(host: string, opened: HelperOpen) {
    this.host = host;
    this.id = num(opened.id);
    this.mode = opened.mode;
    this.native = opened.native === true;
  }

  /** The fallback's reason, or `null` on a native connection. */
  get fallbackReason(): { code: string; message: Text } | null {
    return this.mode.kind === "script_fallback" ? this.mode.reason : null;
  }

  /** True once the channel has ended, whatever ended it. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Why it ended, or `null` while it is still live. */
  get closeReason(): string | null {
    return this.closedMessage;
  }

  /**
   * Watch unsolicited pushes. Returns an unsubscribe function, which is what a
   * React effect's cleanup wants; handlers registered here are called for
   * *every* push, including names this module does not know.
   */
  onPush(handler: PushHandler): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  /** Watch the end of the channel. Late subscribers are called immediately. */
  onClosed(handler: ClosedHandler): () => void {
    if (this.closed) {
      handler(this.closedMessage ?? "the helper channel closed");
      return () => undefined;
    }
    this.closedHandlers.add(handler);
    return () => this.closedHandlers.delete(handler);
  }

  /**
   * `helper_call`, narrowed: the reply is the raw JSON `Value` the helper sent
   * (snake_case keys, `*_b64` bytes). Prefer the typed wrappers below; this is
   * the escape hatch for an op a later phase adds.
   */
  async call<T = unknown>(op: HelperOp | string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await ipc.helperCall(this.id, op, args)) as T;
    } catch (e) {
      throw HelperError.from(e);
    }
  }

  // ---------------------------------------------------------------- fs

  async ping(): Promise<Ping> {
    const r = obj(await this.call("ping"));
    return {
      pong: true,
      version: str(r.version),
      pid: num(r.pid),
      ops: list(r.ops).map((op) => str(op)),
    };
  }

  async listDir(path: string): Promise<FsList> {
    const r = obj(await this.call("fs.list", { path_b64: encodePath(path) }));
    return {
      path: bytes(r.path_b64),
      parent: bytes(r.parent_b64),
      entries: list(r.entries).map((entry) => {
        const e = obj(entry);
        return {
          name: bytes(e.name_b64),
          kind: kind(e.kind),
          size: num(e.size),
          mtime: num(e.mtime),
          isSymlink: bool(e.is_symlink),
        };
      }),
      truncated: bool(r.truncated),
    };
  }

  async stat(path: string): Promise<FsStat> {
    const r = obj(await this.call("fs.stat", { path_b64: encodePath(path) }));
    return {
      path: bytes(r.path_b64),
      kind: kind(r.kind),
      size: num(r.size),
      mtime: num(r.mtime),
      mode: num(r.mode),
      isSymlink: bool(r.is_symlink),
    };
  }

  /**
   * Read a file, or a window of one. A remote file over 256 MiB, or one whose
   * head carries a NUL byte, comes back as a `too_large` / `binary`
   * `HelperError` rather than as mojibake.
   */
  async readFile(
    path: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<FsRead> {
    const args: Record<string, unknown> = { path_b64: encodePath(path) };
    if (opts.offset !== undefined) args.offset = opts.offset;
    if (opts.limit !== undefined) args.limit = opts.limit;
    const r = obj(await this.call("fs.read", args));
    return {
      data: bytes(r.data_b64),
      eof: bool(r.eof),
      size: num(r.size),
    };
  }

  // --------------------------------------------------------------- git

  async discoverGit(root: string): Promise<GitDiscover> {
    const r = obj(await this.call("git.discover", { root_b64: encodePath(root) }));
    return {
      path: bytes(r.path_b64),
      root: bytes(r.root_b64),
      gitDir: bytes(r.git_dir_b64),
      name: bytes(r.name_b64),
    };
  }

  async gitStatus(root: string): Promise<GitStatus> {
    const r = obj(await this.call("git.status", { root_b64: encodePath(root) }));
    return {
      path: bytes(r.path_b64),
      root: bytes(r.root_b64),
      branch: maybeBytes(r.branch_b64),
      oid: typeof r.oid === "string" ? r.oid : null,
      detached: bool(r.detached),
      initial: bool(r.initial),
      upstream: maybeBytes(r.upstream_b64),
      ahead: num(r.ahead),
      behind: num(r.behind),
      files: list(r.files).map((file) => {
        const f = obj(file);
        return {
          path: bytes(f.path_b64),
          origPath: maybeBytes(f.orig_path_b64),
          index: str(f.index),
          worktree: str(f.worktree),
          staged: bool(f.staged),
          status: fileStatus(f.status),
        };
      }),
      clean: bool(r.clean),
      truncated: bool(r.truncated),
    };
  }

  async gitBranches(root: string): Promise<GitBranches> {
    const r = obj(await this.call("git.branches", { root_b64: encodePath(root) }));
    return {
      root: bytes(r.root_b64),
      current: maybeBytes(r.current_b64),
      branches: list(r.branches).map((branch) => {
        const b = obj(branch);
        return {
          name: bytes(b.name_b64),
          full: bytes(b.full_b64),
          oid: str(b.oid),
          upstream: maybeBytes(b.upstream_b64),
          current: bool(b.current),
          remote: bool(b.remote),
        };
      }),
      truncated: bool(r.truncated),
    };
  }

  /**
   * `git diff`. `filesOnly` answers with the file list and no patch; the remote
   * sets `filesOnly` itself when the patch is over its 6 MiB budget, so a
   * caller must check the reply's own flag and not assume its request was
   * honoured.
   */
  async gitDiff(
    root: string,
    opts: { staged?: boolean; filesOnly?: boolean; path?: string } = {},
  ): Promise<GitDiff> {
    const args: Record<string, unknown> = { root_b64: encodePath(root) };
    if (opts.staged !== undefined) args.staged = opts.staged;
    if (opts.filesOnly !== undefined) args.files_only = opts.filesOnly;
    if (opts.path !== undefined) args.path_b64 = encodePath(opts.path);
    const r = obj(await this.call("git.diff", args));
    return {
      path: maybeBytes(r.path_b64),
      root: bytes(r.root_b64),
      staged: bool(r.staged),
      files: list(r.files).map((file) => {
        const f = obj(file);
        return {
          path: bytes(f.path_b64),
          origPath: maybeBytes(f.orig_path_b64),
          status: fileStatus(f.status),
        };
      }),
      truncated: bool(r.truncated),
      filesOnly: bool(r.files_only),
      diff: maybeBytes(r.diff_b64),
      binary: bool(r.binary),
    };
  }

  async gitLog(root: string, opts: { limit?: number; skip?: number } = {}): Promise<GitLog> {
    const args: Record<string, unknown> = { root_b64: encodePath(root) };
    if (opts.limit !== undefined) args.limit = opts.limit;
    if (opts.skip !== undefined) args.skip = opts.skip;
    const r = obj(await this.call("git.log", args));
    return {
      root: bytes(r.root_b64),
      limit: num(r.limit),
      skip: num(r.skip),
      commits: list(r.commits).map((commit) => {
        const c = obj(commit);
        return {
          hash: str(c.hash),
          short: str(c.short),
          author: bytes(c.author_b64),
          email: bytes(c.email_b64),
          authorDate: str(c.author_date),
          commitDate: str(c.commit_date),
          parents: list(c.parents).map((p) => str(p)),
          refs: maybeBytes(c.refs_b64),
          subject: bytes(c.subject_b64),
        };
      }),
      truncated: bool(r.truncated),
    };
  }

  // ------------------------------------------------------------- watch

  /** Idempotent on the remote: a repeat subscribe returns the existing id. */
  async subscribe(path: string, recursive = true): Promise<WatchSubscription> {
    const r = obj(
      await this.call("watch.subscribe", { path_b64: encodePath(path), recursive }),
    );
    return {
      subscription: num(r.subscription),
      path: bytes(r.path_b64),
      recursive: bool(r.recursive),
      already: bool(r.already),
      gitDir: maybeBytes(r.git_dir_b64),
    };
  }

  /** One of `subscription` / `path` is required, or the remote says so. */
  async unsubscribe(opts: {
    subscription?: number;
    path?: string;
  }): Promise<{ removed: number }> {
    const args: Record<string, unknown> = {};
    if (opts.subscription !== undefined) args.subscription = opts.subscription;
    if (opts.path !== undefined) args.path_b64 = encodePath(opts.path);
    const r = obj(await this.call("watch.unsubscribe", args));
    return { removed: num(r.removed) };
  }

  /** Ask the remote to leave its serving loop. The reply precedes the hang-up. */
  async shutdown(): Promise<{ bye: boolean }> {
    const r = obj(await this.call("shutdown"));
    return { bye: bool(r.bye) };
  }

  // -------------------------------------------------------------- close

  /**
   * Close the channel. Idempotent: a second call, and a call after the remote
   * already hung up, both resolve. A rejection is swallowed for the same
   * reason — there is nothing left for the caller to do about it, and a
   * cleanup path must not throw.
   */
  async close(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      await ipc.helperClose(this.id);
    } catch {
      // The session is gone either way; `helper_close` on an unknown id is not
      // an error on the backend either.
    } finally {
      this.markClosed("this side closed the helper channel");
    }
  }

  /** Called by `openHelper` — never by a caller. */
  deliver(event: HelperEvent): void {
    if (event.kind === "push") {
      for (const handler of [...this.pushHandlers]) {
        handler({ event: event.event, data: event.data });
      }
      return;
    }
    this.markClosed(event.message);
  }

  private markClosed(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedMessage = message;
    for (const handler of [...this.closedHandlers]) handler(message);
    this.closedHandlers.clear();
  }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export interface HelperHandlers {
  onPush?: PushHandler;
  onClosed?: ClosedHandler;
}

/**
 * Open a helper channel to `host`, or reject with a `HelperError` of kind
 * `open`.
 *
 * The channel is handed to `helper_open` before it is called, so a push that
 * races the reply is not lost. Handlers may also be registered afterwards with
 * `connection.onPush` / `connection.onClosed`, which is what a component that
 * mounts into an already-open connection wants.
 */
export async function openHelper(
  host: string,
  handlers: HelperHandlers = {},
): Promise<HelperConnection> {
  const channel = new Channel<HelperEvent>();
  let connection: HelperConnection | null = null;
  // Buffered, not dropped: a push can arrive in the same tick as the open
  // reply, before `connection` exists.
  const early: HelperEvent[] = [];
  channel.onmessage = (event) => {
    if (connection) connection.deliver(event);
    else early.push(event);
  };

  let opened: HelperOpen;
  try {
    opened = await ipc.helperOpen({ host, onEvent: channel });
  } catch (e) {
    throw HelperError.from(e);
  }

  connection = new HelperConnection(host, opened);
  if (handlers.onPush) connection.onPush(handlers.onPush);
  if (handlers.onClosed) connection.onClosed(handlers.onClosed);
  for (const event of early) connection.deliver(event);
  return connection;
}

/**
 * What to tell the user about the channel's mode: the fallback's own bilingual
 * sentence, or `null` when the native helper is in place.
 *
 * A UI that renders nothing for `null` is exactly right — the native path is
 * the expected one, and the notice exists for the other one.
 */
export function helperFallbackNotice(mode: HelperMode, lang: Lang): string | null {
  return mode.kind === "script_fallback" ? pick(mode.reason.message, lang) : null;
}

/** Narrow a push's `data` when the name is `fs.changed`. */
export function asFsChanged(event: { event: string; data: unknown }): FsChanged | null {
  if (event.event !== "fs.changed") return null;
  const d = obj(event.data);
  const kindValue = d.kind;
  return {
    subscription: num(d.subscription),
    root: bytes(d.root_b64),
    path: bytes(d.path_b64),
    kind:
      kindValue === "created" ||
      kindValue === "removed" ||
      kindValue === "renamed" ||
      kindValue === "modified"
        ? kindValue
        : "other",
  };
}

/** Narrow a push's `data` when the name is `git.changed`. */
export function asGitChanged(event: { event: string; data: unknown }): GitChanged | null {
  if (event.event !== "git.changed") return null;
  const d = obj(event.data);
  return { subscription: num(d.subscription), root: bytes(d.root_b64) };
}

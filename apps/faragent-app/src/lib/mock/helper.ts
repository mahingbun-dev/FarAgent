/**
 * The helper channel's mock: a small *virtual remote*, not a table of canned
 * replies.
 *
 * A panel that reads a canned reply cannot tell a bug in itself from a bug in
 * the fixture, and a fixture that always succeeds cannot show the panel's error
 * path at all. So this module models a filesystem and three git repositories
 * and answers `fs.*` / `git.*` from them, honouring the same caps, error codes
 * and reply shapes as `faragent_helper` — including the ones that only appear
 * under pressure:
 *
 * | what a panel task needs to see | where it lives |
 * | --- | --- |
 * | a multi-level directory tree | `/srv/app` — five levels, a symlink, a `.github/workflows` |
 * | a file over 1 MiB | `/var/log/faragent/huge.log` (1.5 MiB) |
 * | a binary file | `/srv/app/docs/img/logo.png` — `fs.read` answers `binary` |
 * | a directory that is not a repository | `/srv/scratch` — `git.discover` answers `not_a_repo` |
 * | a repository with uncommitted changes | `/srv/data` — every status letter, staged and not |
 * | a diff over 500 files | `/srv/monorepo` — 620 changed files, so the list itself is capped |
 *
 * Three hosts, so all three `helper_open` outcomes are reachable from the host
 * switcher: `build-01.farm.internal` is native, `gpu-box` is the script
 * fallback (with a real reason), and `win-builder` fails the way the backend
 * fails it.
 *
 * Everything here is data and pure logic: no `window`, no timers other than the
 * macrotask that delivers a push. `handlers.ts` registers the three commands;
 * `channel.ts` carries the events.
 */
import { b64ToBytes, bytesToB64 } from "../bytes.ts";
import { channelId, emit, forgetChannel } from "./channel.ts";
import type { MockHandler } from "./handlers.ts";

// ---------------------------------------------------------------------------
// The protocol's own numbers, restated
// ---------------------------------------------------------------------------

/** `faragent_helper::proto` and `::ops::git`, byte for byte. */
const MAX_LIST_ENTRIES = 500;
const MAX_PATCH_BYTES = 6 * 1024 * 1024;
const DEFAULT_READ_LIMIT = 256 * 1024;
const MAX_READ_CHUNK = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_LOG_LIMIT = 50;

/** `faragent_helper::ops::OPS`, in the same order. */
const HELPER_OPS = [
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

/** Deliver a push on a macrotask, the way a real stream would arrive. */
const MACROTASK = 0;

// ---------------------------------------------------------------------------
// Errors, as the wire spells them
// ---------------------------------------------------------------------------

type RemoteCode =
  | "bad_request"
  | "not_found"
  | "not_a_dir"
  | "unreadable"
  | "too_large"
  | "binary"
  | "not_a_repo"
  | "git_failed"
  | "internal";

/**
 * Reject with exactly what `HelperError::Remote` serializes to. Thrown (not
 * returned) so `invoke` rejects, which is what the real command does.
 */
function protocolError(code: RemoteCode, message: string): never {
  throw { kind: "remote", code, message };
}

/** `HelperError::Disconnected`: there is no session to ask. */
function disconnected(message: string): never {
  throw { kind: "disconnected", message };
}

// ---------------------------------------------------------------------------
// A virtual filesystem
// ---------------------------------------------------------------------------

type VNode =
  | { kind: "dir"; mtime: number; mode: number }
  | { kind: "symlink"; mtime: number; mode: number; target: string }
  | { kind: "file"; mtime: number; mode: number; file: VirtualFile };

/** Bytes built on first read: the 1.5 MiB log must not cost anything until asked. */
class VirtualFile {
  private readonly make: () => Uint8Array;
  private cached: Uint8Array | null = null;

  // Not a TS parameter property: `node --test` strips types rather than
  // compiling them, and a parameter property is the one class syntax it refuses.
  constructor(make: () => Uint8Array) {
    this.make = make;
  }

  get bytes(): Uint8Array {
    this.cached ??= this.make();
    return this.cached;
  }

  get size(): number {
    return this.bytes.length;
  }
}

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;
const LINK_MODE = 0o777;

/** A fixed clock: a fixture that drifted would make every screenshot differ. */
const NOW = Date.UTC(2026, 8, 14, 9, 0, 0) / 1000;

const nodes = new Map<string, VNode>();

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** `/a//b/./c` and `/a/b/../b/c` are the same path; so are `/` and `//`. */
function normalise(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

/** The `..` of a path, `faragent_helper::ops::fs::parent_dir`'s convention. */
function parentOf(path: string): string {
  if (path === "/") return "/";
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function ensureDir(path: string): void {
  const at = normalise(path);
  if (nodes.has(at)) return;
  if (at !== "/") ensureDir(parentOf(at));
  nodes.set(at, { kind: "dir", mtime: NOW, mode: DIR_MODE });
}

function addDir(path: string): void {
  ensureDir(path);
}

function addFile(path: string, make: () => Uint8Array, mtime = NOW): void {
  const at = normalise(path);
  ensureDir(parentOf(at));
  nodes.set(at, { kind: "file", mtime, mode: FILE_MODE, file: new VirtualFile(make) });
}

function addLink(path: string, target: string): void {
  const at = normalise(path);
  ensureDir(parentOf(at));
  nodes.set(at, { kind: "symlink", mtime: NOW, mode: LINK_MODE, target });
}

/** The path a chain of symlinks leads to, resolved like the helper resolves it. */
function resolvePath(path: string): string {
  let at = normalise(path);
  for (let hops = 0; hops < 8; hops++) {
    const node = nodes.get(at);
    if (!node || node.kind !== "symlink") return at;
    at = normalise(node.target);
  }
  return at;
}

/** The node a path names, following symlinks — what `fs.read`/`fs.list` do. */
function follow(path: string): VNode | undefined {
  return nodes.get(resolvePath(path));
}

/** Direct children of a directory, sorted by name the way the helper sorts. */
function children(dir: string): Array<[string, VNode]> {
  const prefix = dir === "/" ? "/" : dir + "/";
  const out: Array<[string, VNode]> = [];
  for (const [key, node] of nodes) {
    if (!key.startsWith(prefix) || key === dir) continue;
    const rest = key.slice(prefix.length);
    if (rest.includes("/")) continue;
    out.push([rest, node]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// A virtual git
// ---------------------------------------------------------------------------

type Record1 = "1" | "2" | "u" | "?";

/** One porcelain v2 file record. `x`/`y` are the XY letters, `.` = unchanged. */
interface Dirty {
  path: string;
  /** `2` records only: the path the entry was renamed/copied from. */
  orig?: string;
  record: Record1;
  x: string;
  y: string;
  /** The patch this file contributes looks like a binary diff. */
  binary?: boolean;
}

interface BranchSeed {
  name: string;
  oid: string;
  upstream: string | null;
  current: boolean;
  remote: boolean;
}

interface Repo {
  root: string;
  branch: string | null;
  oid: string | null;
  detached: boolean;
  initial: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: Dirty[];
  branches: BranchSeed[];
  /** How many synthetic commits `git.log` can page through. */
  commits: number;
}

const repos = new Map<string, Repo>();

/** `git`'s `letter_status`, mirrored: the XY pair as the word a UI shows. */
function statusOf(dirty: Dirty): string {
  if (dirty.record === "u") return "conflicted";
  if (dirty.record === "?") return "untracked";
  const letter = dirty.x !== "." && dirty.x !== "?" ? dirty.x : dirty.y;
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    default:
      return "modified";
  }
}

/** `discover`: walk up until a directory holds a `.git`. */
function discover(start: string): Repo {
  let at = normalise(start);
  if (nodes.get(at)?.kind === "file") at = parentOf(at);
  for (;;) {
    if (nodes.has(at + "/.git")) {
      const repo = repos.get(at);
      if (repo) return repo;
    }
    if (at === "/") break;
    at = parentOf(at);
  }
  return protocolError(
    "not_a_repo",
    `no git repository at or above ${normalise(start)}`,
  );
}

// ---------------------------------------------------------------------------
// The fixture world
// ---------------------------------------------------------------------------

const APP = "/srv/app";
const DATA = "/srv/data";
const MONO = "/srv/monorepo";

function pngBytes(): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(1536);
  out.set(signature, 0);
  // Deterministic noise. `i = 256` lands on a NUL byte, which is what the
  // helper's `looks_binary` sniffs for.
  for (let i = signature.length; i < out.length; i++) out[i] = (i * 31) & 0xff;
  return out;
}

function hugeLog(): Uint8Array {
  const one = textBytes(
    "2026-09-14T09:00:00Z  faragent-helper  INFO  frame written id=000420 op=fs.list bytes=18432\n",
  );
  const count = Math.ceil((1536 * 1024) / one.length);
  const out = new Uint8Array(one.length * count);
  for (let i = 0; i < count; i++) out.set(one, i * one.length);
  return out;
}

/** A 40-hex-character object name, deterministic in its seed. */
function oidOf(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = ((h1 ^ seed.charCodeAt(i)) * 16777619) >>> 0;
    h2 = ((h2 + seed.charCodeAt(i) * (i + 7)) * 2654435761) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 5; i++) {
    h1 = (h1 * 16777619) >>> 0;
    h2 = (h2 * 2654435761) >>> 0;
    out += (h1 ^ h2).toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

function seedFilesystem(): void {
  ensureDir("/");

  // --- the tree the file browser is built against: five levels, a symlink,
  // a dot-directory, and one binary file.
  addDir(APP);
  addFile(`${APP}/README.md`, () =>
    textBytes("# FarAgent\n\nThe desktop app for agents on remote machines.\n"),
  );
  addFile(`${APP}/Cargo.toml`, () =>
    textBytes('[workspace]\nresolver = "3"\nmembers = ["apps/*", "crates/*"]\n'),
  );
  addFile(`${APP}/.github/workflows/ci.yml`, () =>
    textBytes("name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n"),
  );
  addFile(`${APP}/docs/README.md`, () =>
    textBytes("## docs\n\n- helper channel\n- sessions\n"),
  );
  addFile(`${APP}/docs/img/logo.png`, pngBytes);
  addFile(`${APP}/scripts/build.sh`, () =>
    textBytes("#!/usr/bin/env bash\nset -euo pipefail\ncargo build --release\n"),
  );
  addFile(`${APP}/src/main.rs`, () =>
    textBytes('fn main() {\n    println!("faragent");\n}\n'),
  );
  addFile(`${APP}/src/lib/helper/mod.rs`, () =>
    textBytes("pub mod proto;\npub mod ops;\npub mod watch;\n"),
  );
  addFile(`${APP}/src/lib/helper/proto.rs`, () =>
    textBytes("//! the single protocol definition\npub const MAX_FRAME_BYTES: usize = 8 << 20;\n"),
  );
  addFile(`${APP}/src/lib/helper/watch.rs`, () =>
    textBytes("//! push subscriptions\npub const GIT_POLL_INTERVAL_MS: u64 = 2_000;\n"),
  );
  addFile(`${APP}/src/components/tree.tsx`, () =>
    textBytes("export function Tree() {\n  return null;\n}\n"),
  );
  addLink(`${APP}/target`, `${APP}/out`);

  // --- a directory that is not a repository, for `not_a_repo`
  addFile("/srv/scratch/notes.md", () => textBytes("scratch notes\n"));
  addFile("/srv/scratch/data.csv", () => textBytes("id,name\n1,alpha\n2,beta\n"));
  addFile("/srv/scratch/raw/scan-0001.txt", () => textBytes("raw scan 1\n"));

  // --- 1.5 MiB, over the helper's 1 MiB preview budget in spirit and over any
  // sane editor's in practice
  addFile("/var/log/faragent/huge.log", hugeLog);
  addFile("/var/log/faragent/app.log", () =>
    textBytes("2026-09-14T09:00:00Z  INFO  helper channel opened\n"),
  );

  // --- the dirty repository
  addFile(`${DATA}/src/app.rs`, () => textBytes("fn app() {}\n"));
  addFile(`${DATA}/src/lib.rs`, () => textBytes("pub mod app;\n"));
  addFile(`${DATA}/src/moved.rs`, () => textBytes("// moved\n"));
  addFile(`${DATA}/src/copied.rs`, () => textBytes("// copied\n"));
  addFile(`${DATA}/src/conflict.rs`, () =>
    textBytes("<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> theirs\n"),
  );
  addFile(`${DATA}/src/touched.rs`, () => textBytes("// touched\n"));
  addFile(`${DATA}/src/also.rs`, () => textBytes("// also\n"));
  addFile(`${DATA}/docs/guide.md`, () => textBytes("## guide\n"));
  addFile(`${DATA}/assets/logo.png`, pngBytes);
  addFile(`${DATA}/dist/bundle.js`, () => textBytes("// built\n"));
  addFile(`${DATA}/notes.txt`, () => textBytes("scratch\n"));

  // --- 620 changed files: more than the helper's 500-entry list cap, so the
  // *truncation* path is what a panel sees here, exactly as it would live.
  addFile(`${MONO}/README.md`, () => textBytes("# monorepo\n"));
  for (let i = 0; i < 620; i++) {
    const pkg = `pkg-${String(i).padStart(3, "0")}`;
    addFile(`${MONO}/packages/${pkg}/src/index.ts`, () =>
      textBytes(`export const name = "${pkg}";\n`),
    );
  }
}

function seedRepos(): void {
  const cleanBranches: BranchSeed[] = [
    { name: "main", oid: oidOf(`${APP}:main`), upstream: "origin/main", current: true, remote: false },
    { name: "feature/helper-panel", oid: oidOf(`${APP}:feature`), upstream: null, current: false, remote: false },
    { name: "release/0.2", oid: oidOf(`${APP}:release`), upstream: "origin/release/0.2", current: false, remote: false },
    { name: "origin/main", oid: oidOf(`${APP}:origin-main`), upstream: null, current: false, remote: true },
    { name: "origin/release/0.2", oid: oidOf(`${APP}:origin-release`), upstream: null, current: false, remote: true },
  ];

  repos.set(APP, {
    root: APP,
    branch: "main",
    oid: oidOf(`${APP}:main`),
    detached: false,
    initial: false,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    dirty: [],
    branches: cleanBranches,
    commits: 47,
  });

  // Every status letter, both sides, plus an untracked and an unmerged record.
  const dirty: Dirty[] = [
    { path: "src/app.rs", record: "1", x: ".", y: "M" },
    { path: "src/lib.rs", record: "1", x: "M", y: "." },
    { path: "docs/guide.md", record: "1", x: "M", y: "M" },
    { path: "assets/icon.svg", record: "1", x: "A", y: "." },
    { path: "old/legacy.rs", record: "1", x: "D", y: "." },
    { path: "dist/bundle.js", record: "1", x: ".", y: "D" },
    { path: "bin/tool", record: "1", x: "T", y: "." },
    { path: "assets/logo.png", record: "1", x: ".", y: "M", binary: true },
    { path: "src/moved.rs", record: "2", x: "R", y: ".", orig: "src/renamed-from.rs" },
    { path: "src/copied.rs", record: "2", x: "C", y: ".", orig: "src/moved.rs" },
    { path: "src/conflict.rs", record: "u", x: "U", y: "U" },
    { path: "src/touched.rs", record: "1", x: ".", y: "M" },
    { path: "src/also.rs", record: "1", x: ".", y: "M" },
    { path: "notes.txt", record: "?", x: "?", y: "?" },
  ];

  repos.set(DATA, {
    root: DATA,
    branch: "main",
    oid: oidOf(`${DATA}:main`),
    detached: false,
    initial: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty,
    branches: [
      { name: "main", oid: oidOf(`${DATA}:main`), upstream: null, current: true, remote: false },
      { name: "wip/import", oid: oidOf(`${DATA}:wip`), upstream: null, current: false, remote: false },
      { name: "origin/main", oid: oidOf(`${DATA}:origin`), upstream: null, current: false, remote: true },
    ],
    commits: 9,
  });

  const monoDirty: Dirty[] = [];
  for (let i = 0; i < 620; i++) {
    const pkg = `pkg-${String(i).padStart(3, "0")}`;
    // Mostly unstaged, so the *unstaged* diff is itself over the 500-entry cap
    // — a fixture whose diff fit under the cap would never exercise the
    // truncation path a panel has to render. One in eight is staged, so the two
    // sides are not the same list.
    monoDirty.push(
      i % 8 === 0
        ? { path: `packages/${pkg}/src/index.ts`, record: "1", x: "M", y: "." }
        : { path: `packages/${pkg}/src/index.ts`, record: "1", x: ".", y: "M" },
    );
  }

  repos.set(MONO, {
    root: MONO,
    branch: "main",
    oid: oidOf(`${MONO}:main`),
    detached: false,
    initial: false,
    upstream: "origin/main",
    ahead: 620,
    behind: 0,
    dirty: monoDirty,
    branches: [
      { name: "main", oid: oidOf(`${MONO}:main`), upstream: "origin/main", current: true, remote: false },
      { name: "origin/main", oid: oidOf(`${MONO}:origin`), upstream: null, current: false, remote: true },
    ],
    commits: 1284,
  });

  // A `.git` in each repository root, so `discover` finds them. `HEAD` and
  // `index` exist because they are what a watcher would be polling.
  for (const root of repos.keys()) {
    addFile(`${root}/.git/HEAD`, () => textBytes("ref: refs/heads/main\n"));
    addFile(`${root}/.git/index`, () => textBytes("DIRC\x00\x00\x00\x02"));
  }
}

seedFilesystem();
seedRepos();

// ---------------------------------------------------------------------------
// fs.*
// ---------------------------------------------------------------------------

function wire(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/** A required `*_b64` path, decoded. */
function requiredPath(args: Record<string, unknown>, key: string): string {
  const encoded = wire(args, key);
  if (encoded === "") {
    return protocolError("bad_request", `\`${key}\` is required`);
  }
  try {
    return normalise(new TextDecoder().decode(b64ToBytes(encoded)));
  } catch {
    return protocolError("bad_request", `\`${key}\` is not valid base64`);
  }
}

function b64Of(path: string): string {
  return bytesToB64(textBytes(path));
}

function optionalU64(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function optionalBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function opFsList(args: Record<string, unknown>): unknown {
  const path = requiredPath(args, "path_b64");
  if (!nodes.has(path)) {
    return protocolError("not_found", `no such file or directory: ${path}`);
  }
  // A symlinked directory lists like `ls` would: follow the link, and read the
  // children of what it points at.
  const dir = resolvePath(path);
  if (nodes.get(dir)?.kind !== "dir") {
    return protocolError("not_a_dir", `not a directory: ${path}`);
  }
  const all = children(dir);
  const truncated = all.length > MAX_LIST_ENTRIES;
  const entries = all.slice(0, MAX_LIST_ENTRIES).map(([name, child]) => ({
    name_b64: b64Of(name),
    kind: child.kind,
    size: child.kind === "file" ? child.file.size : 0,
    mtime: child.mtime,
    is_symlink: child.kind === "symlink",
  }));
  return {
    path_b64: b64Of(path),
    parent_b64: b64Of(parentOf(path)),
    entries,
    truncated,
  };
}

function opFsStat(args: Record<string, unknown>): unknown {
  const path = requiredPath(args, "path_b64");
  const node = nodes.get(path);
  if (!node) return protocolError("not_found", `no such file or directory: ${path}`);
  return {
    path_b64: b64Of(path),
    kind: node.kind,
    size: node.kind === "file" ? node.file.size : 0,
    mtime: node.mtime,
    mode: node.mode,
    is_symlink: node.kind === "symlink",
  };
}

function opFsRead(args: Record<string, unknown>): unknown {
  const path = requiredPath(args, "path_b64");
  const node = follow(path);
  if (!node) return protocolError("not_found", `no such file or directory: ${path}`);
  if (node.kind !== "file") {
    return protocolError("not_a_dir", `not a regular file: ${path}`);
  }
  const size = node.file.size;
  if (size > MAX_FILE_BYTES) {
    return protocolError(
      "too_large",
      `${path} is ${size} bytes, more than the ${MAX_FILE_BYTES} byte preview limit`,
    );
  }
  const all = node.file.bytes;
  // The helper sniffs the *head* of the file, not the requested chunk.
  const sniff = all.subarray(0, Math.min(8192, size));
  if (sniff.includes(0)) {
    return protocolError("binary", `${path} is a binary file (${size} bytes)`);
  }
  const offset = Math.min(optionalU64(args, "offset") ?? 0, size);
  const limit = Math.min(
    Math.max(optionalU64(args, "limit") ?? DEFAULT_READ_LIMIT, 1),
    MAX_READ_CHUNK,
  );
  const chunk = all.subarray(offset, Math.min(offset + limit, size));
  return {
    data_b64: bytesToB64(chunk),
    eof: offset + chunk.length >= size,
    size,
  };
}

// ---------------------------------------------------------------------------
// git.*
// ---------------------------------------------------------------------------

function dirtyWire(file: Dirty): unknown {
  const staged = file.x !== "." && file.x !== "?";
  return {
    path_b64: b64Of(file.path),
    orig_path_b64: file.orig === undefined ? null : b64Of(file.orig),
    index: file.x,
    worktree: file.y,
    staged,
    status: statusOf(file),
  };
}

function opGitDiscover(args: Record<string, unknown>): unknown {
  const asked = requiredPath(args, "root_b64");
  const repo = discover(asked);
  const name = repo.root.slice(repo.root.lastIndexOf("/") + 1);
  return {
    path_b64: b64Of(asked),
    root_b64: b64Of(repo.root),
    git_dir_b64: b64Of(`${repo.root}/.git`),
    name_b64: b64Of(name),
  };
}

function opGitStatus(args: Record<string, unknown>): unknown {
  const asked = requiredPath(args, "root_b64");
  const repo = discover(asked);
  const truncated = repo.dirty.length > MAX_LIST_ENTRIES;
  const files = repo.dirty.slice(0, MAX_LIST_ENTRIES).map(dirtyWire);
  return {
    path_b64: b64Of(asked),
    root_b64: b64Of(repo.root),
    branch_b64: repo.branch === null ? null : b64Of(repo.branch),
    oid: repo.oid,
    detached: repo.detached,
    initial: repo.initial,
    upstream_b64: repo.upstream === null ? null : b64Of(repo.upstream),
    ahead: repo.ahead,
    behind: repo.behind,
    files,
    // A truncated list is not a clean tree — the helper is explicit about it.
    clean: files.length === 0 && !truncated,
    truncated,
  };
}

function opGitBranches(args: Record<string, unknown>): unknown {
  const asked = requiredPath(args, "root_b64");
  const repo = discover(asked);
  const truncated = repo.branches.length > MAX_LIST_ENTRIES;
  const branches = repo.branches.slice(0, MAX_LIST_ENTRIES).map((branch) => ({
    name_b64: b64Of(branch.name),
    full_b64: b64Of(`refs/heads/${branch.name}`),
    oid: branch.oid,
    upstream_b64: branch.upstream === null ? null : b64Of(branch.upstream),
    current: branch.current,
    remote: branch.remote,
  }));
  const current = repo.branches.find((branch) => branch.current);
  return {
    root_b64: b64Of(repo.root),
    current_b64: current === undefined ? null : b64Of(current.name),
    branches,
    truncated,
  };
}

/** The files a diff of one side would name, capped the way the helper caps it. */
function diffFiles(repo: Repo, staged: boolean, path: string | null): Dirty[] {
  const side = repo.dirty.filter((file) => {
    if (file.record === "?") return false; // `git diff` never shows untracked files
    return staged ? file.x !== "." && file.x !== "?" : file.y !== ".";
  });
  if (path === null) return side;
  return side.filter((file) => file.path === path || file.path.startsWith(path + "/"));
}

/** One file's contribution to a patch, in git's own spelling. */
function patchFor(repo: Repo, file: Dirty): string {
  const shown = file.path;
  const from = file.orig ?? file.path;
  const lines: string[] = [`diff --git a/${from} b/${shown}`];
  if (file.record === "2") {
    lines.push("similarity index 97%", `rename from ${from}`, `rename to ${shown}`);
    return lines.join("\n") + "\n";
  }
  lines.push("index 1a2b3c4..5d6e7f8 100644");
  if (file.binary) {
    lines.push(`Binary files a/${shown} and b/${shown} differ`);
    return lines.join("\n") + "\n";
  }
  const added = file.x === "A";
  const deleted = file.y === "D";
  lines.push(
    added ? "new file mode 100644" : deleted ? "deleted file mode 100644" : "--- a/" + shown,
  );
  if (added) lines.push(`--- /dev/null`, `+++ b/${shown}`);
  else if (deleted) lines.push(`--- a/${shown}`, `+++ /dev/null`);
  else lines.push(`+++ b/${shown}`);
  lines.push(
    "@@ -1,4 +1,5 @@",
    ` // ${repo.root}`,
    "-const before = true;",
    "+const before = false;",
    "+const extra = 1;",
    " export {};",
  );
  return lines.join("\n") + "\n";
}

function opGitDiff(args: Record<string, unknown>): unknown {
  const asked = requiredPath(args, "root_b64");
  const repo = discover(asked);
  const staged = optionalBool(args, "staged") ?? false;
  const filesOnly = optionalBool(args, "files_only") ?? false;
  const path = optionalString(args, "path_b64") === undefined
    ? null
    : normalise(new TextDecoder().decode(b64ToBytes(wire(args, "path_b64"))));

  const all = diffFiles(repo, staged, path);
  const truncated = all.length > MAX_LIST_ENTRIES;
  const kept = all.slice(0, MAX_LIST_ENTRIES);
  const files = kept.map((file) => ({
    path_b64: b64Of(file.path),
    orig_path_b64: file.orig === undefined ? null : b64Of(file.orig),
    status: statusOf(file),
  }));
  const binary = kept.some((file) => file.binary === true);

  // The same budget the helper uses: a patch too big to deliver is not an
  // error, it is a file list with `files_only` set.
  let patch: string | null = null;
  if (!filesOnly) {
    patch = "";
    for (const file of kept) {
      patch += patchFor(repo, file);
      if (patch.length > MAX_PATCH_BYTES) {
        patch = null;
        break;
      }
    }
  }
  return {
    path_b64: path === null ? null : b64Of(path),
    root_b64: b64Of(repo.root),
    staged,
    files,
    truncated,
    files_only: filesOnly || patch === null,
    diff_b64: patch === null ? null : b64Of(patch),
    binary,
  };
}

const LOG_SUBJECTS = [
  "helper: match replies to their caller by id",
  "helper: forward watch pushes over the channel",
  "helper: refuse a Windows remote instead of degrading",
  "fs: keep a path's bytes instead of a lossy string",
  "git: cap a file list at 500 and say so",
  "watch: poll .git/HEAD as well as the tree",
  "app: lease the helper connection across remounts",
  "docs: one protocol definition, no second framing",
];

function opGitLog(args: Record<string, unknown>): unknown {
  const asked = requiredPath(args, "root_b64");
  const repo = discover(asked);
  const limit = Math.min(
    Math.max(optionalU64(args, "limit") ?? DEFAULT_LOG_LIMIT, 1),
    MAX_LIST_ENTRIES,
  );
  const skip = optionalU64(args, "skip") ?? 0;
  const end = Math.min(skip + limit, repo.commits);
  const commits = [];
  for (let i = skip; i < end; i++) {
    const hash = oidOf(`${repo.root}:commit:${i}`);
    commits.push({
      hash,
      short: hash.slice(0, 7),
      author_b64: b64Of("Deploy Bot"),
      email_b64: b64Of("deploy@farm.internal"),
      author_date: new Date((NOW - i * 3600) * 1000).toISOString(),
      commit_date: new Date((NOW - i * 3600) * 1000).toISOString(),
      parents: i + 1 < repo.commits ? [oidOf(`${repo.root}:commit:${i + 1}`)] : [],
      refs_b64: i === 0 && repo.branch !== null ? b64Of(`HEAD -> ${repo.branch}`) : null,
      subject_b64: b64Of(LOG_SUBJECTS[i % LOG_SUBJECTS.length]),
    });
  }
  return {
    root_b64: b64Of(repo.root),
    limit,
    skip,
    commits,
    truncated: end < repo.commits,
  };
}

// ---------------------------------------------------------------------------
// Sessions, watch subscriptions, and the three commands
// ---------------------------------------------------------------------------

interface FallbackText {
  code: string;
  message: { zh: string; en: string };
}

type MockMode = { kind: "native" } | { kind: "script_fallback"; reason: FallbackText };

/** `FallbackReason::NoChecksumTool { os: "Linux" }`, sentence for sentence. */
const NO_CHECKSUM_TOOL: FallbackText = {
  code: "no_checksum_tool",
  message: {
    zh: "远端（Linux）缺少 sha256sum / shasum，无法校验上传，改用脚本模式。",
    en: "the remote (Linux) has neither sha256sum nor shasum, so the upload cannot be verified; using the script mode.",
  },
};

interface Session {
  id: number;
  host: string;
  mode: MockMode;
  /** The id pushes are delivered under, or `null` for a caller with no channel. */
  channel: number | null;
  live: boolean;
  subs: Map<number, { path: string; recursive: boolean; gitDir: string | null }>;
  nextSub: number;
}

const sessions = new Map<number, Session>();
let nextSessionId = 0;

function modeFor(host: string): MockMode {
  if (host === "gpu-box") {
    return { kind: "script_fallback", reason: NO_CHECKSUM_TOOL };
  }
  return { kind: "native" };
}

function opOpen(args: Record<string, unknown>): unknown {
  const host = wire(args, "host");
  if (host === "") {
    throw { kind: "plain", message: "mock: `host` is required" };
  }
  if (host === "win-builder") {
    // Exactly what `helper.rs` refuses a Windows remote with: the framed
    // channel is POSIX-only, and there is no second dialect of *this* protocol.
    throw {
      kind: "plain",
      message:
        "the remote is Windows: the helper upload channel is POSIX-only; using the script mode.",
    };
  }
  if (host !== "build-01.farm.internal" && host !== "gpu-box") {
    throw { kind: "plain", message: `mock: no route to host "${host}"` };
  }
  // One live channel per host, the same way `helper.rs` has one `CommandStream`
  // per host: a second `open` replaces the first rather than leaking it.
  for (const session of [...sessions.values()]) {
    if (session.host === host) {
      closeSession(session.id, "the connection was replaced by a new one");
    }
  }
  const id = ++nextSessionId;
  const mode = modeFor(host);
  sessions.set(id, {
    id,
    host,
    mode,
    channel: channelId(args.onEvent),
    live: true,
    subs: new Map(),
    nextSub: 0,
  });
  return { id, mode, native: mode.kind === "native" };
}

/** A session's channel, or a throw when the caller is not listening. */
function channelOf(id: number): number | null {
  const session = sessions.get(id);
  if (!session || !session.live) return null;
  return session.channel;
}

function push(sessionId: number, event: string, data: unknown): void {
  const channel = channelOf(sessionId);
  if (channel === null) return;
  setTimeout(() => emit(channel, { kind: "push", event, data }), MACROTASK);
}

function opCall(args: Record<string, unknown>): unknown {
  const id = optionalU64(args, "id");
  const session = id === undefined ? undefined : sessions.get(id);
  if (!session || !session.live) {
    return disconnected(`no helper session ${String(args.id)} is open`);
  }
  const op = wire(args, "op");
  if (op === "") return protocolError("bad_request", "`op` is required");
  const raw = args.args;
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return protocolError("bad_request", "`args` must be a JSON object");
  }
  const params = (raw ?? {}) as Record<string, unknown>;

  switch (op) {
    case "ping":
      return { pong: true, version: "0.2.0", pid: 4242, ops: HELPER_OPS };
    case "fs.list":
      return opFsList(params);
    case "fs.read":
      return opFsRead(params);
    case "fs.stat":
      return opFsStat(params);
    case "git.discover":
      return opGitDiscover(params);
    case "git.status":
      return opGitStatus(params);
    case "git.branches":
      return opGitBranches(params);
    case "git.diff":
      return opGitDiff(params);
    case "git.log":
      return opGitLog(params);
    case "watch.subscribe":
      return opSubscribe(session, params);
    case "watch.unsubscribe":
      return opUnsubscribe(session, params);
    case "shutdown":
      // The real helper writes the reply, then leaves the loop, so the caller
      // sees the answer and *then* the pipe close.
      setTimeout(() => closeSession(session.id, "the remote closed the helper channel"), MACROTASK);
      return { bye: true };
    default:
      return protocolError(
        "bad_request",
        `unknown op \`${op}\`; this helper speaks: ${HELPER_OPS.join(", ")}`,
      );
  }
}

function opSubscribe(session: Session, params: Record<string, unknown>): unknown {
  const path = requiredPath(params, "path_b64");
  const recursive = optionalBool(params, "recursive") ?? true;
  const node = follow(path);
  if (!node) return protocolError("not_found", `no such file or directory: ${path}`);
  if (node.kind !== "dir") {
    return protocolError("unreadable", `cannot watch ${path}: not a directory`);
  }
  for (const [id, sub] of session.subs) {
    if (sub.path === path && sub.recursive === recursive) {
      return {
        subscription: id,
        path_b64: b64Of(path),
        recursive,
        already: true,
        git_dir_b64: sub.gitDir === null ? null : b64Of(sub.gitDir),
      };
    }
  }
  let gitDir: string | null = null;
  try {
    const repo = discover(path);
    gitDir = `${repo.root}/.git`;
  } catch {
    // Not a repository: a plain directory watch. Not an error.
    gitDir = null;
  }
  const id = ++session.nextSub;
  session.subs.set(id, { path, recursive, gitDir });

  // There is no real filesystem to change, so the mock reports the one change a
  // caller can be sure a fresh subscription would see: the watched tree is
  // live. Which mechanism fires depends on whether there is a repository to
  // poll — the same split the real helper has.
  if (gitDir === null) {
    push(session.id, "fs.changed", {
      subscription: id,
      root_b64: b64Of(path),
      path_b64: b64Of(path),
      kind: "modified",
    });
  } else {
    push(session.id, "git.changed", { subscription: id, root_b64: b64Of(path) });
  }

  return {
    subscription: id,
    path_b64: b64Of(path),
    recursive,
    already: false,
    git_dir_b64: gitDir === null ? null : b64Of(gitDir),
  };
}

function opUnsubscribe(session: Session, params: Record<string, unknown>): unknown {
  const id = optionalU64(params, "subscription");
  const path =
    optionalString(params, "path_b64") === undefined
      ? undefined
      : requiredPath(params, "path_b64");
  if (id === undefined && path === undefined) {
    return protocolError(
      "bad_request",
      "`watch.unsubscribe` needs `subscription` and/or `path_b64`",
    );
  }
  let removed = 0;
  for (const [key, sub] of session.subs) {
    if (key === id || sub.path === path) {
      session.subs.delete(key);
      removed += 1;
    }
  }
  return { removed };
}

function closeSession(id: number, message: string): void {
  const session = sessions.get(id);
  if (!session || !session.live) return;
  session.live = false;
  const channel = session.channel;
  sessions.delete(id);
  if (channel === null) return;
  emit(channel, { kind: "closed", message });
  forgetChannel(channel);
}

function opClose(args: Record<string, unknown>): unknown {
  const id = optionalU64(args, "id");
  if (id !== undefined) closeSession(id, "this side closed the helper channel");
  // Closing an unknown session is not an error on the backend either.
  return undefined;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const helperHandlers: Record<string, MockHandler> = {
  helper_open: (args) => opOpen(args),
  helper_call: (args) => opCall(args),
  helper_close: (args) => opClose(args),
};

/** The op names this mock answers — asserted against `HELPER_OPS` in tests. */
export function mockedOps(): string[] {
  return [...HELPER_OPS];
}

/** The hosts `helper_open` accepts, and what it answers for each. */
export function mockedHosts(): Array<{ host: string; mode: MockMode }> {
  return [
    { host: "build-01.farm.internal", mode: { kind: "native" } },
    { host: "gpu-box", mode: { kind: "script_fallback", reason: NO_CHECKSUM_TOOL } },
  ];
}

/** Fixture paths a panel task can drive directly. */
export const HELPER_FIXTURES = {
  /** Five levels deep, with a symlink and a dot-directory. */
  tree: APP,
  /** 1.5 MiB of log lines. */
  hugeFile: "/var/log/faragent/huge.log",
  /** `fs.read` answers `binary`. */
  binaryFile: `${APP}/docs/img/logo.png`,
  /** A directory that is not a repository. */
  nonRepo: "/srv/scratch",
  /** A repository with 14 changed files of every status letter. */
  dirtyRepo: DATA,
  /** A repository with 620 changed files: over the helper's 500-entry cap. */
  bigRepo: MONO,
  /** The changed-file count of `bigRepo`, over the cap on purpose. */
  bigRepoChanges: 620,
} as const;

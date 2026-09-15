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
 * | a session transcript to tail | `/home/deploy/.claude/projects/-srv-app-faragent/01H8ZQk1live.jsonl` — the record kinds a reader must tell apart |
 *
 * Three hosts, so all three `helper_open` outcomes are reachable from the host
 * switcher: `build-01.farm.internal` is native, `gpu-box` is the script
 * fallback (with a real reason), and `win-builder` fails the way the backend
 * fails it. Any other host name fails the *other* way `helper_open` fails — with
 * a connection diagnosis and no `message` (see `noRouteDiagnosis`).
 *
 * Everything here is data and pure logic: no `window`, no timers other than the
 * macrotask that delivers a push. `handlers.ts` registers the three commands;
 * `channel.ts` carries the events.
 */
import { b64ToBytes, bytesToB64 } from "../bytes.ts";
import type { Diagnosis } from "../ipc.ts";
import { channelId, emit, forgetChannel } from "./channel.ts";
import type { MockHandler } from "./handlers.ts";
import {
  EMPTY_TRANSCRIPT_PATH,
  LONG_TRANSCRIPT_PATH,
  TRANSCRIPT_PATH,
  longTranscriptJsonl,
  transcriptJsonl,
} from "./fixtures.ts";

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

/**
 * What the *bash fallback* answers `ping` with — `fs.rs`'s own reply, verbatim.
 *
 * The fallback is a seven-op shell script, not the helper binary: `git.branches`,
 * `git.diff` and `watch.*` are absent, and asking for one is a `bad_request`
 * (`fs.rs`'s `unknown op` arm). A panel that does not read this list degrades
 * silently — the Changes tab fails with a raw protocol error and the branch list
 * is simply empty. So the mock models the shortfall rather than papering over it.
 */
const FALLBACK_OPS = [
  "ping",
  "fs.list",
  "fs.read",
  "fs.stat",
  "git.discover",
  "git.status",
  "git.log",
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

  /**
   * Grow the file by `more` bytes.
   *
   * The one way the virtual filesystem changes after seeding. An agent appends
   * to its own transcript as it works, and that is the whole mechanism a
   * conversation view tails — so a mock that could not append could not show
   * the composer's message arriving, which is the one thing the composer needs
   * a browser to prove.
   */
  append(more: Uint8Array): void {
    const before = this.bytes;
    const after = new Uint8Array(before.length + more.length);
    after.set(before, 0);
    after.set(more, before.length);
    this.cached = after;
  }
}

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;
const LINK_MODE = 0o777;

/** A fixed clock: a fixture that drifted would make every screenshot differ. */
const NOW = Date.UTC(2026, 8, 14, 9, 0, 0) / 1000;

const nodes = new Map<string, VNode>();

/**
 * A clock that only moves forward, for the files the mock itself writes.
 *
 * Every seeded file carries `NOW`, so an append that stamped `NOW` again would
 * be a modification the remote reports but no reader can tell from the state it
 * already had. Seconds, because that is `fs.stat`'s unit.
 */
let clock = NOW;

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

/**
 * Append `text` to a registered file, the way an agent appends a record to its
 * own transcript. Returns whether the path named a regular file.
 *
 * Deliberately **not** an op: nothing in the helper protocol writes files, and
 * adding one would be inventing a wire message the backend does not have. This
 * is the mock's own hand, reached from `handlers.ts`'s `attach_write` — the
 * stand-in for the agent on the other end of the PTY.
 */
export function appendFile(path: string, text: string): boolean {
  const at = normalise(path);
  const node = nodes.get(at);
  if (!node || node.kind !== "file") return false;
  node.file.append(textBytes(text));
  node.mtime = (clock += 1);
  return true;
}

/**
 * Bring an empty regular file into existence, creating its parents. Returns
 * whether it had to.
 *
 * The other half of an agent's first turn, and the reason a *new* session's
 * transcript cannot simply be seeded: the CLI writes the file when it writes
 * its first record, and for a cwd it has never run in, the
 * `~/.claude/projects/<slug>` directory above it comes into being at the same
 * moment. So this creates both, and a consumer tailing the path sees the pair of
 * states a real one does — nothing there, then a file.
 *
 * `fs.stat` on the path answers `not_found` until this is called, which is what
 * a new session's tab meets when it opens.
 */
export function ensureFile(path: string): boolean {
  const at = normalise(path);
  if (nodes.has(at)) return false;
  addFile(at, () => new Uint8Array(), (clock += 1));
  return true;
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

/**
 * The first regular file inside `dir`, by path — the change a fresh
 * subscription reports, or `null` if the tree holds no file at all.
 *
 * A filesystem watch fires for a change *inside* the watched tree, never for
 * the tree itself: the real helper's `emit_fs` names the event's own path, and
 * `home_of` translates it back to the client's spelling. The mock has no
 * filesystem to change by itself, so it names a real file as the closest honest
 * stand-in — in particular a consumer that filters pushes against its own path
 * (the transcript tail) sees a path its watch actually covers, which the
 * watched root is not. `recursive` decides whether a file in a subdirectory
 * counts, matching the subscription.
 */
function firstFileUnder(dir: string, recursive: boolean): string | null {
  const prefix = dir === "/" ? "/" : dir + "/";
  const found: string[] = [];
  for (const [key, node] of nodes) {
    if (node.kind !== "file" || !key.startsWith(prefix)) continue;
    if (!recursive && key.slice(prefix.length).includes("/")) continue;
    found.push(key);
  }
  if (found.length === 0) return null;
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return found[0];
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

  // --- the two directories the session fixtures use as their cwd, so the
  // panel's tree has a root that exists: `attach` roots the tree at the
  // session's cwd and `fs.list` on a missing directory is `not_found`, which
  // would make the default panel state an error box in the mock.
  //
  // `/srv/app/faragent` deliberately sits *inside* the repo at `/srv/app` and
  // has no `.git` of its own, so `git.discover` from a session here exercises
  // the walk-up path rather than a `.git` in the first directory tried.
  addFile(`${APP}/faragent/package.json`, () =>
    textBytes(
      '{\n  "name": "faragent-app",\n  "private": true,\n  "version": "0.2.0",\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc -b && vite build",\n    "test": "node --test \\"src/**/*.test.ts\\""\n  }\n}\n',
    ),
  );
  addFile(`${APP}/faragent/tsconfig.json`, () =>
    textBytes(
      '{\n  "compilerOptions": {\n    "strict": true,\n    "noUnusedLocals": true,\n    "target": "ES2022",\n    "moduleResolution": "bundler"\n  },\n  "include": ["src"]\n}\n',
    ),
  );
  addFile(`${APP}/faragent/.gitignore`, () =>
    textBytes("node_modules\ndist\n.vite\n*.local\n"),
  );
  addFile(`${APP}/faragent/README.md`, () =>
    textBytes("# faragent-app\n\nThe Tauri desktop shell. `pnpm dev` for the webview.\n"),
  );
  addFile(`${APP}/faragent/src/main.tsx`, () =>
    textBytes(
      'import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport { App } from "./app";\n\nconst root = document.getElementById("root");\nif (!root) throw new Error("no #root");\n\ncreateRoot(root).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n',
    ),
  );
  addFile(`${APP}/faragent/src/app.tsx`, () =>
    textBytes(
      'export function App() {\n  // The shell owns the rail, the workspace and the settings view.\n  return <div className="flex h-full" />;\n}\n',
    ),
  );
  addFile(`${APP}/faragent/src/lib/helper.ts`, () =>
    textBytes(
      "// the NDJSON helper channel\nconst MAX_FRAME_BYTES = 8 * 1024 * 1024;\n\nexport function decodeText(bytes: Uint8Array): string {\n  return new TextDecoder().decode(bytes);\n}\n",
    ),
  );
  addFile(`${APP}/faragent/src/components/panel/right-panel.tsx`, () =>
    textBytes(
      'export function RightPanel() {\n  return <aside className="h-full" />;\n}\n',
    ),
  );
  addFile(`${APP}/faragent/src/components/panel/file-tree.tsx`, () =>
    textBytes(
      "// lazy: children are fetched on expand, never eagerly\n  export function FileTree() {\n  return null;\n}\n",
    ),
  );
  addFile(`${APP}/faragent/public/favicon.svg`, () =>
    textBytes('<svg xmlns="http://www.w3.org/2000/svg"><circle r="8" /></svg>\n'),
  );
  addFile(`${APP}/faragent/vite.config.ts`, () =>
    textBytes(
      'import { defineConfig } from "vite";\n\nexport default defineConfig({\n  server: { port: 1420, strictPort: true },\n});\n',
    ),
  );

  // --- one Claude session's conversation, so a tail of a real transcript has a
  // subject: the four record kinds a reader must tell apart (user text,
  // assistant text, `tool_use`, matching `tool_result`) plus the two it must
  // skip. Seeded through the same virtual FS every other fixture uses, so
  // `fs.stat` and `fs.read` — the two ops `lib/chat/transcript.ts` tails with —
  // answer it exactly as they answer any other file.
  addFile(TRANSCRIPT_PATH, () => textBytes(transcriptJsonl()));

  // --- and a second Claude session's conversation, this one long enough that
  // the conversation view has to virtualise it: three thousand-odd events,
  // several hundred kilobytes over the tail window, with a sidechain, a failed
  // call, an edit, a write and a call still running. `longTranscriptJsonl`'s
  // own note lists what it is for; this is only where it is served from.
  addFile(LONG_TRANSCRIPT_PATH, () => textBytes(longTranscriptJsonl()));

  // --- and a third, registered but empty: a session that has started and
  // written nothing yet. The conversation view has to name that state rather
  // than draw a blank pane, and this is what makes it reachable in a browser.
  addFile(EMPTY_TRANSCRIPT_PATH, () => new Uint8Array());

  // --- a loose scratch cwd: no repository above it all the way to `/`, which
  // is what makes the Git tab's "not a repository" state reachable from a real
  // session instead of only by typing a path.
  addFile("/home/deploy/code/scratch/notes.md", () =>
    textBytes(
      "## scratch\n\n- parse the probe output\n- try `tmux -CC` against the win-builder\n",
    ),
  );
  addFile("/home/deploy/code/scratch/probe.sh", () =>
    textBytes("#!/usr/bin/env bash\nset -euo pipefail\nssh -G \"$1\" | sort\n"),
  );
  addFile("/home/deploy/code/scratch/probe.out", () =>
    textBytes("hostname build-01.farm.internal\nuser deploy\nport 22\nidentityfile ~/.ssh/id_ed25519\n"),
  );
  addFile("/home/deploy/code/scratch/report.csv", () =>
    textBytes("host,os,mode\nbuild-01.farm.internal,linux,native\ngpu-box,linux,script_fallback\n"),
  );
  addFile("/home/deploy/code/scratch/archive/2026-08/old-notes.txt", () =>
    textBytes("august notes\n"),
  );

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

/**
 * A `git.diff` target, read the way git itself reads one: relative to the
 * repository root.
 *
 * This is the shape `git.status` hands out and the shape the panel passes
 * straight back, so the common case is already relative — `normalise` would
 * turn `src/app.rs` into `/src/app.rs` and match nothing, which is exactly the
 * bug this function exists to prevent. An absolute path under the root is
 * accepted too, because `git diff -- <path>` run with the repository as its cwd
 * accepts both.
 */
function repoRelative(repo: Repo, raw: string): string | null {
  const path = normalise(raw);
  if (path === repo.root) return null;
  if (path.startsWith(repo.root + "/")) return path.slice(repo.root.length + 1);
  const relative = path.replace(/^\//, "");
  return relative === "" ? null : relative;
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
    : repoRelative(repo, new TextDecoder().decode(b64ToBytes(wire(args, "path_b64"))));

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

/**
 * What `helper_open` fails with when the address is unreachable.
 *
 * Not a `plain` error, and deliberately so: `helper.rs` shapes a connection
 * failure through `faragent_service`'s diagnosis — the same report the TUI
 * renders — and that shape carries **no `message` field at all**. A fixture that
 * answered `{kind: "plain", message}` here would hide the difference, which is
 * the one that matters: the sentence a panel shows has to come from the
 * diagnosis's own summary.
 *
 * The slug, both sentences, the fix steps and every label are copied from
 * `crates/faragent-service/src/diagnose.rs` (`Problem::NoRoute`, `label()`,
 * `title()`, `list_title()`, `ssh_doc()`), so what a panel renders here is what
 * it renders against a real host. Only the host name in them is the caller's.
 */
function noRouteDiagnosis(host: string): Diagnosis {
  return {
    problem: "no_route",
    summary: {
      en: "no route to that address from this machine: wrong network, or the VPN/adapter is down.",
      zh: "本机没有到这个地址的路由：不在同一张网，或网卡 / VPN 没起来。",
    },
    steps: {
      en: [
        `\`ping -c 2 ${host}\``,
        "Confirm you are on the right network: a LAN address only works on that LAN.",
        "With Tailscale / VPN, check state first: `tailscale status`.",
        "Try another path: a public IP / domain, or set `HostName` to a reachable address.",
      ],
      zh: [
        `\`ping -c 2 ${host}\``,
        "确认你在对的网里：局域网地址只在家里 / 办公室那张网有效。",
        "用 Tailscale / VPN 时先看状态：`tailscale status`。",
        "换个入口：改用公网 IP / 域名，或把 `HostName` 换成可达地址。",
      ],
    },
    raw: `ssh: connect to host ${host} port 22: No route to host`,
    command: `ssh -o BatchMode=yes -T ${host} -- bash -lc 'echo faragent-helper-ready'`,
    needsAuth: false,
    timedOut: false,
    title: {
      en: `FarAgent · ${host} · connection failed`,
      zh: `FarAgent · ${host} · 连接失败`,
    },
    listTitle: {
      en: "raw error and fix  [no_route]",
      zh: "原始报错与解决方案  [no_route]",
    },
    labels: {
      label: { en: "connection failed", zh: "连接失败" },
      raw: { en: "raw ssh output", zh: "ssh 原始输出" },
      command: { en: "command FarAgent ran", zh: "FarAgent 实际执行的命令" },
      fixes: { en: "fixes", zh: "处理步骤" },
      docs: { en: "docs", zh: "文档" },
      sshDoc: {
        en: "docs/en/ssh-access.md (when it fails: raw error -> cause -> fix)",
        zh: "docs/zh/ssh-access.md（连不上时：原始报错 → 原因 → 解决）",
      },
    },
    plainEn: `connection failed ${host}: no route to that address from this machine: wrong network, or the VPN/adapter is down.`,
    plainZh: `连接失败 ${host}：本机没有到这个地址的路由：不在同一张网，或网卡 / VPN 没起来。`,
  };
}

function opOpen(args: Record<string, unknown>): unknown {
  const host = wire(args, "host");
  if (host === "") {
    throw { kind: "plain", message: "mock: `host` is required" };
  }
  if (host === "win-builder") {
    // Exactly what `helper.rs` refuses a Windows remote with. The sentence is
    // `FallbackReason::WindowsRemote`'s, verbatim — including the part saying
    // this is *not* a downgrade, because `helper_open` returns an error rather
    // than a script-fallback mode here.
    //
    // `localized`, not `plain`: the wording exists in both languages on the
    // backend, and a `plain` carrier would force it to pick one at the wire
    // (`helper.rs` used to flatten it to `.en`, which is what finding I4 was).
    throw {
      kind: "localized",
      message: {
        zh: "远程是 Windows：helper 通道仅支持 POSIX，无法在这些远端打开 helper 会话。",
        en: "the remote is Windows: the helper channel is POSIX-only, so no helper session can be opened on it.",
      },
    };
  }
  if (host !== "build-01.farm.internal" && host !== "gpu-box") {
    // A diagnosis, not a plain error: that is the shape the backend uses for a
    // connection failure, and the one that carries no `message`.
    throw { kind: "diagnosis", diagnosis: noRouteDiagnosis(host) };
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

  // The fallback is a different program with a smaller vocabulary. Answer the
  // op list *it* would answer, and refuse the rest exactly as it refuses them.
  const ops = session.mode.kind === "native" ? HELPER_OPS : FALLBACK_OPS;
  if (!ops.includes(op)) {
    return protocolError(
      "bad_request",
      `unknown op \`${op}\`; this ${session.mode.kind === "native" ? "helper" : "fallback"} speaks: ${ops.join(", ")}`,
    );
  }

  switch (op) {
    case "ping":
      return { pong: true, version: "0.2.0", pid: 4242, ops };
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
  // caller can be sure a fresh subscription would see: the tree is live. Which
  // mechanism fires depends on whether there is a repository to poll — the same
  // split the real helper has.
  if (gitDir === null) {
    // The change is reported against a real file *inside* the tree, the way the
    // real helper reports the event's own path — never against the watched
    // directory, which a watch does not fire for. A consumer that matches
    // pushes against its own path (the transcript tail) can then act on it. A
    // tree holding no file has nothing to name, and the real helper would not
    // push either.
    const changed = firstFileUnder(path, recursive);
    if (changed !== null) {
      push(session.id, "fs.changed", {
        subscription: id,
        root_b64: b64Of(path),
        path_b64: b64Of(changed),
        kind: "modified",
      });
    }
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

// ---------------------------------------------------------------------------
// Poking the watch, for browser verification
// ---------------------------------------------------------------------------

/**
 * Emit a `fs.changed` for `path` on every live subscription of `host` that
 * covers it, exactly as `faragent_helper::watch::emit_fs` picks a subscription.
 *
 * Here because the mock's filesystem cannot change by itself: `opSubscribe`
 * emits one push when a watch starts, and after that a browser test of "does
 * the panel refresh when the remote says so" has no second event to work with.
 * Driving the panel through a *real* change is not possible without a real
 * remote, which is the whole reason this layer exists — so this is the honest
 * substitute: the same payload the helper would send, on demand.
 *
 * Returns how many subscriptions heard it. Nothing in the app calls this; it is
 * reached from the verification harness (and from `mock.test.ts`).
 */
export function pokeWatch(
  host: string,
  path: string,
  kind: "created" | "removed" | "renamed" | "modified" | "other" = "modified",
): number {
  const target = normalise(path);
  let heard = 0;
  for (const session of sessions.values()) {
    if (!session.live || session.host !== host) continue;
    for (const [id, sub] of session.subs) {
      if (!covers(sub.path, target)) continue;
      push(session.id, "fs.changed", {
        subscription: id,
        root_b64: b64Of(sub.path),
        path_b64: b64Of(target),
        kind,
      });
      heard += 1;
    }
  }
  return heard;
}

/**
 * Emit a `git.changed` on every live subscription of `host` that has a
 * repository — the coarse notification `emit_git` sends when HEAD or the index
 * moves. See [`pokeWatch`] for why this exists.
 */
export function pokeGitChanged(host: string): number {
  let heard = 0;
  for (const session of sessions.values()) {
    if (!session.live || session.host !== host) continue;
    for (const [id, sub] of session.subs) {
      if (sub.gitDir === null) continue;
      push(session.id, "git.changed", {
        subscription: id,
        root_b64: b64Of(sub.path),
      });
      heard += 1;
    }
  }
  return heard;
}

/** The remote's own "is this path inside that watch" rule. */
function covers(root: string, path: string): boolean {
  if (root === path) return true;
  return root === "/" ? true : path.startsWith(`${root}/`);
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
  /** One Claude session's conversation jsonl, for `lib/chat/transcript.ts`. */
  transcript: TRANSCRIPT_PATH,
  /**
   * A second Claude session's conversation, long enough to need virtualising
   * and deep enough into the file to start with "earlier turns not loaded".
   */
  longTranscript: LONG_TRANSCRIPT_PATH,
  /** A session whose conversation file exists and holds no records yet. */
  emptyTranscript: EMPTY_TRANSCRIPT_PATH,
} as const;

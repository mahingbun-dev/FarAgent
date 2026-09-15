/**
 * Fixture data for the browser IPC mock.
 *
 * A Tauri app cannot run in a plain browser: the frontend calls `invoke()` and
 * there is no backend behind it, so every region of the shell falls back to its
 * error state. These fixtures give the shell data shaped like the real
 * backend's, which is what makes the UI renderable, screenshottable and
 * regression-checkable from a browser (`pnpm dev`, :1420).
 *
 * Layering: this file is data only. `handlers.ts` maps a command name onto one
 * of these values; `index.ts` installs the interception that reaches it.
 *
 * Nothing here may reach a production build. `src/main.tsx` reaches the mock
 * layer only behind `import.meta.env.DEV`, and Task 3's acceptance greps
 * `dist/` for `MOCK_MARKER` and for the host aliases below to prove it.
 *
 * `node --test` runs these files directly and knows nothing about the `@/`
 * alias, so the mock layer uses relative `.ts` specifiers throughout.
 */
import type {
  Action,
  AgentKind,
  AuthMode,
  DirListing,
  GitHubSync,
  Host,
  Lang,
  Plan,
  Probe,
  Session,
} from "../ipc.ts";
import { AGENT_TITLES, tmuxName } from "../agents.ts";

/**
 * A string no production build can contain. `npm run build` is followed by a
 * grep of `dist/` for this marker (and for the host aliases below); both must
 * come back empty. Do not reuse it anywhere else.
 */
export const MOCK_MARKER = "faragent-mock-fixture-must-not-ship";

/** A fixed clock: the rail sorts by `mtime`, and fixtures must not drift. */
const NOW = Date.UTC(2026, 8, 14, 9, 0, 0); // 2026-09-14T09:00:00Z
const MIN = 60_000;

// ------------------------------------------------------------------ hosts

/** `faragent_transport::ssh::auth_tag`, verbatim — including `auto`'s empty tag. */
const AUTH_TAGS: Record<AuthMode, { zh: string; en: string }> = {
  auto: { zh: "", en: "" },
  key: { zh: "  [仅密钥]", en: "  [key only]" },
  password: { zh: "  [密码登录]", en: "  [password]" },
};

interface HostSeed {
  alias: string;
  auth: AuthMode;
}

/**
 * `list_hosts` order is the switcher's order, and the shell auto-selects the
 * first host — so the first entry here is the one the rail probes on load.
 */
const HOST_SEEDS: HostSeed[] = [
  { alias: "build-01.farm.internal", auth: "key" },
  { alias: "gpu-box", auth: "auto" },
  { alias: "win-builder", auth: "password" },
];

/**
 * Mutable on purpose: `set_host_auth` has to be observable afterwards, which is
 * what the switcher's auth-tag cycle does (mutate, then re-read `list_hosts`).
 */
const hosts: Host[] = HOST_SEEDS.map((seed) => ({
  alias: seed.alias,
  hostname: seed.alias,
  user: "deploy",
  port: 22,
  identity: "~/.ssh/id_ed25519",
  label: seed.alias,
  auth: seed.auth,
  authTag: AUTH_TAGS[seed.auth],
}));

function findHost(alias: string): Host | undefined {
  return hosts.find((h) => h.alias === alias);
}

/** A fresh array each call, so react-query sees a new reference after a mutation. */
export function listHosts(): Host[] {
  return hosts.map((h) => ({ ...h, authTag: { ...h.authTag } }));
}

export function hostAuth(alias: string): AuthMode {
  return findHost(alias)?.auth ?? "auto";
}

export function setHostAuth(alias: string, mode: string): void {
  const host = findHost(alias);
  if (!host || !(mode in AUTH_TAGS)) return;
  host.auth = mode as AuthMode;
  host.authTag = AUTH_TAGS[mode as AuthMode];
}

/** Windows hosts are the reason `host_os` exists at all. */
export function hostOs(alias: string): "posix" | "windows" {
  return alias.startsWith("win") ? "windows" : "posix";
}

// ------------------------------------------------------------------ probe

export function probe(alias: string): Probe {
  if (hostOs(alias) === "windows") {
    return {
      home: "C:\\Users\\deploy",
      os: "windows",
      shell: "powershell.exe",
      path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      tmux: { found: false, path: null, version: null },
      agents: [
        {
          id: "claude",
          found: true,
          path: "C:\\Users\\deploy\\AppData\\Roaming\\npm\\claude.cmd",
          version: "2.0.1",
          authHint: "ok",
        },
        { id: "codex", found: false, path: null, version: null, authHint: "missing" },
        { id: "grok", found: false, path: null, version: null, authHint: "missing" },
        { id: "pi", found: false, path: null, version: null, authHint: "missing" },
      ],
    };
  }
  return {
    home: "/home/deploy",
    os: "posix",
    shell: "/bin/zsh",
    path: "/home/deploy/.local/bin:/usr/local/bin:/usr/bin:/bin",
    tmux: { found: true, path: "/usr/bin/tmux", version: "tmux 3.4" },
    agents: [
      {
        id: "claude",
        found: true,
        path: "/home/deploy/.local/bin/claude",
        version: "2.0.1",
        authHint: "ok",
      },
      {
        id: "codex",
        found: true,
        path: "/home/deploy/.local/bin/codex",
        version: "0.28.0",
        authHint: "ok",
      },
      // Two agents stay uninstalled so the install flow has a subject.
      { id: "grok", found: false, path: null, version: null, authHint: "missing" },
      { id: "pi", found: false, path: null, version: null, authHint: "missing" },
    ],
  };
}

// --------------------------------------------------------------- sessions

interface SessionSeed {
  id: string;
  title: string | null;
  cwd: string | null;
  /** Minutes before `NOW`; the rail shows newest first. */
  age: number;
  live?: boolean;
  running?: boolean;
  scheduled?: boolean;
  /**
   * The conversation file the row points at, when the list carried one. Only the
   * first Claude row sets it, so a session with no transcript (the common case:
   * a tmux- or process-only row) is also reachable in the fixture.
   */
  transcript?: string;
}

/**
 * One Claude session's transcript, in the real shape `~/.claude/projects/<slug>/
 * <session-id>.jsonl` — the slug is the cwd with every non-alphanumeric replaced
 * by `-`, the file is the session id.
 *
 * The content is the four record kinds a transcript renders — a `user` string
 * message, an `assistant` text message, an `assistant` `tool_use`, and the
 * matching `user` `tool_result` whose `tool_use_id` is the `tool_use`'s `id` —
 * plus a `system` and a `queue-operation` record, which a reader must skip. The
 * pairing key (`tool_use.id` ↔ `tool_result.tool_use_id`) is the one the S0
 * spike confirms is 1:1 and is *not* the record `uuid`.
 *
 * Built with `JSON.stringify` rather than hand-written strings so the fixture is
 * valid jsonl by construction — an escaping slip here would look like a parser
 * bug in `lib/chat/transcript.ts`.
 */
export const TRANSCRIPT_PATH =
  "/home/deploy/.claude/projects/-srv-app-faragent/01H8ZQk1live.jsonl";

export function transcriptJsonl(): string {
  const session = "01H8ZQk1live";
  const t = (n: number): string =>
    new Date(Date.UTC(2026, 8, 14, 9, 0, n)).toISOString();
  const records: unknown[] = [
    {
      type: "user",
      uuid: "u-0001",
      timestamp: t(0),
      sessionId: session,
      cwd: "/srv/app/faragent",
      gitBranch: "main",
      message: {
        role: "user",
        content: "Why does the attach lease key on the tab id and not the slot?",
      },
    },
    {
      type: "assistant",
      uuid: "u-0002",
      timestamp: t(2),
      sessionId: session,
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Let me read the lease module first." }],
      },
    },
    {
      type: "assistant",
      uuid: "u-0003",
      timestamp: t(3),
      sessionId: session,
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          {
            type: "tool_use",
            id: "call_00_Xk7Qm2",
            name: "Read",
            input: {
              file_path:
                "/srv/app/faragent/apps/faragent-app/src/lib/attach-lease.ts",
            },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "u-0004",
      timestamp: t(3),
      sessionId: session,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_00_Xk7Qm2",
            content:
              "export function attachLease(tabId: string): Lease {\n  // one attach per tab, not per slot\n  return acquire(`attach:${tabId}`);\n}\n",
          },
        ],
      },
      toolUseResult: {
        type: "text",
        file: {
          filePath:
            "/srv/app/faragent/apps/faragent-app/src/lib/attach-lease.ts",
        },
      },
      sourceToolAssistantUUID: "u-0003",
    },
    {
      type: "assistant",
      uuid: "u-0005",
      timestamp: t(5),
      sessionId: session,
      message: {
        id: "msg_02",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          {
            type: "text",
            text: "A slot can be handed to a different tab, so the slot id is not stable enough to own the lease; the tab id is.",
          },
        ],
      },
    },
    {
      type: "system",
      uuid: "u-0006",
      timestamp: t(5),
      sessionId: session,
      subtype: "stop_hook_summary",
    },
    {
      type: "queue-operation",
      uuid: "u-0007",
      timestamp: t(5),
      sessionId: session,
      operation: "dequeue",
    },
  ];
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/**
 * One row per rail mark — `live`, `running`, `idle` and `scheduled` — spread
 * over three workspaces plus the no-cwd bucket, so grouping, group counts,
 * collapse and all four status dots are reachable in a single screen.
 *
 * `session-list.tsx` derives the mark live > running > scheduled > idle, so the
 * combinations below are what produce each of the four dots.
 */
const SESSION_SEEDS: SessionSeed[] = [
  // /srv/app/faragent
  { id: "01H8ZQk1live", title: "fix attach lease", cwd: "/srv/app/faragent", age: 0, live: true, running: true, transcript: TRANSCRIPT_PATH },
  { id: "01H8ZQk2run", title: "rework the rail", cwd: "/srv/app/faragent", age: 2, running: true },
  { id: "01H8ZQk3idle", title: "update the README", cwd: "/srv/app/faragent", age: 6 },
  { id: "01H8ZQk4idle", title: "bump xterm", cwd: "/srv/app/faragent", age: 11 },
  // /srv/app/docs
  { id: "01H8ZQk5docs", title: "translate the manual", cwd: "/srv/app/docs", age: 18 },
  { id: "01H8ZQk6docs", title: "screenshot the switchers", cwd: "/srv/app/docs", age: 24 },
  { id: "01H8ZQk7docs", title: "trim dead i18n keys", cwd: "/srv/app/docs", age: 31 },
  // /home/deploy/code/scratch
  { id: "01H8ZQk8scr", title: "scratch: parse the probe output", cwd: "/home/deploy/code/scratch", age: 40 },
  { id: "01H8ZQk9scr", title: "scratch: try tmux -CC", cwd: "/home/deploy/code/scratch", age: 47 },
  // no workspace — one null cwd, one whitespace, which the rail also buckets
  { id: "01H8ZQk10orphan", title: "orphan rollout", cwd: null, age: 58 },
  { id: "01H8ZQk11orphan", title: null, cwd: "   ", age: 66 },
  // Codex rollouts / launchd; the rail lists these in their own group
  { id: "01H8ZQk12sched", title: "nightly regression (codex exec)", cwd: "/srv/app/faragent", age: 74, scheduled: true },
  { id: "01H8ZQk13sched", title: "launchd: sync mirrors", cwd: null, age: 85, scheduled: true },
];

/**
 * The backend rebuilds the list per `(host, agent, os)`; the fixture stamps the
 * requested agent on every row rather than pretending only one agent exists.
 * The scheduled rows are returned for every agent — the rail renders a
 * scheduled group whenever the data has one, and keeping it makes the fourth
 * mark reachable without switching agents first.
 */
export function listSessions(agent: AgentKind): Session[] {
  return SESSION_SEEDS.map((seed) => ({
    id: seed.id,
    agent,
    title: seed.title,
    cwd: seed.cwd,
    mtime: NOW - seed.age * MIN,
    live: !!seed.live,
    running: !!seed.running,
    tmux: seed.live ? tmuxName(agent, seed.id) : null,
    scheduled: !!seed.scheduled,
    // A transcript path is agent-specific (Claude's lives under
    // `~/.claude/projects`), and the row that has one is a Claude row — so it is
    // stripped for every other agent rather than leaked onto a Codex or Grok
    // row, which is what an un-gated stamp would do.
    transcript: agent === "claude" ? (seed.transcript ?? null) : null,
  }));
}

/** Mirrors `ensure_session`: the backend answers with the tmux name it attached. */
export function ensureSession(
  agent: AgentKind,
  cwd: string,
  sessionId: string | null,
): string {
  return tmuxName(agent, sessionId ?? cwd);
}

// ------------------------------------------------------------------- dirs

/** A tiny virtual tree so the new-session picker has somewhere to walk. */
const DIRS: Record<string, string[]> = {
  "/": ["home", "srv"],
  "/home": ["deploy"],
  "/home/deploy": ["code"],
  "/home/deploy/code": ["faragent", "scratch"],
  "/home/deploy/code/faragent": ["apps", "crates", "docs", "src-tauri"],
  "/home/deploy/code/scratch": ["probe", "tmux"],
  "/srv": ["app"],
  "/srv/app": ["faragent", "docs"],
  "/srv/app/faragent": ["apps", "crates", "docs", "target"],
  "/srv/app/faragent/apps": ["faragent-app"],
  "/srv/app/faragent/apps/faragent-app": ["src", "src-tauri", "public"],
  "/srv/app/faragent/crates": [
    "faragent-core",
    "faragent-remote",
    "faragent-transport",
    "faragent-tui",
  ],
  "/srv/app/faragent/docs": ["design"],
  "/srv/app/docs": ["zh", "en"],
};

function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function parentOf(path: string): string {
  if (path === "/") return "/";
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function listDirs(path: string): DirListing {
  const cwd = trimTrailingSlash(path.trim() || "/");
  return { cwd, parent: parentOf(cwd), dirs: [...(DIRS[cwd] ?? [])] };
}

/**
 * `~` / `~/x` (or `~\x`) against a remote home, in that host's separator style.
 * Prefix only: `~bob` and mid-path tildes stay literal.
 *
 * This mirrors `faragent_core::paths::expand_home` (`crates/faragent-core/src/
 * paths.rs`) line for line, because a UI check of the new-session picker
 * compares what the picker shows against what *this* returns — if the two
 * disagree, the check passes while proving nothing. The three details below are
 * easy to get subtly wrong, and each has a test (`mock.test.ts`) and a matching
 * case in the Rust `paths.rs` tests:
 *
 * - `home` gets its trailing separators stripped (`/` for posix, `/` *and* `\`
 *   for windows), so a home ending in a separator does not double up.
 * - Input is matched exactly. `"~"` is not trimmed, so `" ~/x"` does **not**
 *   expand — the backend would return it literally, and so must this.
 * - Windows always joins with `\` and rewrites every inner `/` to `\`, even when
 *   the input was written `~/`.
 */
export function expandHome(path: string, home: string, os: "posix" | "windows"): string {
  if (path === "~") return home;
  if (os === "windows") {
    for (const prefix of ["~/", "~\\"]) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length).replaceAll("/", "\\");
        return `${home.replace(/[\\/]+$/, "")}\\${rest}`;
      }
    }
    return path;
  }
  if (path.startsWith("~/")) {
    return `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
  }
  return path;
}

// ---------------------------------------------------------------- dialogs

export function githubSync(host: string): GitHubSync {
  return {
    user: "deploy",
    remoteGh: true,
    sshKeyAdded: false,
    warnings: [
      {
        zh: `mock：没有真的把 gh 凭据复制到 ${host}`,
        en: `mock: no gh credential was actually copied to ${host}`,
      },
    ],
    lines: {
      zh: [`已在 ${host} 上找到 gh`, "SSH 密钥保持原样（mock）", "没有写入任何文件"],
      en: [`found gh on ${host}`, "left the SSH key alone (mock)", "wrote no files"],
    },
  };
}

export function installPlan(host: string, agent: AgentKind, action: Action): Plan {
  const title = AGENT_TITLES[agent];
  const install = action !== "uninstall";
  const command = install
    ? `npm install -g ${agent}@latest`
    : `npm uninstall -g ${agent}`;
  return {
    action,
    agent,
    script: `set -e\n${command}\n`,
    steps: [
      {
        title: install ? `install ${title}` : `remove ${title}`,
        command,
        sudo: false,
      },
    ],
    blocked: null,
    warnings: [],
    suggested: [],
    canRun: true,
    title: { zh: `${action} ${title}`, en: `${action} ${title}` },
    listTitle: { zh: `${title} · ${action}`, en: `${title} · ${action}` },
    blockedText: null,
    warningTexts: [],
    stepSudo: { zh: "以 root 运行", en: "runs as root" },
    suggestedTitle: { zh: `建议在 ${host} 上执行`, en: `Suggested on ${host}` },
  };
}

/**
 * `install_preflight` is registered but no frontend code consumes it yet, so
 * this only has to be shaped like `PreflightDto` — a later task that starts
 * reading it can tighten it.
 */
export interface PreflightFixture {
  os: "posix" | "windows";
  home: string;
  curl: boolean;
  node: boolean;
  npm: boolean;
  nvm: boolean;
  tmux: boolean;
  winget: boolean;
  pkg: string | null;
  agentFound: boolean;
  agentPath: string | null;
  liveTmux: boolean;
}

export function installPreflight(host: string, agent: AgentKind): PreflightFixture {
  const p = probe(host);
  const found = p.agents.find((a) => a.id === agent);
  const windows = p.os === "windows";
  return {
    os: p.os,
    home: p.home,
    curl: !windows,
    node: true,
    npm: true,
    nvm: false,
    tmux: p.tmux.found,
    winget: windows,
    pkg: windows ? "winget" : "apt-get",
    agentFound: !!found?.found,
    agentPath: found?.path ?? null,
    liveTmux: p.tmux.found,
  };
}

// ------------------------------------------------------------ in-memory state

/** `get/set_full_permissions` persist to config.json in the backend; in the
 *  mock they live for the page's lifetime, which is all a screenshot needs. */
let fullPermissions = true;

export function getFullPermissions(): boolean {
  return fullPermissions;
}

export function setFullPermissions(on: boolean): void {
  fullPermissions = on;
}

/** Same story as the permissions: in-memory, not written to config.json. */
let language: Lang = "zh";

export function getLanguage(): Lang {
  return language;
}

export function setLanguage(lang: string): void {
  if (lang === "zh" || lang === "en") language = lang;
}

/** `askpass_active`: no password is ever held, so the password flow is reachable
 *  only through the diagnosis path, exactly as with a key-only host. */
export function askpassActive(): boolean {
  return false;
}

export function askpassInstall(): boolean {
  return true;
}

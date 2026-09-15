import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentKind } from "@/lib/agents";
import type { HelperEvent, HelperOpen } from "@/lib/helper";

export type Lang = "zh" | "en";
export type AuthMode = "auto" | "key" | "password";
export type Action = "install" | "upgrade" | "uninstall";
export type { AgentKind };

export interface Text {
  zh: string;
  en: string;
}

export interface Lines {
  zh: string[];
  en: string[];
}

export function pick(text: Text, lang: Lang): string {
  return lang === "zh" ? text.zh : text.en;
}

export function pickLines(lines: Lines, lang: Lang): string[] {
  return lang === "zh" ? lines.zh : lines.en;
}

export interface Host {
  alias: string;
  hostname?: string | null;
  user?: string | null;
  port: number;
  identity?: string | null;
  label: string;
  auth: AuthMode;
  authTag: Text;
}

export interface Probe {
  home: string;
  os: "posix" | "windows";
  shell: string;
  path: string;
  tmux: { found: boolean; path?: string | null; version?: string | null };
  agents: Array<{
    id: string;
    found: boolean;
    path?: string | null;
    version?: string | null;
    authHint: string;
  }>;
}

export interface Session {
  id: string;
  agent: string;
  title?: string | null;
  cwd?: string | null;
  mtime: number;
  live: boolean;
  running: boolean;
  tmux?: string | null;
  /** Codex `codex exec` / launchd rollouts. */
  scheduled?: boolean;
  /**
   * The remote path of this session's conversation transcript, when the list
   * carried one — the file `lib/chat/transcript.ts` tails. `null`/absent for a
   * row the list inferred from tmux or a process scan, which is the normal case
   * for a session started moments ago whose file may not exist yet. Additive and
   * defaulted on the backend (`SessionSummary::transcript`), so an older backend
   * that does not send it is read as absent rather than failing.
   */
  transcript?: string | null;
}

/**
 * What `ensure_session` answers: the tmux session name it ensured, and the
 * agent-session uuid when there is one to know (see the call site in
 * {@link ipc.ensureSession} for when that is `null`).
 *
 * Both keys are always present — the backend sends `session_id: null` rather
 * than omitting it — so a reader can branch on the value without also testing
 * for absence.
 */
export interface EnsuredSession {
  name: string;
  session_id: string | null;
}

export interface Plan {
  action: Action;
  agent: AgentKind;
  script: string;
  steps: Array<{ title: string; command: string; sudo: boolean }>;
  blocked?: string | null;
  warnings: string[];
  suggested: string[];
  canRun: boolean;
  title: Text;
  listTitle: Text;
  blockedText?: Text | null;
  warningTexts: Text[];
  stepSudo: Text;
  suggestedTitle: Text;
}

export interface Diagnosis {
  problem: string;
  summary: Text;
  steps: Lines;
  raw: string;
  command: string;
  needsAuth: boolean;
  timedOut: boolean;
  title: Text;
  listTitle: Text;
  labels: {
    label: Text;
    raw: Text;
    command: Text;
    fixes: Text;
    docs: Text;
    sshDoc: Text;
  };
  plainZh: string;
  plainEn: string;
}

export interface DirListing {
  cwd: string;
  parent: string;
  dirs: string[];
}

export interface GitHubSync {
  user: string;
  remoteGh: boolean;
  sshKeyAdded: boolean;
  warnings: Text[];
  lines: Lines;
}

export type AttachSpec =
  | { kind: "tmux"; tmux_name: string }
  | {
      kind: "win_agent";
      agent: AgentKind;
      cwd: string;
      session_id: string | null;
    }
  | { kind: "install"; script: string; os: "posix" | "windows" }
  | { kind: "login" };

export type AttachEvent =
  | { kind: "data"; b64: string }
  | { kind: "exit"; code: number }
  | { kind: "error"; message: string };

function unwrap(e: unknown): unknown {
  if (e && typeof e === "object" && "payload" in e) {
    return (e as { payload: unknown }).payload;
  }
  return e;
}

export function asDiagnosis(e: unknown): Diagnosis | null {
  const v = unwrap(e);
  if (v && typeof v === "object" && "kind" in v) {
    const k = v as { kind: string; diagnosis?: Diagnosis };
    if (k.kind === "diagnosis" && k.diagnosis) return k.diagnosis;
  }
  if (v && typeof v === "object" && "diagnosis" in v) {
    const d = (v as { diagnosis?: Diagnosis }).diagnosis;
    if (d) return d;
  }
  return null;
}

/**
 * The bilingual sentence behind a `CommandError::Localized` rejection, or `null`.
 *
 * The twin of [`asDiagnosis`], for a class of failure that is not a connection
 * diagnosis: a sentence the backend already has in both languages (a
 * `LocalizedText` — the Windows-remote refusal is the first) and would otherwise
 * have to pick a language for, which it cannot do well. It arrives as
 * `{ kind: "localized", message: { zh, en } }` and the reader's language is
 * chosen here, by `pick`, exactly as the diagnosis's own `summary` is.
 *
 * Carrying both is the mechanism: the alternative — a code the frontend maps to
 * a local table — would mean a second copy of every backend sentence in
 * `lib/i18n.ts`, drifting from the one the TUI shows. The backend already owns
 * the sentence; this only carries it.
 */
export function asLocalized(e: unknown): Text | null {
  const v = unwrap(e);
  if (!v || typeof v !== "object" || !("kind" in v)) return null;
  const k = v as { kind: string; message?: unknown };
  if (k.kind !== "localized") return null;
  const m = k.message;
  if (!m || typeof m !== "object") return null;
  const t = m as { zh?: unknown; en?: unknown };
  if (typeof t.zh !== "string" || typeof t.en !== "string") return null;
  return { zh: t.zh, en: t.en };
}

export function errorMessage(e: unknown): string {
  const v = unwrap(e);
  if (typeof v === "string") return v;
  // A bilingual carrier would stringify to "[object Object]" through the `message`
  // branch below. English is the fallback here rather than the reader's language
  // because this helper has no language in scope; the lang-aware path for a
  // command failure is `helperErrorText` in `lib/helper.ts`, which picks it.
  const localized = asLocalized(v);
  if (localized) return localized.en;
  if (v && typeof v === "object" && "message" in v) {
    return String((v as { message: unknown }).message);
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export const ipc = {
  listHosts: () => invoke<Host[]>("list_hosts"),
  hostAuth: (host: string) => invoke<AuthMode>("host_auth", { host }),
  setHostAuth: (host: string, mode: AuthMode) =>
    invoke<void>("set_host_auth", { host, mode }),
  muxCapable: () => invoke<boolean>("mux_capable"),
  hostOs: (host: string) =>
    invoke<"posix" | "windows">("host_os", { host }),
  probeHost: (host: string) => invoke<Probe>("probe_host", { host }),
  listSessions: (host: string, agent: AgentKind, os: "posix" | "windows") =>
    invoke<Session[]>("list_sessions", { host, agent, os }),
  ensureSession: (
    host: string,
    agent: AgentKind,
    cwd: string,
    sessionId: string | null,
    createCwd: boolean,
  ) =>
    // Tauri 2 command args are camelCase (`create_cwd` → `createCwd`).
    //
    // `session_id` is the id a *new* session was pinned with (`--session-id`), or
    // the resumed one; `null` when the backend cannot know it — a Codex or Pi
    // launch (no adapter pins those), a fresh Windows launch, or a resume the
    // remote could not read. It is what lets a new Claude session's transcript
    // path be computed at all: see `lib/chat/transcript-path.ts`.
    invoke<EnsuredSession>("ensure_session", {
      host,
      agent,
      cwd,
      sessionId,
      createCwd,
    }),
  getLanguage: () => invoke<Lang>("get_language"),
  setLanguage: (lang: string) => invoke<void>("set_language", { lang }),
  askpassActive: (host: string) => invoke<boolean>("askpass_active", { host }),
  askpassInstall: (host: string, password: string) =>
    invoke<boolean>("askpass_install", { host, password }),
  installPreflight: (host: string, agent: AgentKind) =>
    invoke("install_preflight", { host, agent }),
  installPlan: (host: string, agent: AgentKind, action: Action) =>
    invoke<Plan>("install_plan", { host, agent, action }),
  listDirs: (host: string, path: string) =>
    invoke<DirListing>("list_dirs", { host, path }),
  expandHome: (path: string, home: string, os: "posix" | "windows") =>
    invoke<string>("expand_home", { path, home, os }),
  githubSync: (host: string) => invoke<GitHubSync>("github_sync", { host }),
  getFullPermissions: () => invoke<boolean>("get_full_permissions"),
  setFullPermissions: (on: boolean) =>
    invoke<void>("set_full_permissions", { on }),
  attachOpen: (args: {
    host: string;
    spec: AttachSpec;
    cols: number;
    rows: number;
    onEvent: Channel<AttachEvent>;
  }) =>
    invoke<number>("attach_open", {
      host: args.host,
      spec: args.spec,
      cols: args.cols,
      rows: args.rows,
      onEvent: args.onEvent,
    }),
  attachWrite: (id: number, data: string) =>
    invoke<void>("attach_write", { id, data }),
  attachResize: (id: number, cols: number, rows: number) =>
    invoke<void>("attach_resize", { id, cols, rows }),
  attachClose: (id: number) => invoke<void>("attach_close", { id }),
  // The helper channel's three commands. `lib/helper.ts` wraps these into an
  // awaitable connection; the raw calls live here for the same reason the
  // terminal's do — one place that names a command and its argument keys.
  helperOpen: (args: { host: string; onEvent: Channel<HelperEvent> }) =>
    invoke<HelperOpen>("helper_open", {
      host: args.host,
      onEvent: args.onEvent,
    }),
  helperCall: (id: number, op: string, args?: Record<string, unknown>) =>
    invoke<unknown>("helper_call", { id, op, args }),
  helperClose: (id: number) => invoke<void>("helper_close", { id }),
};

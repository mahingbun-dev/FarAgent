import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentKind } from "@/lib/agents";

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

export function errorMessage(e: unknown): string {
  const v = unwrap(e);
  if (typeof v === "string") return v;
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
    invoke<string>("ensure_session", {
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
};

/**
 * The mock's interception layer: one handler per IPC command, dispatched by
 * command name.
 *
 * This module is pure — it never touches `window` or the Tauri API, so it can
 * be exercised directly by `node --test` without a runner or a DOM. `index.ts`
 * is what wires it into `mockIPC`.
 *
 * The contract that matters: an unregistered command **throws**
 * `unknown mocked command: <name>`. Returning `undefined` would be worse than
 * useless — the shell would render its empty state, which is indistinguishable
 * from a real backend that had no data, and a later task's verification would
 * pass while proving nothing. `mock.test.ts` pins this down.
 */
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { AttachEvent } from "../ipc.ts";
import { bytesToB64 } from "../bytes.ts";
import type { AgentKind } from "../agents.ts";
import * as fx from "./fixtures.ts";

export type MockHandler = (args: Record<string, unknown>) => unknown;

export function unknownCommand(cmd: string): Error {
  return new Error(`unknown mocked command: ${cmd}`);
}

function arg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function boolArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

// ---------------------------------------------------------------- channels

/**
 * Tauri's `Channel` reaches the handler as the object itself under `mockIPC`
 * (only a real invoke serialises it to `__CHANNEL__:<id>`), so accept both.
 */
function channelId(value: unknown): number | null {
  if (typeof value === "string" && value.startsWith("__CHANNEL__:")) {
    const id = Number(value.slice("__CHANNEL__:".length));
    return Number.isInteger(id) ? id : null;
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === "number" ? id : null;
  }
  return null;
}

/** Per-channel message counter — `Channel` drops anything out of order. */
const nextIndex = new Map<number, number>();

function emit(id: number, event: AttachEvent): void {
  const internals = (
    globalThis as {
      window?: { __TAURI_INTERNALS__?: { runCallback?: (id: number, data: unknown) => void } };
    }
  ).window?.__TAURI_INTERNALS__;
  if (typeof internals?.runCallback !== "function") return;
  const index = nextIndex.get(id) ?? 0;
  nextIndex.set(id, index + 1);
  internals.runCallback(id, { index, message: event });
}

/** What the terminal shows instead of a blank screen: there is no remote PTY. */
function attachBanner(
  host: string,
  spec: unknown,
  cols: string,
  rows: string,
): string {
  const kind =
    spec && typeof spec === "object" && "kind" in spec
      ? String((spec as { kind: unknown }).kind)
      : "?";
  return [
    "",
    "\x1b[2m── faragent mock attach ──────────────────────────────\x1b[0m",
    `\x1b[1m${host}\x1b[0m  spec=${kind}  ${cols}x${rows}`,
    `\x1b[2m${JSON.stringify(spec)}\x1b[0m`,
    "",
    "\x1b[2mNo backend is running. This is fixture data from src/lib/mock,\x1b[0m",
    "\x1b[2mwhich never reaches a production build.\x1b[0m",
    "",
  ].join("\r\n");
}

let attachSeq = 0;

function openAttach(args: Record<string, unknown>): number {
  const id = (attachSeq += 1);
  const host = arg(args, "host");
  const spec = args.spec;
  const channel = channelId(args.onEvent);
  if (channel !== null) {
    const banner: AttachEvent = {
      kind: "data",
      b64: bytesToB64(
        new TextEncoder().encode(
          attachBanner(host, spec, String(args.cols ?? ""), String(args.rows ?? "")),
        ),
      ),
    };
    // Deliberately not delivered inline. React StrictMode mounts, unmounts and
    // remounts a terminal in dev; a banner written during the first effect goes
    // to a Terminal that is disposed a moment later, and the one left on screen
    // stays blank (measured — `runCallback` fires, the visible terminal does
    // not). Waiting a macrotask lets the remount re-bind the channel's
    // `onmessage` first. It is also closer to the real backend, which streams.
    setTimeout(() => emit(channel, banner), 0);
  }
  return id;
}

// ---------------------------------------------------------------- handlers

export const handlers: Record<string, MockHandler> = {
  // hosts
  list_hosts: () => fx.listHosts(),
  host_auth: (a) => fx.hostAuth(arg(a, "host")),
  set_host_auth: (a) => fx.setHostAuth(arg(a, "host"), arg(a, "mode")),
  mux_capable: () => true,
  host_os: (a) => fx.hostOs(arg(a, "host")),
  probe_host: (a) => fx.probe(arg(a, "host")),

  // sessions
  list_sessions: (a) => fx.listSessions(arg(a, "agent") as AgentKind),
  ensure_session: (a) =>
    fx.ensureSession(
      arg(a, "agent") as AgentKind,
      arg(a, "cwd"),
      arg(a, "sessionId") || null,
    ),

  // settings
  get_language: () => fx.getLanguage(),
  set_language: (a) => fx.setLanguage(arg(a, "lang")),
  get_full_permissions: () => fx.getFullPermissions(),
  set_full_permissions: (a) => fx.setFullPermissions(boolArg(a, "on")),

  // auth
  askpass_active: () => fx.askpassActive(),
  askpass_install: () => fx.askpassInstall(),

  // install
  install_preflight: (a) =>
    fx.installPreflight(arg(a, "host"), arg(a, "agent") as AgentKind),
  install_plan: (a) =>
    fx.installPlan(
      arg(a, "host"),
      arg(a, "agent") as AgentKind,
      arg(a, "action") as "install" | "upgrade" | "uninstall",
    ),

  // directories
  list_dirs: (a) => fx.listDirs(arg(a, "path")),
  expand_home: (a) =>
    fx.expandHome(
      arg(a, "path"),
      arg(a, "home"),
      arg(a, "os") === "windows" ? "windows" : "posix",
    ),

  // github
  github_sync: (a) => fx.githubSync(arg(a, "host")),

  // attach: the terminal surface. `attach_open` answers with a banner over the
  // channel the caller supplied. The other three are deliberate no-ops: there
  // is no PTY, so there is nothing to write to, resize or hang up — but they
  // still have to be registered, or the shell would report them as unknown.
  attach_open: (a) => openAttach(a),
  attach_write: () => undefined,
  attach_resize: () => undefined,
  attach_close: (a) => {
    const id = Number(a.id);
    if (Number.isInteger(id)) nextIndex.delete(id);
    return undefined;
  },
};

/** Registered command names — the coverage list `mock.test.ts` asserts against. */
export function mockedCommands(): string[] {
  return Object.keys(handlers);
}

/**
 * Hand a command to its handler. Throws for anything unregistered: see the
 * module doc for why silence would be the wrong default.
 */
export function dispatch(cmd: string, args?: InvokeArgs): unknown {
  const handler = handlers[cmd];
  if (!handler) throw unknownCommand(cmd);
  return handler({ ...(args ?? {}) });
}

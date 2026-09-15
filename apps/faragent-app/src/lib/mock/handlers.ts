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
import type { AttachEvent, AttachSpec } from "../ipc.ts";
import { b64ToBytes, bytesToB64 } from "../bytes.ts";
import type { AgentKind } from "../agents.ts";
import { channelId, emit, forgetChannel } from "./channel.ts";
import { appendFile, ensureFile, helperHandlers, pokeWatch } from "./helper.ts";
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

// ---------------------------------------------------------------- attach

let attachSeq = 0;

/**
 * An attach the mock is pretending has a PTY behind it.
 *
 * There is no shell on the other end, so the mock plays one: bytes typed into a
 * terminal are collected until a Return, and the line that results is answered
 * on the same channel (so the terminal visibly receives something) and, when the
 * session has a conversation file, written into it as the agent would write a
 * `user` record.
 *
 * That second half is what makes the composer exercisable in a browser at all.
 * The composer's whole contract is "the remote receives what a keystroke would
 * send, and the transcript eventually agrees" — and with a mock that only
 * swallowed the bytes, the transcript would never agree and every send would sit
 * on screen as an unabsorbed echo, which looks exactly like the duplication bug
 * the echo model exists to prevent.
 */
interface MockAttach {
  host: string;
  /** Kept for the one question the bytes cannot answer: which conversation is this. */
  spec: AttachSpec;
  /** The channel the terminal listens on. `null` for a caller that passed none. */
  channel: number | null;
  /** Bytes typed since the last Return — a PTY's line buffer, in miniature. */
  line: string;
}

const attaches = new Map<number, MockAttach>();

/** How long the pretend agent takes to write its record, in ms. */
const AGENT_WRITE_MS = 600;

/**
 * What the terminal shows instead of a blank screen: there is no remote PTY.
 */
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
    "\x1b[2mType here and press Return: the mock echoes the line back,\x1b[0m",
    "\x1b[2mand a session with a transcript records it there too.\x1b[0m",
    "",
  ].join("\r\n");
}

function openAttach(args: Record<string, unknown>): number {
  const id = (attachSeq += 1);
  const host = arg(args, "host");
  const spec = args.spec;
  const channel = channelId(args.onEvent);
  attaches.set(id, {
    host,
    spec: (spec ?? { kind: "login" }) as AttachSpec,
    channel,
    line: "",
  });
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

/** Draw a line into the terminal that wrote it, on the attach's own channel. */
function echoToTerminal(session: MockAttach, line: string): void {
  if (session.channel === null) return;
  const shown = line.replace(/\n/g, "\\n");
  const data: AttachEvent = {
    kind: "data",
    b64: bytesToB64(
      new TextEncoder().encode(
        `\r\n\x1b[2m[faragent mock] pty received: ${shown}\x1b[0m\r\n`,
      ),
    ),
  };
  setTimeout(() => emit(session.channel as number, data), 0);
}

/**
 * The line as the *agent* writes it down, which is not quite the line as it was
 * typed.
 *
 * A TUI's line buffer submits without trailing spaces, and a slash command is
 * recorded as its verb — the argument is parsed out by the TUI and never reaches
 * the transcript. Both are real differences between what the reader typed and
 * what the record holds, and the echo model has to tolerate them (see
 * `lib/chat/echo.ts`); the mock reproduces them so that tolerance is exercised
 * in a browser and not only in a unit test. A multi-line submission is left
 * whole: this buffer submits on CR, so its interior LFs are part of the one
 * message.
 */
function recordText(line: string): string {
  const trimmed = line.replace(/[ \t]+$/, "");
  if (trimmed.includes("\n") || !trimmed.startsWith("/")) return trimmed;
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

/**
 * One submitted line: answer it in the terminal, and let the agent write it down.
 *
 * A line is echoed whether or not it belongs to a session with a transcript —
 * answering the terminal is the mock's job for every attach. The record is not:
 * a login shell has no conversation, so the resolve returns `null` and the mock
 * stops there rather than inventing a file.
 */
function submit(session: MockAttach, line: string): void {
  if (line !== "") echoToTerminal(session, line);
  const target = fx.transcriptForSpec(session.spec);
  if (target === null) return;
  const record = recordText(line);
  setTimeout(() => {
    // A session this mock launched has no transcript file yet — that is the
    // whole point of a session started a second ago, and the state the chat
    // view's "no conversation yet" is for. Its first turn is this one, so the
    // file (and the `~/.claude/projects/<slug>` directory above it) comes into
    // existence here, a beat before the record lands in it.
    const created = target.late && ensureFile(target.path);
    if (!appendFile(target.path, fx.userTurnJsonl(target.sessionId, record, atSeconds()))) {
      return;
    }
    // The write is only half of it: a tailable transcript is one whose directory
    // watch fires, and the mock's filesystem has no watcher of its own. A tail
    // that took its watch while the directory was already there hears this; one
    // that could not (the directory did not exist either) finds the file on its
    // own bounded retry, which is what that retry is for.
    pokeWatch(session.host, target.path, created ? "created" : "modified");
  }, AGENT_WRITE_MS);
}

/** Now, in `fs.stat`'s unit. Only ever used to stamp a record's `timestamp`. */
function atSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function writeAttach(args: Record<string, unknown>): undefined {
  const id = Number(args.id);
  const session = attaches.get(id);
  if (!session) return undefined;
  const text = new TextDecoder().decode(b64ToBytes(arg(args, "data")));
  session.line += text;
  for (;;) {
    const cut = session.line.indexOf("\r");
    if (cut < 0) break;
    const line = session.line.slice(0, cut);
    session.line = session.line.slice(cut + 1);
    submit(session, line);
  }
  return undefined;
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
  // Answers the backend's `{ name, session_id }` object, not a bare name. A new
  // Claude session comes back with the id it was pinned to — the mock pins one
  // too — so the caller can compute the transcript path of a file that does not
  // exist yet, which is the case this fixture set exists to make reachable.
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
  // channel the caller supplied; `attach_write` plays the PTY — it buffers until
  // a Return, echoes the line back, and lets a session's own transcript record
  // it a beat later, which is what the composer's echo reconciles against.
  // `resize` stays a no-op: there is no PTY to tell.
  attach_open: (a) => openAttach(a),
  attach_write: (a) => writeAttach(a),
  attach_resize: () => undefined,
  attach_close: (a) => {
    const id = Number(a.id);
    if (Number.isInteger(id)) {
      attaches.delete(id);
      forgetChannel(id);
    }
    return undefined;
  },

  // helper: the framed channel's three commands, in their own module because
  // they carry a whole virtual remote with them. They are registered here — the
  // spread is what keeps `mockedCommands()` the single coverage list — and an
  // unregistered *command* still throws, exactly as before.
  ...helperHandlers,
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

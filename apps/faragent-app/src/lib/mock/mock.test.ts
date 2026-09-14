/**
 * The mock layer's own tests.
 *
 * These cover the infrastructure, not product behaviour: that the dispatcher
 * refuses unknown commands loudly, that the fixture set is rich enough to drive
 * the rail (all four status marks, several workspaces), that every command
 * `lib/ipc.ts` can send is actually registered, and that `installMocks` wires
 * the real `invoke()` to the dispatcher without clobbering a live runtime.
 *
 * `mockIPC` installs itself on `window`, which a plain Node process does not
 * have, so the suite lends it one. Node runs each test file in its own process,
 * so this cannot leak into `attach-lease.test.ts` or `session-groups.test.ts`.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Channel, invoke } from "@tauri-apps/api/core";
import { b64ToBytes } from "../bytes.ts";
import type { AttachEvent, Session } from "../ipc.ts";
import { ipc } from "../ipc.ts";
import { SESSION_PAGE, budgetGroups, groupByWorkspace } from "../session-groups.ts";
import * as fx from "./fixtures.ts";
import { dispatch, mockedCommands } from "./handlers.ts";
import { installMocks, mocksInstalled, uninstallMocks } from "./index.ts";

const HOST = "build-01.farm.internal";

before(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  assert.equal(installMocks({ force: true }), true, "the suite needs the mock installed");
});

after(() => {
  uninstallMocks();
});

// ------------------------------------------------------------ unknown command

test("an unregistered command throws, it never resolves to undefined", async () => {
  // A silent `undefined` would render an empty state, which looks exactly like
  // a real backend that had no data — the failure mode this whole layer exists
  // to prevent. It has to be an error, and it has to name the command.
  assert.throws(
    () => dispatch("does_not_exist"),
    /^Error: unknown mocked command: does_not_exist$/,
  );

  await assert.rejects(invoke("does_not_exist"), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.equal(e.message, "unknown mocked command: does_not_exist");
    return true;
  });

  // The other half of the contract: a registered command is *not* undefined.
  assert.notEqual(dispatch("list_hosts"), undefined);
});

// ------------------------------------------------------------- command cover

test("every command lib/ipc.ts can send is registered", async () => {
  // Two independent guards. The count catches a command added to `ipc.ts` (or
  // to the handler table) without the other side; the calls catch a handler
  // that exists under the wrong name, and the payload keys each handler reads.
  assert.equal(
    Object.keys(ipc).length,
    mockedCommands().length,
    "ipc.ts and the mock handler table have drifted apart",
  );

  const channel = new Channel<AttachEvent>();
  const sent: Array<[string, Promise<unknown>]> = [
    ["listHosts", ipc.listHosts()],
    ["hostAuth", ipc.hostAuth(HOST)],
    ["setHostAuth", ipc.setHostAuth(HOST, "key")],
    ["muxCapable", ipc.muxCapable()],
    ["hostOs", ipc.hostOs(HOST)],
    ["probeHost", ipc.probeHost(HOST)],
    ["listSessions", ipc.listSessions(HOST, "claude", "posix")],
    ["ensureSession", ipc.ensureSession(HOST, "claude", "/srv/app", null, true)],
    ["getLanguage", ipc.getLanguage()],
    ["setLanguage", ipc.setLanguage("zh")],
    ["askpassActive", ipc.askpassActive(HOST)],
    ["askpassInstall", ipc.askpassInstall(HOST, "hunter2")],
    ["installPreflight", ipc.installPreflight(HOST, "claude")],
    ["installPlan", ipc.installPlan(HOST, "claude", "install")],
    ["listDirs", ipc.listDirs(HOST, "/srv/app")],
    ["expandHome", ipc.expandHome("~/code", "/home/deploy", "posix")],
    ["githubSync", ipc.githubSync(HOST)],
    ["getFullPermissions", ipc.getFullPermissions()],
    ["setFullPermissions", ipc.setFullPermissions(true)],
    [
      "attachOpen",
      ipc.attachOpen({
        host: HOST,
        spec: { kind: "login" },
        cols: 80,
        rows: 24,
        onEvent: channel,
      }),
    ],
    ["attachWrite", ipc.attachWrite(1, "")],
    ["attachResize", ipc.attachResize(1, 80, 24)],
    ["attachClose", ipc.attachClose(1)],
  ];

  for (const [name, promise] of sent) {
    await promise.catch((e: unknown) => {
      throw new Error(`ipc.${name}() is not mocked: ${(e as Error).message}`);
    });
  }
});

test("handlers read the payload keys ipc.ts actually sends", async () => {
  // If a handler read the wrong key it would answer with the fixture's default
  // and never throw, so these assert the answer, not just the absence of one.
  assert.equal(await ipc.hostOs("win-builder"), "windows");
  assert.equal(await ipc.hostOs(HOST), "posix");
  assert.equal(await ipc.expandHome("~/code", "/home/deploy", "posix"), "/home/deploy/code");
  assert.equal(await ipc.listHosts().then((h) => h.length), 3);
  assert.equal(await ipc.listDirs(HOST, "/srv/app").then((l) => l.cwd), "/srv/app");
  assert.equal(
    await ipc.listSessions(HOST, "claude", "posix").then((s) => s.length),
    fx.listSessions("claude").length,
  );
});

test("expand_home mirrors faragent_core::paths::expand_home", async () => {
  // A case-for-case restatement of the Rust function's own tests
  // (`crates/faragent-core/src/paths.rs`: `tilde_expands_against_the_remote_home_only_as_a_prefix`
  // and `tilde_expands_windows_style_home`), plus the three places an earlier
  // draft of the mock drifted from it. The new-session picker compares the path
  // it displays against this answer, so a divergence here makes a later UI check
  // pass while proving nothing — which is the whole reason these are pinned.
  type Case = [typed: string, home: string, os: "posix" | "windows", want: string];
  const cases: Case[] = [
    // --- posix, verbatim from the Rust test
    ["~", "/home/me", "posix", "/home/me"],
    ["~/code/app", "/home/me", "posix", "/home/me/code/app"],
    ["/srv/app", "/home/me", "posix", "/srv/app"],
    ["/srv/~weird", "/home/me", "posix", "/srv/~weird"],
    ["~bob/app", "/home/me", "posix", "~bob/app"],

    // (a) a trailing separator on `home` must not double up. The `~` branch
    // returns `home` untouched; only the `~/…` branch strips.
    ["~/code/app", "/home/me/", "posix", "/home/me/code/app"],
    ["~/code/app", "/home/me///", "posix", "/home/me/code/app"],
    ["~", "/home/me/", "posix", "/home/me/"],

    // (b) the input is matched exactly, so neither end is trimmed: `" ~/x"` does
    // not expand (the backend returns it literally), and a trailing space is
    // part of the path.
    [" ~/x", "/home/me", "posix", " ~/x"],
    ["~/x ", "/home/me", "posix", "/home/me/x "],
    ["\t~", "/home/me", "posix", "\t~"],

    // --- windows, verbatim from the Rust test
    ["~", "C:\\Users\\me", "windows", "C:\\Users\\me"],
    ["~\\code\\app", "C:\\Users\\me", "windows", "C:\\Users\\me\\code\\app"],
    ["~/code/app", "C:\\Users\\me", "windows", "C:\\Users\\me\\code\\app"],
    ["C:\\srv\\app", "C:\\Users\\me", "windows", "C:\\srv\\app"],
    ["~bob", "C:\\Users\\me", "windows", "~bob"],
    ["~\\x", "C:\\Users\\me\\", "windows", "C:\\Users\\me\\x"],

    // (c) windows always joins with `\` and rewrites inner `/` *in the typed
    // rest*, even for a `~/` input, and strips trailing `/` *and* `\` from the
    // home. Note the home itself is otherwise passed through verbatim: only its
    // trailing separators are trimmed, so an inner `/` in the home survives.
    ["~/a/b", "C:/Users/me", "windows", "C:/Users/me\\a\\b"],
    ["~/a/b", "C:\\Users\\me\\\\", "windows", "C:\\Users\\me\\a\\b"],
  ];

  for (const [typed, home, os, want] of cases) {
    assert.equal(
      await ipc.expandHome(typed, home, os),
      want,
      `expand_home(${JSON.stringify(typed)}, ${JSON.stringify(home)}, ${os})`,
    );
  }
});

// ------------------------------------------------------------------ fixtures

type Mark = "live" | "running" | "scheduled" | "idle";

/**
 * `session-list.tsx`'s `markOf`, restated. It lives inside a `.tsx` component
 * the Node runner cannot strip, so the precedence is copied here rather than
 * imported — if the component's rule ever changes, this is where it shows up.
 */
function markOf(session: Session): Mark {
  if (session.live) return "live";
  if (session.running) return "running";
  if (session.scheduled) return "scheduled";
  return "idle";
}

test("the session fixture assembles all four rail marks", () => {
  const rows = fx.listSessions("claude");
  const marks = new Set(rows.map(markOf));
  assert.deepEqual(
    [...marks].sort(),
    ["idle", "live", "running", "scheduled"],
    "every status dot the rail can draw needs a fixture row behind it",
  );
});

test("the session fixture groups into workspaces the rail can render", () => {
  const rows = fx.listSessions("claude");
  const interactive = rows.filter((s) => !s.scheduled);
  const groups = groupByWorkspace(interactive);

  assert.ok(groups.length >= 3, "several workspaces, so group headers are real");
  assert.ok(
    groups.some((g) => g.cwd === null),
    "the no-workspace bucket the rail labels separately",
  );

  const page = budgetGroups(groups, SESSION_PAGE);
  assert.equal(page.hidden, 0, "the default fixture fits on one page");
  assert.equal(
    page.groups.reduce((n, g) => n + g.sessions.length, 0),
    interactive.length,
  );

  assert.ok(
    rows.some((s) => s.scheduled),
    "a scheduled row, so the scheduled group is not just its empty state",
  );
});

// ------------------------------------------------------------------- install

test("attach_open answers the caller's channel with a mock banner", async () => {
  // Proves the Channel path works under mockIPC, which is what lets the
  // terminal render anything at all in a browser.
  const seen: AttachEvent[] = [];
  const channel = new Channel<AttachEvent>();
  channel.onmessage = (event) => seen.push(event);

  const id = await ipc.attachOpen({
    host: HOST,
    spec: { kind: "login" },
    cols: 80,
    rows: 24,
    onEvent: channel,
  });

  assert.equal(typeof id, "number");
  // The banner is delivered on a macrotask, not inline: see `openAttach` — a
  // synchronous write lands on the terminal StrictMode is about to throw away.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(seen.length, 1);
  const first = seen[0];
  assert.equal(first.kind, "data");
  if (first.kind === "data") {
    const text = new TextDecoder().decode(b64ToBytes(first.b64));
    assert.match(text, /faragent mock attach/);
    assert.match(text, /spec=login/);
  }
  await ipc.attachClose(id);
});

test("installMocks refuses to clobber a live Tauri runtime", () => {
  assert.equal(mocksInstalled(), true);
  assert.equal(installMocks({ force: true }), false, "installing twice is a no-op");

  uninstallMocks();
  const w = globalThis as unknown as { window: { __TAURI_INTERNALS__?: unknown } };
  w.window.__TAURI_INTERNALS__ = { invoke: () => undefined };
  try {
    // `tauri dev` serves the same Vite build the browser does. If the mock won
    // this race, the desktop app would silently talk to fixtures.
    assert.equal(installMocks(), false, "a live runtime must win");
  } finally {
    delete w.window.__TAURI_INTERNALS__;
    assert.equal(installMocks({ force: true }), true, "and the mock is restorable");
  }
});

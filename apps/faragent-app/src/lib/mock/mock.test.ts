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
import { HelperError, decodeText, encodePath, helperErrorText } from "../helper.ts";
import type { HelperEvent } from "../helper.ts";
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
  const helperChannel = new Channel<HelperEvent>();
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
    ["helperOpen", ipc.helperOpen({ host: HOST, onEvent: helperChannel })],
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

test("the helper commands answer through the mock's virtual remote", async () => {
  // The count guard above proves the three commands are registered; this proves
  // they are *wired*. `helper_call` needs an id, so it cannot go in the eager
  // list above — it has to await the open first.
  const channel = new Channel<HelperEvent>();
  const { id, native } = await ipc.helperOpen({ host: HOST, onEvent: channel });
  assert.equal(native, true);

  const pong = (await ipc.helperCall(id, "ping")) as { pong: boolean; ops: string[] };
  assert.equal(pong.pong, true);
  assert.equal(pong.ops.length, 12);

  // An unknown *op* is a protocol error with the helper's own code — never a
  // silent `undefined`, which a panel would render as an empty list.
  await ipc.helperCall(id, "fs.chmod").then(
    () => {
      throw new Error("an unknown op must reject");
    },
    (e: { kind: string; code: string }) => {
      assert.equal(e.kind, "remote");
      assert.equal(e.code, "bad_request");
    },
  );

  await ipc.helperClose(id);
  // And the session is really gone afterwards.
  await ipc.helperCall(id, "ping").then(
    () => {
      throw new Error("a closed session must reject");
    },
    (e: { kind: string }) => assert.equal(e.kind, "disconnected"),
  );
});

test("a host that cannot be reached fails the way the backend fails it", async () => {
  // `helper_open` on an unreachable host is a *diagnosis*, not a plain error —
  // the same shape the TUI renders — and that shape carries no `message` field.
  // The fixture has to keep that property, because it is the one that broke the
  // panel's text: `HelperError.from` has to derive the sentence, and this test
  // would happily pass while a panel printed "[object Object]" if the mock
  // added a `message` the real backend never sends.
  const channel = new Channel<HelperEvent>();
  const rejection = await ipc
    .helperOpen({ host: "gone-01.farm.internal", onEvent: channel })
    .then(
      () => null,
      (e: unknown) => e,
    );
  assert.ok(rejection, "an unreachable host must reject");
  const wire = rejection as {
    kind?: unknown;
    message?: unknown;
    diagnosis?: { problem?: unknown; summary?: { en?: unknown } };
  };
  assert.equal(wire.kind, "diagnosis");
  assert.equal(wire.message, undefined, "the wire shape sends no message");
  assert.equal(wire.diagnosis?.problem, "no_route");

  const error = HelperError.from(rejection);
  assert.equal(error.kind, "open");
  assert.equal(error.message, wire.diagnosis?.summary?.en);
  assert.match(error.message, /no route to that address/);
  // And the panel's sentence is bilingual, straight off the diagnosis — the same
  // two strings the TUI would show for this host.
  assert.equal(helperErrorText(error, "en"), wire.diagnosis?.summary?.en);
  assert.match(helperErrorText(error, "zh"), /没有到这个地址的路由/);
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

test("a git.diff target is repository-relative, the shape git.status hands out", async () => {
  // The regression this pins: git runs with the repository as its cwd, so
  // `git.status` names files *relative to the repository root*, and the panel
  // hands one of those names straight back to `git.diff`. If the mock
  // normalises that relative path into an absolute one on the way in, the
  // target matches no file, the patch comes back as the empty string, and the
  // UI tells the user "this file has no text diff" for a file that plainly
  // has one. `crates/faragent-helper/src/ops/git.rs` passes `path_b64` to
  // `git diff -- <path>` verbatim for exactly this reason.
  const channel = new Channel<HelperEvent>();
  const { id } = await ipc.helperOpen({ host: HOST, onEvent: channel });
  try {
    const root = encodePath("/srv/data");
    const status = (await ipc.helperCall(id, "git.status", { root_b64: root })) as {
      files: Array<{ path_b64: string; staged: boolean }>;
    };
    const target = status.files.find(
      (file) => decodeText(b64ToBytes(file.path_b64)) === "src/app.rs",
    );
    assert.ok(target, "the fixture still names src/app.rs among the changes");
    // Repo-relative, byte for byte what git itself prints.
    assert.equal(decodeText(b64ToBytes(target.path_b64)), "src/app.rs");

    const diff = (await ipc.helperCall(id, "git.diff", {
      root_b64: root,
      path_b64: target.path_b64,
      staged: target.staged,
    })) as { diff_b64: string | null; files: unknown[] };
    assert.equal(diff.files.length, 1, "the target must match its own file");
    assert.ok(diff.diff_b64, "a modified file has a patch, not the empty string");
    assert.match(
      decodeText(b64ToBytes(diff.diff_b64)),
      /^diff --git a\/src\/app\.rs b\/src\/app\.rs/m,
    );

    // And the other accepted spelling — an absolute path under the root — finds
    // the same file, because `git diff -- <path>` accepts both.
    const absolute = (await ipc.helperCall(id, "git.diff", {
      root_b64: root,
      path_b64: encodePath("/srv/data/src/app.rs"),
      staged: target.staged,
    })) as { diff_b64: string | null };
    assert.ok(absolute.diff_b64, "an absolute path under the root still resolves");
  } finally {
    await ipc.helperClose(id);
  }
});

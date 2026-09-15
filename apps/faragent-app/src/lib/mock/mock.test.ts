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
import { b64ToBytes, bytesToB64 } from "../bytes.ts";
import type { AttachEvent, Session } from "../ipc.ts";
import { HelperError, decodeText, encodePath, helperErrorText } from "../helper.ts";
import type { HelperEvent } from "../helper.ts";
import { ipc } from "../ipc.ts";
import { tmuxIdFromName, tmuxName } from "../agents.ts";
import { SESSION_PAGE, budgetGroups, groupByWorkspace } from "../session-groups.ts";
import { adapt } from "../chat/adapters/claude.ts";
import type { ToolEvent } from "../chat/events.ts";
import { groupEvents } from "../chat/sidechain.ts";
import { diffTextOf } from "../chat/tool-input.ts";
import { claudeTranscriptPath } from "../chat/transcript-path.ts";
import { TAIL_WINDOW_BYTES } from "../chat/transcript.ts";
import * as fx from "./fixtures.ts";
import { HELPER_FIXTURES } from "./helper.ts";
import { dispatch, mockedCommands } from "./handlers.ts";
import { installMocks, mocksInstalled, pokeGitChanged, pokeWatch, uninstallMocks } from "./index.ts";

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

test("only the Claude session rows carry a transcript path", () => {
  // The transcript path is Claude's (`~/.claude/projects/…`); stamping it onto a
  // Codex or Grok row would be a lie the app would then try to tail. And at
  // least one Claude row must carry it, or the tail has no fixture to reach.
  const withPath = fx.listSessions("claude").filter((s) => s.transcript);
  // Three seeded rows: the parser's small transcript, the renderer's long one,
  // and the empty one the honest-empty-state branch is reachable through.
  assert.deepEqual(
    withPath.map((s) => s.transcript).sort(),
    [
      HELPER_FIXTURES.emptyTranscript,
      HELPER_FIXTURES.longTranscript,
      HELPER_FIXTURES.transcript,
    ].sort(),
    "exactly the three seeded rows point at a transcript",
  );

  for (const agent of ["codex", "grok", "pi"] as const) {
    assert.ok(
      fx.listSessions(agent).every((s) => !s.transcript),
      `${agent} rows must not point at a Claude transcript`,
    );
  }
});

/**
 * The long transcript is the conversation view's fixture, and these are the
 * properties the view depends on it having. Asserted through the real adapter
 * and the real fold rather than by counting jsonl lines, because those two are
 * what turn the file into rows: a fixture that stopped producing, say, a pending
 * call would still look right as text.
 */
test("the long transcript is over the tail window and holds every shape the view draws", () => {
  const jsonl = fx.longTranscriptJsonl();
  const bytes = new TextEncoder().encode(jsonl).length;
  assert.ok(
    bytes > TAIL_WINDOW_BYTES,
    `the fixture must not fit in one tail window (${bytes} bytes vs ${TAIL_WINDOW_BYTES})`,
  );

  const records = jsonl
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  const events = adapt(records);
  assert.ok(
    events.length > 3000,
    `thousands of events, so the list has to virtualise: ${events.length}`,
  );

  const tools = events.filter((e): e is ToolEvent => e.kind === "tool");
  assert.ok(
    tools.some((e) => e.result === null),
    "a call still running — the normal live case",
  );
  assert.ok(
    tools.some((e) => e.result?.isError === true),
    "a failed call, which must not look like a successful one",
  );
  assert.ok(
    tools.some((e) => e.name === "Edit" || e.name === "Write"),
    "an edit or a write, which is what produces a diff",
  );
  assert.ok(
    events.some((e) => e.kind === "thinking"),
    "reasoning, which the view collapses",
  );

  const items = groupEvents(events);
  assert.ok(
    items.some((item) => item.kind === "sidechain"),
    "a subagent run, which the view nests rather than splicing in",
  );
  assert.ok(
    items.some((item) => item.kind === "tools" && item.events.length > 1),
    "a run of several calls, which is what the collapsed row's sentence counts",
  );

  // The diff path, through the same reader the renderer uses.
  const edit = tools.find((e) => diffTextOf(e.input) !== null);
  assert.ok(edit, "at least one call describes an edit");
  assert.ok(diffTextOf(edit.input)?.text.startsWith("diff --git"), "and reads as a patch");

  // And the properties that only hold because the shapes sit at the *end* of
  // the file: the tail reads the last `TAIL_WINDOW_BYTES`, so a shape placed
  // anywhere else would be invisible when the session is opened. Asserted on
  // the tail rather than on the whole file, because "the fixture has one" and
  // "the reader can see one" are different claims and only the second matters.
  const all = new TextEncoder().encode(jsonl);
  const tailBytes = all.subarray(Math.max(0, all.length - TAIL_WINDOW_BYTES));
  // Drop the leading partial line, as `frameLines` does with a tail window.
  const tailText = new TextDecoder().decode(tailBytes);
  const tailLines = tailText.split("\n").slice(1).filter((line) => line.includes("{"));
  const tailRecords = tailLines.map((line) => JSON.parse(line) as unknown);
  const tailTools = adapt(tailRecords).filter((e): e is ToolEvent => e.kind === "tool");
  const tailItems = groupEvents(adapt(tailRecords));
  assert.ok(tailRecords.length > 400, `a substantial window: ${tailRecords.length} records`);
  assert.ok(
    tailItems.length > 100,
    `and more rows than a viewport can hold: ${tailItems.length}`,
  );
  assert.ok(
    tailTools.some((e) => e.result === null),
    "the pending call is inside the window",
  );
  assert.ok(
    tailTools.some((e) => e.result?.isError === true),
    "the failed call is inside the window",
  );
  assert.ok(
    tailItems.some((item) => item.kind === "sidechain"),
    "the sidechain block is inside the window",
  );
  assert.ok(
    tailTools.some((e) => diffTextOf(e.input)?.text.includes("@@") === true),
    "the edit's patch is inside the window",
  );
});

test("the transcript fixture is jsonl with the four kinds and a matched tool pair", () => {
  // The record kinds the S0 spike found, plus the two non-dialogue kinds a
  // reader skips. `node --test` strips types rather than compiling them, so this
  // parses the raw jsonl the mock serves, not an imported shape.
  const lines = fx.transcriptJsonl().trimEnd().split("\n");
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    records.map((r) => r.type),
    ["user", "assistant", "assistant", "user", "assistant", "system", "queue-operation"],
  );

  const blockOf = (record: Record<string, unknown>, blockType: string) => {
    const message = record.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return undefined;
    return content.find((b) => (b as { type?: string }).type === blockType) as
      | Record<string, unknown>
      | undefined;
  };

  const toolUse = blockOf(records[2], "tool_use");
  const toolResult = blockOf(records[3], "tool_result");
  assert.ok(toolUse && toolResult, "the fixture has a tool_use and a tool_result");
  assert.equal(
    toolResult.tool_use_id,
    toolUse.id,
    "the pair is keyed by tool_use.id ↔ tool_result.tool_use_id, not by uuid",
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

test("a line typed into an attach is echoed back and lands in the session's transcript", async () => {
  // The composer's contract, end to end through the mock. Bytes go in; the
  // terminal hears the pretend PTY acknowledge them; and the session's
  // conversation file gains the turn a beat later, which is what the composer's
  // echo reconciles against. Without that second half a browser could never show
  // a send *settling* — every message would sit on screen as an echo that never
  // becomes real, which is indistinguishable from the duplication bug the echo
  // model exists to prevent.
  const seen: AttachEvent[] = [];
  const channel = new Channel<AttachEvent>();
  channel.onmessage = (event) => seen.push(event);

  const spec = {
    kind: "tmux",
    tmux_name: fx.ensureSession("claude", "/srv/app/faragent", IDLE_SESSION).name,
  } as const;
  const id = await ipc.attachOpen({ host: HOST, spec, cols: 80, rows: 24, onEvent: channel });

  // Typed as a keyboard would: the characters, then Return.
  await ipc.attachWrite(id, bytesToB64(new TextEncoder().encode("why is the rail empty?\r")));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const drawn = seen
    .filter((event) => event.kind === "data")
    .map((event) => decodeText(b64ToBytes((event as { b64: string }).b64)))
    .join("");
  assert.match(drawn, /faragent mock attach/, "the banner still arrives");
  assert.match(
    drawn,
    /pty received: why is the rail empty\?/,
    "the terminal is answered, which is how a reader sees it is still live",
  );

  // The write is the agent's, not the mock's: it lands later, which is the delay
  // the echo covers.
  assert.equal(
    await readThroughHelper(HOST, HELPER_FIXTURES.emptyTranscript),
    "",
    "nothing is written the instant the line is sent",
  );

  await new Promise((resolve) => setTimeout(resolve, 800));
  const written = await readThroughHelper(HOST, HELPER_FIXTURES.emptyTranscript);
  const last = written.trim().split("\n").pop() ?? "{}";
  const record = JSON.parse(last) as {
    type?: string;
    message?: { role?: string; content?: unknown };
  };
  assert.equal(record.type, "user");
  assert.equal(record.message?.role, "user");
  // Verbatim, including the `?`. The record is the line as an agent would write
  // it down — trailing spaces trimmed, a slash command reduced to its verb — but
  // nothing else, and a mock that decorated the text would leave every send
  // doubled.
  assert.equal(record.message?.content, "why is the rail empty?");

  await ipc.attachClose(id);
});

test("the mock records a slash command the way a TUI does: the verb, not the argument", async () => {
  // A real TUI parses a slash command's argument out for itself, so what reaches
  // the transcript is `/compact` where the reader typed `/compact focus on
  // tests`. The echo model has to tolerate exactly that difference (`sameMessage`
  // in lib/chat/echo.ts), and this is the half of it a browser cannot show
  // without a remote that behaves this way.
  const channel = new Channel<AttachEvent>();
  const spec = {
    kind: "tmux",
    tmux_name: fx.ensureSession("claude", "/srv/app/faragent", IDLE_SESSION).name,
  } as const;
  const id = await ipc.attachOpen({ host: HOST, spec, cols: 80, rows: 24, onEvent: channel });

  // The trailing space is part of the point: a line buffer eats it too.
  await ipc.attachWrite(
    id,
    bytesToB64(new TextEncoder().encode("/compact focus on tests \r")),
  );
  await new Promise((resolve) => setTimeout(resolve, 800));

  const written = await readThroughHelper(HOST, HELPER_FIXTURES.emptyTranscript);
  const last = written.trim().split("\n").pop() ?? "{}";
  const record = JSON.parse(last) as { message?: { content?: unknown } };
  assert.equal(record.message?.content, "/compact");

  await ipc.attachClose(id);
});

test("a launched session has no transcript file until its first turn writes one", async () => {
  // The state the chat view's "no conversation yet" is for, and the one a
  // browser could not reach before this: every seeded Claude row carries a
  // transcript path whose file is already in the fixture filesystem. A session
  // launched from the app answers with the id it was pinned to, the app computes
  // its file from that id, and there is nothing at that path until the CLI takes
  // its first turn — so a tail that opens it must wait rather than fail.
  const ensured = dispatch("ensure_session", {
    agent: "claude",
    cwd: "/srv/app/faragent",
    sessionId: null,
  }) as { name: string; session_id: string | null };
  assert.ok(ensured.session_id, "a new Claude session is answered with its pinned id");
  assert.match(ensured.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // The path the app derives from that id — same rule, same home, same spelling.
  const path = claudeTranscriptPath(
    ensured.session_id,
    "/srv/app/faragent",
    "/home/deploy",
    "posix",
  );
  assert.ok(path !== null, "the id and cwd are enough to name the file");
  assert.match(path, /^\/home\/deploy\/\.claude\/projects\/-srv-app-faragent\/.+\.jsonl$/);

  const channel = new Channel<HelperEvent>();
  const { id } = await ipc.helperOpen({ host: HOST, onEvent: channel });
  try {
    // Nothing there yet: `not_found`, the code a tail reads as "wait for it".
    await ipc.helperCall(id, "fs.stat", { path_b64: encodePath(path) }).then(
      () => {
        throw new Error("the file must not exist before the session's first turn");
      },
      (e: { kind: string; code: string }) => {
        assert.equal(e.kind, "remote");
        assert.equal(e.code, "not_found");
      },
    );

    // The first turn: a line typed into the attach, which the mock's agent
    // answers by writing the file and the record together.
    const spec = { kind: "tmux", tmux_name: ensured.name } as const;
    const attach = await ipc.attachOpen({
      host: HOST,
      spec,
      cols: 80,
      rows: 24,
      onEvent: new Channel<AttachEvent>(),
    });
    await ipc.attachWrite(attach, bytesToB64(new TextEncoder().encode("first turn\r")));
    await new Promise((resolve) => setTimeout(resolve, 800));
    await ipc.attachClose(attach);

    const read = (await ipc.helperCall(id, "fs.read", {
      path_b64: encodePath(path),
    })) as { data_b64: string };
    const written = decodeText(b64ToBytes(read.data_b64));
    const record = JSON.parse(written.trim().split("\n").pop() ?? "{}") as {
      type?: string;
      message?: { content?: unknown };
      sessionId?: unknown;
    };
    assert.equal(record.type, "user");
    assert.equal(record.message?.content, "first turn");
    assert.equal(record.sessionId, ensured.session_id, "the record carries the pinned id");
  } finally {
    await ipc.helperClose(id);
  }
});

/**
 * The sessions-rows join, in the harness — the half of the app-launched-session
 * fix a browser could not reach before, because the mock named a launched
 * session after the cwd while the backend names it after the pinned uuid.
 *
 * `merge_sessions` joins a file row to a live tmux row only when
 * `tmux_name(agent, row.id)` is the name the tmux dump carries, and the file is
 * named by the id — so the name has to be derived from the id or the two are
 * two rows for one session. This walks the session through both states the
 * backend reports: the tmux-only `(live)` row a second after launch (no file
 * yet), and the joined file row once the CLI's first turn has written one.
 */
test("a launched session's row joins the tmux session it started, rather than doubling it", async () => {
  const cwd = "/srv/app/faragent";
  const ensured = dispatch("ensure_session", { agent: "claude", cwd, sessionId: null }) as {
    name: string;
    session_id: string | null;
  };
  assert.ok(ensured.session_id, "a new Claude session is answered with its pinned id");

  // The name carries the last twelve alphanumerics of the id (`agents::short_id`)
  // and cannot carry more, so this is the derivation a listing can recompute —
  // and the one that makes the join possible at all.
  const short = ensured.session_id.replace(/[^A-Za-z0-9]/g, "").slice(-12);
  assert.equal(ensured.name, `faragent-claude-${short}`);
  assert.equal(tmuxName("claude", ensured.session_id), ensured.name);
  assert.equal(tmuxIdFromName("claude", ensured.name), short);

  // Before the first turn there is no file, so the backend has only the tmux
  // session to report: one `(live)` row, its id the *short* suffix the name
  // carries. One row — and a different id from the one the file will have.
  const waiting = fx.listSessions("claude").filter((row) => row.tmux === ensured.name);
  assert.equal(waiting.length, 1, "one row for one launched session");
  assert.equal(waiting[0].id, short);
  assert.equal(waiting[0].live, true);
  assert.equal(waiting[0].transcript, null, "nothing to tail until the file exists");

  // The session's first turn, typed into its attach as the composer does.
  const attach = await ipc.attachOpen({
    host: HOST,
    spec: { kind: "tmux", tmux_name: ensured.name },
    cols: 80,
    rows: 24,
    onEvent: new Channel<AttachEvent>(),
  });
  await ipc.attachWrite(attach, bytesToB64(new TextEncoder().encode("check the rail\r")));
  await new Promise((resolve) => setTimeout(resolve, 800));
  await ipc.attachClose(attach);

  const rows = fx.listSessions("claude");
  // THE JOIN: the file row's id is the pinned uuid, the name recomputed from it
  // is the name the tmux session has, and the two are therefore one row.
  const joined = rows.filter((row) => row.id === ensured.session_id);
  assert.equal(joined.length, 1, "the file row");
  assert.equal(joined[0].tmux, ensured.name, "joined to the tmux session it started");
  assert.equal(joined[0].live, true, "live, because the tmux session is");
  assert.equal(joined[0].cwd, cwd);
  assert.equal(joined[0].title, "check the rail", "the row is titled by its first turn");
  assert.match(joined[0].transcript ?? "", /\.jsonl$/, "and carries its conversation");

  assert.equal(
    rows.filter((row) => row.tmux === ensured.name).length,
    1,
    "one row for this session, never two",
  );
});

/** The session behind `HELPER_FIXTURES.emptyTranscript`, as a tmux row names it. */
const IDLE_SESSION = "01H8ZQk3idle";

/** Read a file back the way the app reads one: through the helper channel's ops. */
async function readThroughHelper(host: string, path: string): Promise<string> {
  const channel = new Channel<HelperEvent>();
  const { id } = await ipc.helperOpen({ host, onEvent: channel });
  try {
    const read = (await ipc.helperCall(id, "fs.read", { path_b64: encodePath(path) })) as {
      data_b64: string;
    };
    return decodeText(b64ToBytes(read.data_b64));
  } finally {
    await ipc.helperClose(id);
  }
}

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

// ------------------------------------------------------- poking the watch

/**
 * Let the mock's `setTimeout(…, 0)` pushes land on the channel.
 *
 * `push` is deliberately asynchronous (it stands in for a process writing to a
 * pipe), so a test that pokes and asserts immediately would see nothing.
 */
const drain = () => new Promise((resolve) => setTimeout(resolve, 5));

test("pokeWatch delivers an fs.changed the panel can act on", async () => {
  // The mock's filesystem cannot change by itself, so this is the handle the
  // browser verification drives — and the only way to test "the panel refreshes
  // when the remote pushes" without a real remote. What matters is that the
  // payload is the helper's own: the same fields, base64, on the same channel.
  const channel = new Channel<HelperEvent>();
  const seen: HelperEvent[] = [];
  channel.onmessage = (event) => seen.push(event);
  const { id } = await ipc.helperOpen({ host: HOST, onEvent: channel });
  try {
    const watched = (await ipc.helperCall(id, "watch.subscribe", {
      path_b64: encodePath("/srv/data"),
      recursive: true,
    })) as { subscription: number; git_dir_b64: string | null };
    assert.ok(watched.subscription > 0);
    assert.ok(watched.git_dir_b64, "/srv/data is a repository in the fixtures");

    // The subscription's own opening push is `git.changed` for a repository.
    await drain();
    assert.equal(seen.length, 1, "a fresh subscription reports one change");
    assert.equal(seen[0].event, "git.changed");
    seen.length = 0;

    // Now the on-demand push. `/srv/data/src/app.rs` is under `/srv/data`, so
    // the subscription hears it; the path is what the waiter will invalidate on.
    assert.equal(pokeWatch(HOST, "/srv/data/src/app.rs"), 1, "the subscription heard it");
    await drain();
    assert.equal(seen.length, 1);
    const fs = seen[0];
    assert.equal(fs.event, "fs.changed");
    const data = fs.data as { subscription: number; root_b64: string; path_b64: string; kind: string };
    assert.equal(data.subscription, watched.subscription, "the push names its own subscription");
    assert.equal(decodeText(b64ToBytes(data.root_b64)), "/srv/data");
    assert.equal(decodeText(b64ToBytes(data.path_b64)), "/srv/data/src/app.rs");
    assert.equal(data.kind, "modified");
    seen.length = 0;

    // Outside the watched tree: heard by nobody, so the panel is not woken.
    assert.equal(pokeWatch(HOST, "/srv/other/file.txt"), 0);
    assert.equal(pokeWatch(HOST, "/srv/data"), 1, "the watched root is inside itself");
    await drain();
    assert.equal(seen.length, 1);
    seen.length = 0;

    // A host with no live session hears nothing — the push is addressed, like
    // the real one, which travels down that host's own channel.
    assert.equal(pokeWatch("gpu-box", "/srv/data/src/app.rs"), 0);
    assert.equal(pokeGitChanged("gpu-box"), 0);
    await drain();
    assert.equal(seen.length, 0);

    assert.equal(pokeGitChanged(HOST), 1, "a repository subscription hears git.changed");
    await drain();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, "git.changed");
    assert.equal(
      (seen[0].data as { subscription: number }).subscription,
      watched.subscription,
    );
    seen.length = 0;

    // Unsubscribed: the session is still live but holds nothing to push to.
    const unsubscribe = (await ipc.helperCall(id, "watch.unsubscribe", {
      subscription: watched.subscription,
    })) as { removed: number };
    assert.equal(unsubscribe.removed, 1);
    assert.equal(pokeWatch(HOST, "/srv/data/src/app.rs"), 0);
    assert.equal(pokeGitChanged(HOST), 0);
    await drain();
    assert.equal(seen.length, 0);
  } finally {
    await ipc.helperClose(id);
  }

  // A closed channel hears nothing either — the leak this whole task is about,
  // from the mock's side: a poke must not reach a session that is gone.
  assert.equal(pokeWatch(HOST, "/srv/data/src/app.rs"), 0);
  assert.equal(pokeGitChanged(HOST), 0);
});

test("a directory that is not a repository reports a live tree, not git state", async () => {
  // The split the real helper has: with no repository to poll, a fresh
  // subscription announces that the tree is live as an `fs.changed`. `/srv` is
  // the fixture's parent — a real directory, a repository *under* it
  // (`/srv/data`), but not one itself — which is exactly the case where the
  // mock must take the other branch.
  const channel = new Channel<HelperEvent>();
  const seen: HelperEvent[] = [];
  channel.onmessage = (event) => seen.push(event);
  const { id } = await ipc.helperOpen({ host: HOST, onEvent: channel });
  try {
    const watched = (await ipc.helperCall(id, "watch.subscribe", {
      path_b64: encodePath("/srv"),
      recursive: true,
    })) as { subscription: number; git_dir_b64: string | null };
    assert.equal(watched.git_dir_b64, null, "/srv is not itself a repository");

    await drain();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, "fs.changed", "a non-repository watch has no git state to report");
    const data = seen[0].data as { subscription: number; path_b64: string; kind: string };
    assert.equal(data.subscription, watched.subscription);
    // The change is named against a real file inside the tree, never the
    // watched root: a watch fires for a change *inside* what it covers, and a
    // consumer that filters pushes by its own path (the transcript tail) has to
    // see a path it covers. Which file is the fixture's business; that it is a
    // real one under the root is the contract.
    const changed = decodeText(b64ToBytes(data.path_b64));
    assert.notEqual(changed, "/srv", "not the watched root, which a watch never reports");
    assert.ok(changed.startsWith("/srv/"), `a path inside the tree: ${changed}`);
    // And it is a path the mock really serves, so the filter it feeds is honest.
    const read = (await ipc.helperCall(id, "fs.read", { path_b64: encodePath(changed) })) as {
      data_b64: string;
    };
    assert.ok(read.data_b64.length > 0, "the named path is a real file");
    seen.length = 0;

    // And it is not a git subscriber, so `pokeGitChanged` skips it while the
    // deep path poke still reaches it.
    assert.equal(pokeGitChanged(HOST), 0, "a non-repository watch is not a git subscriber");
    assert.equal(pokeWatch(HOST, "/srv/data/src/app.rs"), 1, "a recursive watch covers its subtree");
    await drain();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, "fs.changed");
  } finally {
    await ipc.helperClose(id);
  }
});

test("a non-recursive watch does not reach into a subdirectory", async () => {
  // The mock's stand-in has to respect the same boundary the real `home_of`
  // ownership test does. `/srv` holds only directories directly — the fixture's
  // projects (`/srv/app`), its repository (`/srv/data`) and `/srv/scratch` — so
  // a watch that covers no file reports nothing, exactly as a real one would.
  const channel = new Channel<HelperEvent>();
  const seen: HelperEvent[] = [];
  channel.onmessage = (event) => seen.push(event);
  const { id } = await ipc.helperOpen({ host: HOST, onEvent: channel });
  try {
    const shallow = (await ipc.helperCall(id, "watch.subscribe", {
      path_b64: encodePath("/srv"),
      recursive: false,
    })) as { git_dir_b64: string | null };
    assert.equal(shallow.git_dir_b64, null, "/srv is not itself a repository");

    await drain();
    assert.equal(seen.length, 0, "no file is covered, so there is no change to name");

    // The recursive watch over the same directory does name one — proving the
    // emptiness above is the boundary, not a missing push.
    await ipc.helperCall(id, "watch.subscribe", {
      path_b64: encodePath("/srv"),
      recursive: true,
    });
    await drain();
    assert.equal(seen.length, 1);
    const data = seen[0].data as { path_b64: string };
    assert.equal(seen[0].event, "fs.changed");
    assert.ok(
      decodeText(b64ToBytes(data.path_b64)).startsWith("/srv/"),
      "a recursive watch names a file below the root",
    );
  } finally {
    await ipc.helperClose(id);
  }
});

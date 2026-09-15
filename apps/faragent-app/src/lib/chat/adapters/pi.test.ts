/**
 * `chat/adapters/pi.ts` — turning a Pi session's records into events.
 *
 * ## These fixtures are documentation-shaped, not measured
 *
 * Every other adapter in this directory was built against a transcript read off
 * a disk, and its comments say where each shape was seen. **This one could not
 * be.** No Pi session exists on the development machine, and the credentials to
 * run one were not available: the local Anthropic auth belongs to the Claude
 * desktop app's own proxy and Pi is refused by it. The shape below therefore
 * comes from Pi's own `docs/session-format.md` (shipped inside
 * `@mariozechner/pi-coding-agent`), and every fixture here is marked
 * `unverified` — see the module doc of `pi.ts`.
 *
 * That marking is the point. A shape read from a document is a shape that has
 * never been contradicted by a real file, which is a weaker thing than a shape
 * read from one — and this directory already contains a case of a plausible
 * reading surviving for months before a full corpus disproved it (Codex's
 * `reasoning`, which is not encrypted after all). Whoever first runs Pi against
 * FarAgent should treat the assertions here as a checklist to confirm or
 * correct, not as a settled record.
 *
 * The tests are ordered as the adapter's decisions are: what becomes an event,
 * how a call is paired with its result, what is dropped, and that no malformed
 * input can make it throw.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent, MessageEvent, ThinkingEvent, ToolEvent } from "../events.ts";
import { adapt } from "./pi.ts";

type Rec = Record<string, unknown>;

/** The ISO timestamp every fixture entry carries, so an assertion can name it. */
const T0 = "2026-09-15T10:00:00.000Z";
const T1 = "2026-09-15T10:00:01.000Z";
const T2 = "2026-09-15T10:00:02.000Z";

/** The `SessionHeader` every Pi file opens with. Not a conversation entry. */
function header(extra: Rec = {}): Rec {
  // unverified — `docs/session-format.md`, "SessionHeader".
  return {
    type: "session",
    version: 3,
    id: "01a09d76-2125-7ab1-881e-9a258ab09c6e",
    timestamp: T0,
    cwd: "/Users/me/code/app",
    ...extra,
  };
}

/** A `message` entry wrapping an `AgentMessage`. */
function entry(id: string, parentId: string | null, message: Rec, extra: Rec = {}): Rec {
  return { type: "message", id, parentId, timestamp: T1, message, ...extra };
}

/** A `user` message whose content is a bare string — the documented spelling. */
function userText(id: string, content: string, parentId: string | null = "root"): Rec {
  return entry(id, parentId, { role: "user", content, timestamp: T1 });
}

const text = (t: string): Rec => ({ type: "text", text: t });
const thinking = (t: string): Rec => ({ type: "thinking", thinking: t });
const toolCall = (callId: string, name: string, args: unknown = {}): Rec => ({
  type: "toolCall",
  id: callId,
  name,
  arguments: args,
});

/** An assistant message carrying blocks. */
function assistant(
  id: string,
  blocks: unknown[],
  parentId: string | null = "root",
  extra: Rec = {},
): Rec {
  // unverified — the documented `AssistantMessage`, including `stopReason`.
  return entry(id, parentId, {
    role: "assistant",
    content: blocks,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    stopReason: "stop",
    timestamp: T2,
    ...extra,
  });
}

/** A `toolResult` message — a record of its own, one entry after the call. */
function toolResult(
  id: string,
  toolCallId: string,
  content: string,
  extra: Rec = {},
  parentId: string | null = "root",
): Rec {
  // unverified — the documented `ToolResultMessage`.
  return entry(id, parentId, {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [text(content)],
    isError: false,
    timestamp: T2,
    ...extra,
  });
}

const kinds = (events: ChatEvent[]): string[] => events.map((e) => e.kind);

// ---------------------------------------------------------------------------
// What becomes an event
// ---------------------------------------------------------------------------

test("a header is not a conversation entry", () => {
  // It carries the session's id, cwd and version and no message at all; drawing
  // it would open every conversation with a fabricated turn.
  assert.deepEqual(adapt([header()]), []);
});

test("a user message's bare-string content is one message", () => {
  // unverified — `UserMessage.content` is `string | (Text | Image)[]`.
  const events = adapt([header(), userText("a1b2c3d4", "hello")]);
  assert.equal(events.length, 1);
  const e = events[0] as MessageEvent;
  assert.equal(e.kind, "message");
  assert.equal(e.role, "user");
  assert.equal(e.markdown, "hello");
  assert.equal(e.id, "a1b2c3d4:0");
  assert.equal(e.timestamp, T1, "the entry's ISO timestamp, not the message's unix one");
  assert.equal(e.sidechain, false);
});

test("a user message's block array is one message per text block", () => {
  const events = adapt([
    header(),
    entry("a1b2c3d4", "root", { role: "user", content: [text("one"), text("two")] }),
  ]);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => (e as MessageEvent).markdown),
    ["one", "two"],
  );
  assert.deepEqual(
    events.map((e) => e.id),
    ["a1b2c3d4:0", "a1b2c3d4:1"],
  );
});

test("an assistant record's blocks become prose, reasoning and calls in block order", () => {
  const events = adapt([
    header(),
    assistant("b2c3d4e5", [
      thinking("let me look"),
      text("reading the file"),
      toolCall("call_1", "bash", { command: "ls" }),
    ]),
  ]);
  assert.deepEqual(kinds(events), ["thinking", "message", "tool"]);
  assert.equal((events[0] as ThinkingEvent).markdown, "let me look");
  assert.equal((events[1] as MessageEvent).role, "assistant");
  assert.equal((events[2] as ToolEvent).name, "bash");
});

test("the thinking block's field is `thinking`, and that is the only spelling read", () => {
  // unverified — but the same spelling Claude uses, and the one documented.
  // A block whose text is elsewhere is skipped rather than guessed at.
  const events = adapt([
    header(),
    assistant("b2c3d4e5", [
      { type: "thinking", text: "wrong field" },
      { type: "thinking", thinking: "right field" },
    ]),
  ]);
  assert.deepEqual(kinds(events), ["thinking"]);
  assert.equal((events[0] as ThinkingEvent).markdown, "right field");
});

test("a toolCall's arguments are passed through exactly as found", () => {
  // unverified — documented as `Record<string, any>`, so an object. `events.ts`
  // promises the value the adapter found, so nothing here shapes it.
  const args = { command: "ls -la", timeout: 5000 };
  const events = adapt([header(), assistant("b2c3d4e5", [toolCall("call_1", "bash", args)])]);
  assert.equal(events.length, 1);
  assert.deepEqual((events[0] as ToolEvent).input, args);
});

test("a call's id is its event id as well as its pairing key", () => {
  const events = adapt([header(), assistant("b2c3d4e5", [toolCall("call_1", "bash")])]);
  assert.equal(events[0].id, "call_1");
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

test("a result fills its call's row rather than becoming one of its own", () => {
  const events = adapt([
    header(),
    assistant("b2c3d4e5", [toolCall("call_1", "bash")]),
    toolResult("c3d4e5f6", "call_1", "total 0"),
  ]);
  assert.equal(events.length, 1, "the result did not add a row");
  const call = events[0] as ToolEvent;
  assert.equal(call.kind, "tool");
  assert.deepEqual(call.result, { content: "total 0", isError: false });
});

test("a result that arrives ahead of its call is dropped, as in claude.ts", () => {
  // Pairing is a single pass with the emitted calls held in a map, so a result
  // can only fill a call that has already been drawn. A real file cannot put
  // them the other way round — a result exists because the call was made — so
  // this is a malformed-input case, and a single pass is worth more than
  // buffering results against a file that can be megabytes long.
  const events = adapt([
    header(),
    toolResult("c3d4e5f6", "call_1", "early"),
    assistant("b2c3d4e5", [toolCall("call_1", "bash")]),
  ]);
  assert.equal(events.length, 1);
  assert.equal((events[0] as ToolEvent).result, null, "the call is drawn, without its early result");
  assert.equal((events[0] as ToolEvent).kind, "tool");
});

test("a failed tool is reported as failed, from the record's own isError", () => {
  // unverified — `ToolResultMessage.isError` is documented, and unlike Codex and
  // Grok this format does carry an error signal, so it is read rather than
  // defaulted.
  const events = adapt([
    header(),
    assistant("b2c3d4e5", [toolCall("call_1", "bash")]),
    toolResult("c3d4e5f6", "call_1", "boom", { isError: true }),
  ]);
  assert.equal((events[0] as ToolEvent).result?.isError, true);
});

test("a result naming no held call emits nothing at all", () => {
  // Covers a malformed record and a call that fell outside the tail window's
  // start, which the reader is holding only part of.
  const events = adapt([header(), toolResult("c3d4e5f6", "call_missing", "orphan")]);
  assert.deepEqual(events, []);
});

test("a tool result's content blocks are joined from their text parts", () => {
  const events = adapt([
    header(),
    assistant("b2c3d4e5", [toolCall("call_1", "bash")]),
    entry("c3d4e5f6", "root", {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [text("line one"), text("line two"), { type: "image", data: "…" }],
      isError: false,
    }),
  ]);
  assert.equal((events[0] as ToolEvent).result?.content, "line one\nline two");
});

// ---------------------------------------------------------------------------
// What is dropped
// ---------------------------------------------------------------------------

test("the entry types that are not messages are dropped", () => {
  const events = adapt([
    header(),
    { type: "model_change", id: "d4e5f6a7", parentId: "a1b2c3d4", timestamp: T1, provider: "openai", modelId: "gpt-4o" },
    { type: "thinking_level_change", id: "e5f6a7b8", parentId: "d4e5f6a7", timestamp: T1, thinkingLevel: "high" },
    { type: "compaction", id: "f6a7b8c9", parentId: "e5f6a7b8", timestamp: T1, summary: "…", tokensBefore: 50000 },
    { type: "branch_summary", id: "a7b8c9d0", parentId: "f6a7b8c9", timestamp: T1, summary: "…" },
  ]);
  assert.deepEqual(events, []);
});

test("the extension roles are dropped rather than folded into the two the model has", () => {
  // `bashExecution` (a shell command the reader ran with `!`), `custom` (an
  // extension's own output), `branchSummary` and `compactionSummary` are all
  // real things a Pi file holds and none of them is a turn anyone took.
  // unverified — documented shapes, never seen. Reconsidering `bashExecution`
  // in particular is a mapping decision, not a bug fix: it *is* something the
  // reader did, and a renderer could reasonably want it.
  const events = adapt([
    header(),
    entry("a1", null, { role: "bashExecution", command: "ls", output: "x", exitCode: 0, cancelled: false, truncated: false }),
    entry("a2", "a1", { role: "custom", customType: "ext", content: "hi", display: true }),
    entry("a3", "a2", { role: "branchSummary", summary: "left branch", fromId: "a1" }),
    entry("a4", "a3", { role: "compactionSummary", summary: "so far", tokensBefore: 10 }),
  ]);
  assert.deepEqual(events, []);
});

test("empty and blank text contributes nothing", () => {
  const events = adapt([
    header(),
    userText("a1b2c3d4", "   "),
    assistant("b2c3d4e5", [text(""), thinking("  "), { type: "image", data: "…" }]),
  ]);
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

test("a record that is not an object is skipped, not thrown on", () => {
  assert.deepEqual(adapt([null, 42, "x", [], undefined, header()]), []);
});

test("a container that is not an array yields nothing", () => {
  for (const junk of [null, undefined, {}, "records", 7]) {
    assert.deepEqual(adapt(junk as unknown as unknown[]), []);
  }
});

test("a wrong-typed field is skipped rather than trusted", () => {
  const events = adapt([
    header(),
    { type: "message", id: "a1", parentId: null, message: "not an object" },
    { type: "message", id: "a2", parentId: null, message: { role: "user", content: 42 } },
    { type: "message", id: "a3", parentId: null, message: { role: "assistant", content: [{ type: "no_such_block", text: "x" }] } },
    { type: "message", id: "a4", parentId: null, message: { role: "assistant", content: [7, { type: "text" }] } },
    { type: "message", id: "a5", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", name: "x" }] } },
    { type: "message", id: "a6", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call_z" }] } },
  ]);
  assert.deepEqual(events, []);
});

test("a bare string is read for either role, since it is unambiguous when it appears", () => {
  // `AssistantMessage` documents a block array only, so this spelling is
  // unverified for an assistant — but a string body is one turn of prose
  // whichever role wrote it, and losing the turn would be the worse failure.
  // `claude.ts` accepts it for both roles too.
  const events = adapt([header(), entry("b2c3d4e5", null, { role: "assistant", content: "plain prose" })]);
  assert.equal(events.length, 1);
  assert.equal((events[0] as MessageEvent).role, "assistant");
  assert.equal((events[0] as MessageEvent).markdown, "plain prose");
});

test("an entry with no id still gets its events a stable name from its position", () => {
  const events = adapt([header(), entry("b2c3d4e5", null, { role: "user", content: "hi" })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "b2c3d4e5:0");

  // An entry whose `id` is missing falls back to the window index, so a list
  // still has a key. `firstIndex` is where `records[0]` sits — here the header,
  // at -3 — so the entry behind it is numbered -2, and that number holds across
  // a `loadEarlier` the way an array index would not.
  const noId = adapt(
    [header(), { type: "message", parentId: null, timestamp: T1, message: { role: "user", content: "hi" } }],
    -3,
  );
  assert.equal(noId.length, 1);
  assert.equal(noId[0].id, "r-2:0", "the reader's own numbering, not the array's");
});

test("the same entry written twice is one event", () => {
  // A file another program is writing can hand the same bytes over twice.
  const twice = [header(), userText("a1b2c3d4", "hello"), userText("a1b2c3d4", "hello")];
  const events = adapt(twice);
  assert.equal(events.length, 1);
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test("adapterFor gives Pi its adapter", async () => {
  const { adapterFor } = await import("./index.ts");
  assert.equal(adapterFor("pi"), adapt);
});

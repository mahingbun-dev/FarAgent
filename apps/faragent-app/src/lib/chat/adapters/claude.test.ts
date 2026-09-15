/**
 * `chat/adapters/claude.ts` — turning a Claude Code transcript into events.
 *
 * The fixtures are built to the four record shapes the S0 spike **measured**
 * from a real 15,000-line session (string- and array-valued `message.content`,
 * a tool call and its later result keyed `tool_use.id` ↔
 * `tool_result.tool_use_id`, `isSidechain` on every record), plus the record
 * types that session held and that must **not** render. The few shapes the
 * spike did not capture — a block-array tool result, `is_error` — are marked
 * `synthesised` where they appear.
 *
 * The tests are ordered as the adapter's own decisions are: what becomes an
 * event, how a call is paired with its result, what is dropped, and that no
 * malformed input can make it throw.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent, MessageEvent, ThinkingEvent, ToolEvent } from "../events.ts";
import { frameLines, parseRecord } from "../transcript.ts";
import { transcriptJsonl } from "../../mock/fixtures.ts";
import { adapt } from "./claude.ts";
import { adapterFor } from "./index.ts";
import { AGENTS, type AgentKind } from "../../agents.ts";

type Rec = Record<string, unknown>;

/** The `timestamp` every fixture record carries, so an assertion can name it. */
const T0 = "2026-08-10T09:00:00.000Z";
const T1 = "2026-08-10T09:00:01.000Z";
const T2 = "2026-08-10T09:00:02.000Z";

/** A `user` record with a bare-string body — the spike's first shape. */
function userText(uuid: string, content: string, extra: Rec = {}): Rec {
  return {
    type: "user",
    uuid,
    timestamp: T0,
    sessionId: "15c76662",
    message: { role: "user", content },
    ...extra,
  };
}

/** An `assistant` record carrying a block array — the spike's second shape. */
function assistant(uuid: string, blocks: unknown[], extra: Rec = {}): Rec {
  return {
    type: "assistant",
    uuid,
    timestamp: T1,
    sessionId: "15c76662",
    message: { id: "msg_01", role: "assistant", model: "deepseek-flash", content: blocks },
    ...extra,
  };
}

/**
 * A `user` record whose body is a single `tool_result` block — the shape a
 * result arrives in, one record after the call that produced it.
 */
function toolResult(toolUseId: string, content: unknown, extra: Rec = {}): Rec {
  return {
    type: "user",
    uuid: `res-${toolUseId}`,
    timestamp: T2,
    sessionId: "15c76662",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
    toolUseResult: { type: "text" },
    sourceToolAssistantUUID: "a-1",
    ...extra,
  };
}

/** A `tool_use` block for a `Bash` call. */
function bashCall(id: string, command: string): Rec {
  return { type: "tool_use", id, name: "Bash", input: { command } };
}

const kindsOf = (events: ChatEvent[]): string[] => events.map((e) => e.kind);
const messages = (events: ChatEvent[]): MessageEvent[] =>
  events.filter((e): e is MessageEvent => e.kind === "message");
const thinkings = (events: ChatEvent[]): ThinkingEvent[] =>
  events.filter((e): e is ThinkingEvent => e.kind === "thinking");
const tools = (events: ChatEvent[]): ToolEvent[] =>
  events.filter((e): e is ToolEvent => e.kind === "tool");

// ---------------------------------------------------------------------------
// Content shapes — string vs block array, one event per block
// ---------------------------------------------------------------------------

test("a string-content user record becomes one user message event", () => {
  const events = adapt([userText("u-1", "Why does the lease key on the tab?")]);
  assert.deepEqual(events, [
    {
      kind: "message",
      id: "u-1:0",
      role: "user",
      markdown: "Why does the lease key on the tab?",
      sidechain: false,
      timestamp: T0,
    },
  ]);
});

test("an array-content user record's text block becomes one user message event", () => {
  const events = adapt([
    {
      type: "user",
      uuid: "u-2",
      timestamp: T0,
      message: { role: "user", content: [{ type: "text", text: "try again" }] },
    },
  ]);
  assert.equal(events.length, 1);
  assert.equal(kindsOf(events)[0], "message");
  assert.equal(messages(events)[0].role, "user");
  assert.equal(messages(events)[0].markdown, "try again");
});

test("an assistant record with only a text block becomes one assistant message event", () => {
  const events = adapt([
    assistant("a-1", [{ type: "text", text: "Let me read the lease module first." }]),
  ]);
  assert.equal(events.length, 1);
  assert.equal(messages(events)[0].role, "assistant");
  assert.equal(messages(events)[0].markdown, "Let me read the lease module first.");
  assert.equal(messages(events)[0].timestamp, T1);
});

test("an assistant record with only a thinking block becomes one thinking event", () => {
  const events = adapt([
    assistant("a-2", [{ type: "thinking", thinking: "The lease is keyed by tab…" }]),
  ]);
  assert.equal(events.length, 1);
  assert.equal(kindsOf(events)[0], "thinking");
  assert.equal(thinkings(events)[0].markdown, "The lease is keyed by tab…");
  assert.equal(thinkings(events)[0].sidechain, false);
});

test("an assistant record with only a tool_use becomes one tool event carrying its name and input", () => {
  const events = adapt([
    assistant("a-3", [bashCall("call_00_Xk7Qm2", "grep -n attachLease src/lib/*.ts")]),
  ]);
  assert.equal(events.length, 1);
  assert.equal(kindsOf(events)[0], "tool");
  const tool = tools(events)[0];
  assert.equal(tool.name, "Bash");
  assert.deepEqual(tool.input, { command: "grep -n attachLease src/lib/*.ts" });
  // The call's own id is the event id, which is also its pairing key.
  assert.equal(tool.id, "call_00_Xk7Qm2");
});

test("a tool call with no result yet still produces an event, with a null result", () => {
  // The normal live case: the agent is still running the tool.
  const events = adapt([assistant("a-4", [bashCall("call_live", "sleep 30")])]);
  assert.equal(events.length, 1);
  assert.equal(tools(events)[0].result, null);
});

test("text, thinking and tool_use in one assistant record emit all three in block order", () => {
  const events = adapt([
    assistant("a-5", [
      { type: "thinking", thinking: "Which module owns the lease?" },
      { type: "text", text: "Reading the lease module." },
      bashCall("call_00_abc", "cat src/lib/attach-lease.ts"),
    ]),
  ]);
  assert.deepEqual(kindsOf(events), ["thinking", "message", "tool"]);
  assert.equal(thinkings(events)[0].markdown, "Which module owns the lease?");
  assert.equal(messages(events)[0].markdown, "Reading the lease module.");
  assert.equal(tools(events)[0].name, "Bash");
});

// ---------------------------------------------------------------------------
// Pairing — a call and its later result are one event
// ---------------------------------------------------------------------------

test("a tool call and its later result are one event, not two", () => {
  const events = adapt([
    assistant("a-6", [bashCall("call_00_do", "ls -la")]),
    toolResult("call_00_do", "total 8\ndrwxr-xr-x  2 me staff 64\n"),
  ]);
  assert.equal(events.length, 1, "the result must not add a second event");
  assert.deepEqual(kindsOf(events), ["tool"]);
  const tool = tools(events)[0];
  assert.equal(tool.id, "call_00_do");
  assert.deepEqual(tool.input, { command: "ls -la" });
  assert.deepEqual(tool.result, {
    content: "total 8\ndrwxr-xr-x  2 me staff 64\n",
    isError: false,
  });
});

test("a result attaches to the matching call when two tools are in flight", () => {
  const events = adapt([
    assistant("a-7", [bashCall("call_01_first", "pwd"), bashCall("call_02_second", "whoami")]),
    // Results come back in their own records, and out of call order.
    toolResult("call_02_second", "sunny"),
    toolResult("call_01_first", "/Users/sunny/code"),
  ]);
  assert.deepEqual(kindsOf(events), ["tool", "tool"]);
  assert.equal(tools(events)[0].id, "call_01_first");
  assert.equal(tools(events)[0].result?.content, "/Users/sunny/code");
  assert.equal(tools(events)[1].id, "call_02_second");
  assert.equal(tools(events)[1].result?.content, "sunny");
});

test("the user record that carries a tool_result does not become a user message", () => {
  const events = adapt([
    assistant("a-8", [bashCall("call_00_x", "ls")]),
    toolResult("call_00_x", "a\nb\n"),
    userText("u-9", "thanks"),
  ]);
  // Three input records, two events: the tool (with its result) and the turn.
  assert.deepEqual(kindsOf(events), ["tool", "message"]);
  assert.equal(messages(events)[0].id, "u-9:0");
});

test("a tool_result whose tool_use_id matches no call is ignored", () => {
  const events = adapt([toolResult("call_00_never_called", "orphaned output")]);
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// Identity — the model promises ids are unique, so the adapter must keep it
// ---------------------------------------------------------------------------

test("a uuid written twice emits one event, not two with the same id", () => {
  const events = adapt([
    userText("u-dup", "the turn, written twice"),
    userText("u-dup", "the turn, written twice"),
  ]);
  assert.equal(events.length, 1, "a repeated record is one event");
  assert.equal(events[0].id, "u-dup:0");
});

test("a call id written twice is one call, and its later result still attaches", () => {
  const events = adapt([
    assistant("a-dup", [bashCall("call_00_dup", "ls")]),
    assistant("a-dup", [bashCall("call_00_dup", "ls")]),
    toolResult("call_00_dup", "output"),
  ]);
  // The first call wins, and — the point — the result pairs with the call that
  // was actually emitted, not the one that was dropped.
  assert.deepEqual(kindsOf(events), ["tool"]);
  assert.equal(tools(events)[0].id, "call_00_dup");
  assert.equal(tools(events)[0].result?.content, "output");
});

// ---------------------------------------------------------------------------
// What is dropped
// ---------------------------------------------------------------------------

test("every non-conversation record type the spike measured produces no events", () => {
  // Counted in a real session: system 3, queue-operation 14, attachment 209,
  // last-prompt 63, custom-title 63, atis-latch 62. None is a turn.
  const records: Rec[] = [
    { type: "system", uuid: "s-1", subtype: "stop_hook_summary" },
    { type: "queue-operation", uuid: "q-1", operation: "dequeue" },
    { type: "attachment", uuid: "att-1" },
    { type: "last-prompt", uuid: "lp-1" },
    { type: "custom-title", uuid: "ct-1", title: "Fix the lease" },
    { type: "atis-latch", uuid: "al-1" },
  ];
  for (const record of records) {
    assert.deepEqual(
      adapt([record]),
      [],
      `${String(record.type)} must not render`,
    );
  }
});

test("a non-conversation record that carries a message is still dropped", () => {
  // The `type` gate is load-bearing: an `attachment` record with a body that
  // looks exactly like a turn must not slip through on its message alone.
  const events = adapt([
    { type: "attachment", uuid: "att-2", message: { role: "user", content: "pasted" } },
  ]);
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// isSidechain
// ---------------------------------------------------------------------------

test("isSidechain is carried onto every event of a subagent record", () => {
  const events = adapt([
    assistant(
      "a-side",
      [{ type: "thinking", thinking: "subagent reasoning" }, bashCall("call_00_sub", "ls")],
      { isSidechain: true },
    ),
    toolResult("call_00_sub", "output", { isSidechain: true }),
    assistant("a-main", [{ type: "text", text: "the main thread" }]),
  ]);
  assert.deepEqual(kindsOf(events), ["thinking", "tool", "message"]);
  assert.equal(thinkings(events)[0].sidechain, true);
  assert.equal(tools(events)[0].sidechain, true);
  assert.equal(tools(events)[0].result?.content, "output");
  assert.equal(messages(events)[0].sidechain, false);
});

// ---------------------------------------------------------------------------
// Malformed and unknown input — skipped, never thrown
// ---------------------------------------------------------------------------

test("a record that is not an object is skipped without throwing", () => {
  assert.deepEqual(adapt([null, undefined, 42, "type:user", [], true]), []);
});

test("a container that is not an array is returned empty rather than throwing", () => {
  // The caller is typed to pass an array; a value that is not one must still
  // not be the thing that throws, because that is the module's whole promise.
  for (const bad of [undefined, null, 42, "records", {}]) {
    assert.deepEqual(adapt(bad as unknown as unknown[]), []);
  }
});

test("a conversation record with no message object is skipped", () => {
  assert.deepEqual(
    adapt([
      { type: "user", uuid: "u-bare" },
      { type: "assistant", uuid: "a-bare", message: "not an object" },
      { type: "user", uuid: "u-arr", message: [] },
    ]),
    [],
  );
});

test("invalid JSON is dropped before the adapter sees it", () => {
  // A transcript is written a line at a time, so a half-written line is normal
  // input. `parseRecord` (which the tail feeds on) returns `undefined` for it,
  // and that `undefined` must be as inert as any other non-record.
  const record = parseRecord(
    new TextEncoder().encode('{"type":"user","message":{"content":"half'),
  );
  assert.equal(record, undefined);
  assert.deepEqual(adapt([record]), []);
});

test("a record whose message.content is neither a string nor an array is skipped", () => {
  assert.deepEqual(
    adapt([
      { type: "user", uuid: "u-n", message: { role: "user", content: 42 } },
      { type: "assistant", uuid: "a-n", message: { role: "assistant", content: null } },
    ]),
    [],
  );
});

test("an unknown content block type is skipped", () => {
  const events = adapt([
    assistant("a-u", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "…" } },
      { type: "redacted_thinking", data: "…" },
    ]),
  ]);
  assert.deepEqual(events, []);
});

test("an empty text block produces no event", () => {
  assert.deepEqual(
    adapt([
      userText("u-w", "   "),
      assistant("a-w", [{ type: "text", text: "" }]),
      assistant("a-w2", [{ type: "thinking", thinking: "" }]),
    ]),
    [],
  );
});

test("a thinking block without the measured `thinking` field is skipped", () => {
  // `thinking` is the field the spike re-read and confirmed. A block that
  // spells its reasoning `text` is a shape this model has never seen, and
  // unknown shapes are skipped rather than guessed at.
  assert.deepEqual(
    adapt([assistant("a-t", [{ type: "thinking", text: "not the measured spelling" }])]),
    [],
  );
});

test("a tool_use without a name is not a call and is skipped", () => {
  assert.deepEqual(
    adapt([assistant("a-x", [{ type: "tool_use", id: "call_00_noname", input: {} }])]),
    [],
  );
});

test("a tool_result's block-array content is flattened to text", () => {
  // Synthesised: the spike's sample result is a plain string, but the API
  // writes a mixed result as a block array, so the adapter joins the text.
  const events = adapt([
    assistant("a-f", [bashCall("call_00_flat", "ls")]),
    toolResult("call_00_flat", [
      { type: "text", text: "line one" },
      { type: "image", source: {} },
      { type: "text", text: "line two" },
    ]),
  ]);
  assert.equal(tools(events)[0].result?.content, "line one\nline two");
});

test("a failed tool result is marked as an error", () => {
  // Synthesised: `is_error` is not in the spike's sample but is the field a
  // result carries when the tool failed.
  const failed = toolResult("call_00_fail", "Exit code 1");
  const content = failed.message as { content: Rec[] };
  content.content[0].is_error = true;
  const events = adapt([assistant("a-e", [bashCall("call_00_fail", "false")]), failed]);
  assert.deepEqual(tools(events)[0].result, { content: "Exit code 1", isError: true });
});

test("an empty transcript adapts to nothing", () => {
  assert.deepEqual(adapt([]), []);
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test("adapterFor returns the Claude adapter for claude", () => {
  assert.equal(adapterFor("claude"), adapt);
});

test("every agent has an adapter, and each one is its own function", () => {
  // This used to assert the opposite for Codex, Grok and Pi, which had no chat
  // view at all. Each adapter has its own suite; what is checked here is only
  // that the registry wires all four up and has not wired one to another's
  // records.
  const seen = new Set<unknown>();
  for (const agent of AGENTS) {
    const found = adapterFor(agent);
    assert.notEqual(found, null, `${agent} must have a chat view`);
    assert.ok(!seen.has(found), `${agent} must not share another agent's adapter`);
    seen.add(found);
  }
});

test("adapterFor is still null for an agent the model has not been taught", () => {
  // `null` is what tells the caller to keep showing the terminal, and that has
  // to survive an agent being added to the union before its records are
  // understood — which is how Pi first shipped, and how the next one will.
  assert.equal(adapterFor("nova" as AgentKind), null);
});

// ---------------------------------------------------------------------------
// End to end, over the transcript S2's mock ships
// ---------------------------------------------------------------------------

test("the S2 mock transcript adapts into its conversation, not its plumbing", () => {
  const bytes = new TextEncoder().encode(transcriptJsonl());
  const { lines } = frameLines(bytes);
  const records = lines.map(parseRecord);
  const events = adapt(records);

  // The fixture holds a user turn, two assistant turns, one Bash call and its
  // result, plus a `system` and a `queue-operation` record — four events.
  assert.deepEqual(kindsOf(events), ["message", "message", "tool", "message"]);
  assert.equal(messages(events)[0].role, "user");
  assert.equal(messages(events)[0].markdown, "Why does the attach lease key on the tab id and not the slot?");
  assert.equal(tools(events)[0].name, "Read");
  assert.match(tools(events)[0].result?.content ?? "", /one attach per tab, not per slot/);
  // The model promises a renderer may key a flat list on `id`; the real
  // fixture must hold that too, not just the hand-built ones.
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});

/**
 * `chat/adapters/codex.ts` — turning a Codex rollout into events.
 *
 * The fixtures are built to the record shapes measured from the real rollouts
 * under `~/.codex/sessions/` (511 files at the time of writing), not to the
 * shapes the protocol is remembered to have. Three measurements shape the whole
 * file:
 *
 * 1. **The text is in there twice.** `event_msg`/`item_completed` carries the
 *    same `UserMessage`/`AgentMessage` body as the `response_item`/`message`
 *    that follows it, so a fixture that holds both spellings — a real rollout —
 *    is the only way to test that the adapter reads one of them.
 * 2. **`reasoning` carries its body in one of two places** — `content`'s
 *    `reasoning_text` block, or `summary`'s `summary_text` block — so the
 *    fixtures hold both spellings, plus the older fully-encrypted record that
 *    has neither.
 * 3. **`arguments` is a JSON string**, so the tests pin the string itself
 *    rather than the object it would parse to.
 *
 * Where the spec's prose and the corpus disagree the corpus wins, and the
 * disagreement is called out at the test that found it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent, MessageEvent, ThinkingEvent, ToolEvent } from "../events.ts";
import { frameLines, parseRecord } from "../transcript.ts";
import { adapt } from "./codex.ts";

type Rec = Record<string, unknown>;

/** The `timestamp` every fixture record carries, so an assertion can name it. */
const T0 = "2026-04-20T09:30:44.142Z";
const T1 = "2026-04-20T09:30:48.166Z";
const T2 = "2026-04-20T09:30:48.530Z";

/**
 * A `response_item` record — the one top-level type that carries conversation.
 *
 * `ordinal` is on every real record (unique and monotonic within a file, 61,982
 * records with no duplicate), which is why it is what the adapter names events
 * after rather than the record's position in the array the reader holds.
 */
function item(ordinal: number, payload: Rec, extra: Rec = {}): Rec {
  return { type: "response_item", ordinal, timestamp: T0, payload, ...extra };
}

/** A user turn: `message` with an `input_text` block — the measured shape. */
function userMsg(ordinal: number, text: string, extra: Rec = {}): Rec {
  return item(
    ordinal,
    { type: "message", role: "user", content: [{ type: "input_text", text }] },
    extra,
  );
}

/** An assistant turn: `message` with an `output_text` block. */
function assistantMsg(ordinal: number, text: string, extra: Rec = {}): Rec {
  return item(
    ordinal,
    { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    extra,
  );
}

/**
 * The `event_msg` echo of a completed item — the second write of the very same
 * text. `item.type` is `UserMessage`/`AgentMessage` and the block type is
 * `Text`, capitalised, which is how the two spellings are told apart.
 */
function itemCompleted(ordinal: number, itemType: string, text: string): Rec {
  return {
    type: "event_msg",
    ordinal,
    timestamp: T0,
    payload: {
      type: "item_completed",
      thread_id: "019daa3a",
      turn_id: "rollout-4",
      item: { type: itemType, id: "item-1", content: [{ type: "Text", text }] },
      completed_at_ms: 1776677448166,
    },
  };
}

/**
 * A measured `reasoning` record of the oldest spelling: `summary: []`,
 * `content: null`, the body only in the ciphertext.
 */
function reasoning(ordinal: number, encrypted = "gAAAAABm…"): Rec {
  return item(ordinal, {
    type: "reasoning",
    summary: [],
    content: null,
    encrypted_content: encrypted,
  });
}

/** A `function_call` record. `arguments` is a **string** — the measured shape. */
function call(ordinal: number, name: string, callId: string, args: string): Rec {
  return item(ordinal, { type: "function_call", name, arguments: args, call_id: callId });
}

/** A `function_call_output` record, which fills the call it names. */
function callOutput(ordinal: number, callId: string, output: string): Rec {
  return item(ordinal, { type: "function_call_output", call_id: callId, output });
}

/** The arguments string of a real `shell` call, kept verbatim from the sample. */
const SHELL_ARGS = JSON.stringify({
  command: ["bash", "-lc", "find . -name 'SKILL.md' | sed -n '1,40p'"],
  workdir: "/Users/maqb11/code/qa/anc",
  timeout_ms: 10000,
});

/** The output of that call, a JSON string in a string, exactly as written. */
const SHELL_OUTPUT = JSON.stringify({
  output: "./OMS/.codex/skills/测试用例深度增强/SKILL.md\n",
  metadata: { exit_code: 0, duration_seconds: 0.2 },
});

const kindsOf = (events: ChatEvent[]): string[] => events.map((e) => e.kind);
const messages = (events: ChatEvent[]): MessageEvent[] =>
  events.filter((e): e is MessageEvent => e.kind === "message");
const thinkings = (events: ChatEvent[]): ThinkingEvent[] =>
  events.filter((e): e is ThinkingEvent => e.kind === "thinking");
const tools = (events: ChatEvent[]): ToolEvent[] =>
  events.filter((e): e is ToolEvent => e.kind === "tool");

// ---------------------------------------------------------------------------
// The three payload types that are conversation
// ---------------------------------------------------------------------------

test("a user message becomes one user event, carrying its text and timestamp", () => {
  const events = adapt([userMsg(39, "基于以下优化建议，对 Skill 内容进行局部优化。")]);
  assert.deepEqual(events, [
    {
      kind: "message",
      id: "39:0",
      role: "user",
      markdown: "基于以下优化建议，对 Skill 内容进行局部优化。",
      sidechain: false,
      timestamp: T0,
    },
  ]);
});

test("an assistant message with an output_text block becomes one assistant event", () => {
  const events = adapt([assistantMsg(9, "我会先梳理原 Skill 结构，再按要求做局部精简与补强。")]);
  assert.equal(events.length, 1);
  assert.equal(messages(events)[0].role, "assistant");
  assert.equal(messages(events)[0].markdown, "我会先梳理原 Skill 结构，再按要求做局部精简与补强。");
});

test("a message whose block array holds several text blocks emits one event per block", () => {
  // Measured: 2,556 `input_text` blocks across 1,981 user messages, so a
  // message can carry more than one — the blocks are drawn, not the record.
  const events = adapt([
    item(4, {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "<permissions instructions>" },
        { type: "input_text", text: "<skills_instructions>" },
      ],
    }),
  ]);
  assert.deepEqual(
    events.map((e) => e.id),
    ["4:0", "4:1"],
  );
  assert.deepEqual(
    messages(events).map((e) => e.markdown),
    ["<permissions instructions>", "<skills_instructions>"],
  );
});

test("an assistant message with no text block emits nothing", () => {
  assert.deepEqual(
    adapt([
      item(1, { type: "message", role: "assistant", content: [] }),
      item(2, { type: "message", role: "assistant", content: [{ type: "output_text" }] }),
    ]),
    [],
  );
});

test("a function_call becomes one tool event naming the call id and keeping arguments verbatim", () => {
  const events = adapt([call(17, "shell", "call_teqCUxx1X1OYPE7pvgpbaj5S", SHELL_ARGS)]);
  assert.equal(events.length, 1);
  const tool = tools(events)[0];
  assert.equal(tool.kind, "tool");
  assert.equal(tool.name, "shell");
  // The call id is both the event id and the key its result will arrive under.
  assert.equal(tool.id, "call_teqCUxx1X1OYPE7pvgpbaj5S");
  // Measured: `arguments` is a JSON **string**. `ToolEvent.input` promises the
  // value as the adapter found it, so the string is what must come out — an
  // adapter that parsed it would be handing the renderer a shape the record
  // never had, and would lose the fact that a half-written one is unparseable.
  assert.equal(typeof tool.input, "string");
  assert.equal(tool.input, SHELL_ARGS);
  assert.equal(tool.result, null);
  assert.equal(tool.timestamp, T0);
});

test("the timestamp is the record's own, and is null when it is missing or not a string", () => {
  const events = adapt([
    { type: "response_item", ordinal: 1, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "no clock" }] } },
    item(2, { type: "message", role: "user", content: [{ type: "input_text", text: "bad clock" }] }, { timestamp: 1776677448166 }),
  ]);
  assert.deepEqual(
    messages(events).map((e) => e.timestamp),
    [null, null],
  );
});

// ---------------------------------------------------------------------------
// Pairing — a call and its later result are one event
// ---------------------------------------------------------------------------

test("a call and its later output are one event, not two", () => {
  const events = adapt([
    call(17, "shell", "call_teqCUxx1X1OYPE7pvgpbaj5S", SHELL_ARGS),
    callOutput(19, "call_teqCUxx1X1OYPE7pvgpbaj5S", SHELL_OUTPUT),
  ]);
  assert.deepEqual(kindsOf(events), ["tool"]);
  const tool = tools(events)[0];
  assert.equal(tool.id, "call_teqCUxx1X1OYPE7pvgpbaj5S");
  assert.deepEqual(tool.result, { content: SHELL_OUTPUT, isError: false });
  // The output record carries its own timestamp; the event keeps the call's,
  // because the event *is* the call and the renderer shows when it was made.
  assert.equal(tool.timestamp, T0);
});

test("an output attaches to the matching call when two calls are in flight, out of order", () => {
  const events = adapt([
    call(10, "shell", "call_01_first", "{}"),
    call(11, "shell", "call_02_second", "{}"),
    callOutput(12, "call_02_second", "second"),
    callOutput(13, "call_01_first", "first"),
  ]);
  assert.deepEqual(
    tools(events).map((t) => [t.id, t.result?.content]),
    [
      ["call_01_first", "first"],
      ["call_02_second", "second"],
    ],
  );
});

test("an output naming no call the adapter holds is ignored", () => {
  // Either a malformed record or a result whose call fell outside the window
  // the reader is holding. Neither may become an event of its own.
  assert.deepEqual(adapt([callOutput(19, "call_never_called", SHELL_OUTPUT)]), []);
});

test("a call id written twice is one call, and its later output still attaches", () => {
  const events = adapt([
    call(10, "shell", "call_dup", SHELL_ARGS),
    call(11, "shell", "call_dup", SHELL_ARGS),
    callOutput(12, "call_dup", SHELL_OUTPUT),
  ]);
  assert.deepEqual(kindsOf(events), ["tool"]);
  assert.equal(tools(events)[0].result?.content, SHELL_OUTPUT);
});

// ---------------------------------------------------------------------------
// The duplicate write — the reason `event_msg` is never read
// ---------------------------------------------------------------------------

test("a transcript holding both spellings of one turn renders it once", () => {
  // The measured duplication, verbatim: `event_msg`/`item_completed` writes the
  // same body as the `response_item`/`message` that follows it, in a second
  // spelling (`AgentMessage`, block type `Text`). Both records are in this
  // fixture because both are in a real rollout — reading both would render the
  // turn twice, which is the failure this test exists to catch.
  const events = adapt([
    itemCompleted(8, "AgentMessage", "我会先梳理原 Skill 结构。"),
    assistantMsg(9, "我会先梳理原 Skill 结构。"),
    itemCompleted(5, "UserMessage", "对 Skill 内容进行局部优化。"),
    userMsg(3, "对 Skill 内容进行局部优化。"),
  ]);
  assert.equal(events.length, 2, "two turns written twice are two events, not four");
  assert.deepEqual(
    messages(events).map((e) => e.markdown),
    ["我会先梳理原 Skill 结构。", "对 Skill 内容进行局部优化。"],
  );
});

test("a turn only ever written as an item_completed emits nothing at all", () => {
  // The complement of the test above, and the one that pins the gate: this
  // adapter has no path that reads `event_msg`, so a body that exists only
  // there is invisible rather than half-rendered.
  assert.deepEqual(adapt([itemCompleted(5, "UserMessage", "写在 event_msg 里的正文")]), []);
});

// ---------------------------------------------------------------------------
// What is dropped
// ---------------------------------------------------------------------------

test("a reasoning record carrying a reasoning_text block becomes one thinking event", () => {
  // Measured: 2,294 reasoning records hold their body in
  // `content: [{type:"reasoning_text", text}]` and nowhere else.
  const events = adapt([
    item(7, {
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "用户报告了一个 UI Bug，先做根因调查。" }],
      encrypted_content: "gAAAAABm…",
    }),
  ]);
  assert.deepEqual(events, [
    {
      kind: "thinking",
      id: "7:0",
      markdown: "用户报告了一个 UI Bug，先做根因调查。",
      sidechain: false,
      timestamp: T0,
    },
  ]);
});

test("a reasoning record whose body is in summary becomes one thinking event", () => {
  // Measured: 3,150 records spell the same thing `summary: [{type:
  // "summary_text", text}]` with `content: null`. The two fields are mutually
  // exclusive — never both, in any of the 5,606 records — but the adapter
  // still reads content first and falls back to summary, so a record that ever
  // held both would render one thought rather than two.
  const events = adapt([
    item(11, {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "We need respond Chinese." }],
      content: null,
      encrypted_content: "gAAAAABm…",
    }),
  ]);
  assert.deepEqual(
    thinkings(events).map((e) => [e.id, e.markdown]),
    [["11:0", "We need respond Chinese."]],
  );
});

test("a reasoning record with only encrypted_content emits nothing", () => {
  // The 162 records (all April 2026) that are the fully-encrypted spelling:
  // nothing readable outside the ciphertext, so there is no event to draw.
  assert.deepEqual(adapt([reasoning(7)]), []);
  assert.deepEqual(
    thinkings(
      adapt([
        item(8, { type: "reasoning", summary: [], content: null, encrypted_content: "gAAAAABm…" }),
      ]),
    ),
    [],
  );
});

test("a reasoning record whose readable text is blank emits nothing", () => {
  // The same rule the Claude adapter applies to an empty thinking block: a
  // record with nothing to say is not an event with an empty body.
  assert.deepEqual(
    adapt([
      item(7, { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "  " }] }),
      item(8, {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "\n" }],
        content: null,
      }),
      item(9, {
        type: "reasoning",
        summary: [],
        // A block of the wrong type, and one of the right type with no text,
        // are both "no text here" — which falls through to the empty summary.
        content: [{ type: "text", text: "not the measured spelling" }],
      }),
    ]),
    [],
  );
});

test("a reasoning record is one thought, at most one event", () => {
  // Every measured readable record holds exactly one block (2,294 with a
  // one-element `content`, 3,150 with a one-element `summary`), so one record
  // is one thinking event, and its id ends in `:0` because there is no index
  // beyond the first.
  const events = adapt([
    item(7, { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "one" }] }),
  ]);
  assert.deepEqual(kindsOf(events), ["thinking"]);
  assert.equal(events[0].id, "7:0");
});

test("content is read before summary, and a blank content falls through to summary", () => {
  // Synthesised: no record in the corpus holds both fields, so this order is a
  // decision rather than a measurement. It is pinned because it is what keeps
  // "one record is one thought" true if a record ever does hold both — the
  // alternative, two events for one thought, would be a rendering bug nobody
  // could reproduce from today's data.
  const both = adapt([
    item(7, {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "from summary" }],
      content: [{ type: "reasoning_text", text: "from content" }],
    }),
  ]);
  assert.deepEqual(
    thinkings(both).map((e) => e.markdown),
    ["from content"],
  );

  const blank = adapt([
    item(7, {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "from summary" }],
      content: [{ type: "reasoning_text", text: "  " }],
    }),
  ]);
  assert.deepEqual(
    thinkings(blank).map((e) => e.markdown),
    ["from summary"],
  );
});

test("every non-conversation top-level record type produces no events", () => {
  const records: Rec[] = [
    {
      type: "session_meta",
      ordinal: 0,
      timestamp: T0,
      payload: { session_id: "019daa3a", cwd: "/Users/maqb11/code/qa/anc", cli_version: "0.77.0" },
    },
    { type: "turn_context", ordinal: 6, timestamp: T0, payload: { cwd: "/Users/maqb11/code/qa/anc" } },
    { type: "world_state", ordinal: 7, timestamp: T0, payload: {} },
    { type: "compacted", ordinal: 8, timestamp: T0, payload: {} },
    { type: "token_usage_record", ordinal: 9, timestamp: T0, payload: {} },
  ];
  for (const record of records) {
    assert.deepEqual(adapt([record]), [], `${String(record.type)} must not render`);
  }
});

test("every non-conversation event_msg produces no events", () => {
  const types = ["task_started", "token_count", "task_complete", "turn_aborted", "thread_settings_applied"];
  for (const type of types) {
    const record = {
      type: "event_msg",
      ordinal: 4,
      timestamp: T0,
      payload: { type, total_token_usage: 1234, item: { type: "AgentMessage" } },
    };
    assert.deepEqual(adapt([record]), [], `event_msg/${type} must not render`);
  }
});

test("an event_msg carrying a body that looks exactly like a turn is still dropped", () => {
  // The top-level `type` gate is load-bearing: an `event_msg` with a `message`
  // payload must not slip through on the payload alone.
  assert.deepEqual(
    adapt([
      {
        type: "event_msg",
        ordinal: 4,
        timestamp: T0,
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "pasted" }] },
      },
    ]),
    [],
  );
});

test("the response_item payload types this model does not draw produce no events", () => {
  // Measured alongside the three that are drawn: `custom_tool_call` (94),
  // `web_search_call` (14), `tool_search_call` (11), `tool_search_output` (11)
  // and `custom_tool_call_output` (94). They are tools by another protocol, and
  // this model has no shape for them, so they are skipped rather than guessed.
  const types = ["custom_tool_call", "custom_tool_call_output", "web_search_call", "tool_search_call", "tool_search_output"];
  for (const type of types) {
    assert.deepEqual(
      adapt([item(20, { type, call_id: "call_x", name: "shell", arguments: "{}" })]),
      [],
      type,
    );
  }
});

test("a developer message is not a turn and is dropped", () => {
  // Measured: `role` is `developer` on 181 records, and they carry the
  // permissions and skills instructions rather than anything the session said.
  // The model has two roles, user and assistant, and a third is not folded
  // into one of them.
  assert.deepEqual(
    adapt([
      item(3, {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions instructions>" }],
      }),
    ]),
    [],
  );
});

test("a message block with no text — an image — emits nothing", () => {
  // Measured: `input_image` blocks (`{type, image_url}`, 22 of them) carry no
  // text at all, and the model has nowhere to put one.
  assert.deepEqual(
    adapt([
      item(3, {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,…" }],
      }),
    ]),
    [],
  );
});

test("an empty or whitespace-only body produces no event", () => {
  assert.deepEqual(
    adapt([
      userMsg(1, "   "),
      assistantMsg(2, ""),
      item(3, { type: "message", role: "assistant", content: [{ type: "output_text", text: "\n" }] }),
    ]),
    [],
  );
});

test("a function_call without a name is not a call and is skipped", () => {
  assert.deepEqual(
    adapt([item(20, { type: "function_call", call_id: "call_noname", arguments: "{}" })]),
    [],
  );
});

// ---------------------------------------------------------------------------
// sidechain — the flag no Codex record carries
// ---------------------------------------------------------------------------

test("sidechain is false on every event, because no record states otherwise", () => {
  // Claude's `isSidechain` has no Codex counterpart in any of the 511 measured
  // rollouts: a Codex transcript holds one conversation, so the flag is a
  // constant rather than a field being read and missed.
  const events = adapt([
    userMsg(1, "a turn"),
    item(2, {
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "先想一下这个 lease 归谁管。" }],
      encrypted_content: "gAAAAABm…",
    }),
    call(3, "shell", "call_1", SHELL_ARGS),
    callOutput(4, "call_1", SHELL_OUTPUT),
    assistantMsg(5, "done"),
  ]);
  assert.deepEqual(kindsOf(events), ["message", "thinking", "tool", "message"]);
  for (const event of events) {
    assert.equal(event.sidechain, false, event.kind);
  }
});

// ---------------------------------------------------------------------------
// Identity — the model promises ids are unique, so the adapter must keep it
// ---------------------------------------------------------------------------

test("ids are unique across events of every kind", () => {
  const events = adapt([
    userMsg(1, "one"),
    assistantMsg(2, "two"),
    call(3, "shell", "call_1", "{}"),
    callOutput(4, "call_1", "out"),
    call(5, "shell", "call_2", "{}"),
  ]);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});

test("an event is named after the record's ordinal, not its position in the array", () => {
  // The reader may prepend earlier records (`loadEarlier`) or drop the ones it
  // no longer holds, and the view re-runs the adapter over whatever it has. An
  // id taken from the array index would change as the window moves and remount
  // every row; the ordinal is on every record and does not move.
  const records = [userMsg(400, "the first line of the window"), userMsg(401, "the second")];
  const events = adapt(records);
  assert.deepEqual(
    events.map((e) => e.id),
    ["400:0", "401:0"],
  );
  // The same records, handed over with an earlier line in front, keep their ids.
  assert.deepEqual(
    adapt([userMsg(399, "an earlier line"), ...records]).map((e) => e.id),
    ["399:0", "400:0", "401:0"],
  );
});

test("a record with no ordinal still gets a stable id from its position", () => {
  const events = adapt([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "bare" }] } },
  ]);
  assert.deepEqual(
    events.map((e) => e.id),
    ["r0:0"],
  );
});

// ---------------------------------------------------------------------------
// Malformed and unknown input — skipped, never thrown
// ---------------------------------------------------------------------------

test("a record that is not an object is skipped without throwing", () => {
  assert.deepEqual(adapt([null, undefined, 42, "type:response_item", [], true]), []);
});

test("a container that is not an array is returned empty rather than throwing", () => {
  for (const bad of [undefined, null, 42, "records", {}]) {
    assert.deepEqual(adapt(bad as unknown as unknown[]), []);
  }
});

test("records whose payload or content has the wrong type are skipped", () => {
  assert.deepEqual(
    adapt([
      item(1, {}),
      { type: "response_item", ordinal: 2, timestamp: T0, payload: "not an object" },
      { type: "response_item", ordinal: 3, timestamp: T0 },
      item(4, { type: "message", role: "user", content: "not an array" }),
      item(5, { type: "message", role: "user", content: [null, 42, "text"] }),
      // Blocks are objects, but not the measured shape.
      item(6, { type: "message", role: "user", content: [{ text: 42 }] }),
    ]),
    [],
  );
});

test("a function_call with the wrong field types is skipped rather than half-drawn", () => {
  assert.deepEqual(
    adapt([
      item(1, { type: "function_call", name: "shell", call_id: 42, arguments: "{}" }),
      item(2, { type: "function_call", name: "shell", call_id: "", arguments: "{}" }),
    ]),
    [],
  );
});

test("a call with no arguments or a non-string arguments is still a call", () => {
  // `arguments` is passed through as found, whatever it is: the promise is
  // verbatim, and a record mid-write has an empty or absent one.
  const events = adapt([
    item(1, { type: "function_call", name: "shell", call_id: "call_a" }),
    item(2, { type: "function_call", name: "shell", call_id: "call_b", arguments: 42 }),
  ]);
  assert.deepEqual(
    tools(events).map((t) => [t.id, t.input]),
    [
      ["call_a", undefined],
      ["call_b", 42],
    ],
  );
});

test("a function_call_output with no call_id pairs with nothing and emits nothing", () => {
  assert.deepEqual(
    adapt([
      item(1, { type: "function_call_output", output: SHELL_OUTPUT }),
      item(2, { type: "function_call_output", call_id: 42, output: SHELL_OUTPUT }),
    ]),
    [],
  );
});

test("an output that is not a string is flattened to an empty result rather than dropped", () => {
  // The call is still a call the renderer must draw — it happened. Only its
  // result is unreadable, and the model spells that as text it does not have.
  const events = adapt([
    call(1, "shell", "call_odd", "{}"),
    item(2, { type: "function_call_output", call_id: "call_odd", output: { exit_code: 1 } }),
  ]);
  assert.deepEqual(tools(events)[0].result, { content: "", isError: false });
});

test("invalid JSON is dropped before the adapter sees it", () => {
  // A rollout is written a line at a time, so a half-written line is normal
  // input. `parseRecord` returns `undefined` for it, and that must be as inert
  // as any other non-record.
  const record = parseRecord(
    new TextEncoder().encode('{"type":"response_item","payload":{"type":"message"'),
  );
  assert.equal(record, undefined);
  assert.deepEqual(adapt([record]), []);
});

test("an empty transcript adapts to nothing", () => {
  assert.deepEqual(adapt([]), []);
});

// ---------------------------------------------------------------------------
// End to end, over a rollout framed the way the reader frames one
// ---------------------------------------------------------------------------

test("a whole rollout, framed and parsed, adapts into its conversation", () => {
  // The verbatim record shapes of a real rollout, in file order: instructions,
  // a user turn and its `event_msg` echo, an assistant turn, a `shell` call and
  // its output, a reasoning record, and the plumbing between them.
  const lines = [
    JSON.stringify({
      type: "session_meta",
      ordinal: 0,
      timestamp: T0,
      payload: { session_id: "019daa3a", cwd: "/Users/maqb11/code/qa/anc" },
    }),
    JSON.stringify(userMsg(3, "基于以下优化建议，对 Skill 内容进行局部优化。")),
    JSON.stringify(itemCompleted(5, "UserMessage", "基于以下优化建议，对 Skill 内容进行局部优化。")),
    JSON.stringify({ type: "event_msg", ordinal: 4, timestamp: T0, payload: { type: "task_started" } }),
    JSON.stringify(assistantMsg(9, "我会先梳理原 Skill 结构。")),
    JSON.stringify(itemCompleted(8, "AgentMessage", "我会先梳理原 Skill 结构。")),
    JSON.stringify({
      type: "response_item",
      ordinal: 10,
      timestamp: T1,
      payload: {
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: "`rg` 不存在，换个命令。" }],
        encrypted_content: "gAAAAABm…",
      },
    }),
    JSON.stringify(call(11, "shell", "call_hWoHxoPxnoFoqg2vumnx08ZE", SHELL_ARGS)),
    JSON.stringify(callOutput(12, "call_hWoHxoPxnoFoqg2vumnx08ZE", SHELL_OUTPUT)),
    JSON.stringify({ type: "turn_context", ordinal: 13, timestamp: T0, payload: {} }),
    JSON.stringify({ type: "event_msg", ordinal: 14, timestamp: T0, payload: { type: "token_count" } }),
    JSON.stringify(assistantMsg(16, "`rg` 不可用，我改用基础命令快速定位内容。")),
    JSON.stringify({ type: "event_msg", ordinal: 34, timestamp: T0, payload: { type: "task_complete" } }),
  ];
  const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
  const { lines: framed } = frameLines(bytes);
  const events = adapt(framed.map(parseRecord));

  assert.deepEqual(kindsOf(events), ["message", "message", "thinking", "tool", "message"]);
  assert.equal(messages(events)[0].role, "user");
  assert.equal(messages(events)[0].markdown, "基于以下优化建议，对 Skill 内容进行局部优化。");
  assert.equal(thinkings(events)[0].markdown, "`rg` 不存在，换个命令。");
  assert.equal(tools(events)[0].name, "shell");
  assert.equal(tools(events)[0].input, SHELL_ARGS);
  assert.equal(tools(events)[0].result?.content, SHELL_OUTPUT);
  // The promise the renderer keys its flat list on, held by the real fixture.
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});

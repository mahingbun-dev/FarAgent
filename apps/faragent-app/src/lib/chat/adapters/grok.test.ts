/**
 * `chat/adapters/grok.ts` — turning a Grok `chat_history.jsonl` into events.
 *
 * The fixtures are built to the shapes the S0 spike **measured** from the real
 * session `~/.grok/sessions/<cwd>/01a09d76-2125-7ab1-881e-9a258ab09c6e/chat_history.jsonl`
 * (78 records), cross-checked against the other 72 Grok sessions on this machine
 * — 5,671 `tool_result`, 2,007 `assistant`, 2,019 `reasoning`, 393 `user`, 73
 * `system` and 8 `backend_tool_call` records in all. Where a shape is only
 * synthesised, or is one the corpus never showed, the fixture says so at the
 * spot: `unverified` for the error flag a `tool_result` might carry, and a
 * `synthesised` note where the corpus only ever had one spelling.
 *
 * The tests are ordered as the adapter's own decisions are: what becomes an
 * event, how a call is paired with its result, what is dropped, and that no
 * malformed input can make it throw.
 *
 * There is no registry section here. Registering `grok: adaptGrok` in
 * `adapters/index.ts` is that module's own change, and asserting `adapterFor`
 * from this file would make this suite fail the moment it lands.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent, MessageEvent, ThinkingEvent, ToolEvent } from "../events.ts";
import { frameLines, parseRecord } from "../transcript.ts";
import { adapt } from "./grok.ts";

type Rec = Record<string, unknown>;

/** A `user` record — measured: `content` is always a block array, one text block. */
function userText(text: string, extra: Rec = {}): Rec {
  return { type: "user", content: [{ type: "text", text }], ...extra };
}

/**
 * An `assistant` record — measured: `content` is a **bare string**, and the
 * calls sit beside it in their own array.
 */
function assistant(content: string, toolCalls?: unknown, extra: Rec = {}): Rec {
  return {
    type: "assistant",
    content,
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    model_id: "grok-4.6-build",
    model_fingerprint: "fp_08d0bc26c22b024e",
    reasoning_effort: "xhigh",
    ...extra,
  };
}

/**
 * A `reasoning` record — measured: the readable text is `summary[].text`, the
 * body itself is `encrypted_content`, and there is no `content` key at all.
 */
function reasoning(id: string, summary: unknown, extra: Rec = {}): Rec {
  return {
    type: "reasoning",
    id,
    summary,
    encrypted_content: "J6UMfSGQnu/FZPGKgTRmNt81EvF/HaHiE5ypbDhnfXgHZCHAcpOOT4HWMuApLqcv0OxbSnxMGg",
    status: "completed",
    ...extra,
  };
}

/**
 * A `tool_result` record — measured: exactly `type`, `tool_call_id`, `content`
 * (23 of the 5,671 also carry an `images` array), and **no error flag**.
 */
function toolResult(toolCallId: string, content: unknown, extra: Rec = {}): Rec {
  return { type: "tool_result", tool_call_id: toolCallId, content, ...extra };
}

/** A `tool_calls[]` entry — measured: `arguments` is a JSON **string**. */
function call(id: string, name: string, args: string): Rec {
  return { id, name, arguments: args };
}

/** A summary part — measured: always `{type: "summary_text", text}`. */
function summaryPart(text: string): Rec {
  return { type: "summary_text", text };
}

const kindsOf = (events: ChatEvent[]): string[] => events.map((e) => e.kind);
const messages = (events: ChatEvent[]): MessageEvent[] =>
  events.filter((e): e is MessageEvent => e.kind === "message");
const thinkings = (events: ChatEvent[]): ThinkingEvent[] =>
  events.filter((e): e is ThinkingEvent => e.kind === "thinking");
const tools = (events: ChatEvent[]): ToolEvent[] =>
  events.filter((e): e is ToolEvent => e.kind === "tool");

// ---------------------------------------------------------------------------
// Content shapes — a bare string, a block array, and a summary array
// ---------------------------------------------------------------------------

test("a user record's text block becomes one user message event", () => {
  const events = adapt([userText("<user_query>\n拉取远程最新变更\n</user_query>")]);
  assert.deepEqual(events, [
    {
      kind: "message",
      id: "r0:0",
      role: "user",
      markdown: "<user_query>\n拉取远程最新变更\n</user_query>",
      // No Grok record carries a time field, and none marks a sidechain.
      sidechain: false,
      timestamp: null,
    },
  ]);
});

test("an assistant record's bare-string content becomes one assistant message event", () => {
  // Grok's spelling is neither of Claude's two: it is a string, not a block
  // array. A fixture written as blocks would be testing the wrong shape.
  const events = adapt([assistant("工具链已就绪，开始编译 release。")]);
  assert.equal(events.length, 1);
  assert.equal(messages(events)[0].role, "assistant");
  assert.equal(messages(events)[0].markdown, "工具链已就绪，开始编译 release。");
  assert.equal(messages(events)[0].id, "r0:0");
  assert.equal(messages(events)[0].timestamp, null);
});

test("a harness-injected user record is still a user turn", () => {
  // Measured: 213 of the corpus's 393 user records carry `synthetic_reason` —
  // an injected `<system-reminder>` or monitor event — and the prompt the
  // person actually typed arrives in the same block shape wrapped in a
  // `<user_query>` tag. Nothing in the record separates them, so the adapter
  // does not pretend to: the injected turn renders, as the module doc says.
  const events = adapt([
    userText("<system-reminder>\nMCP servers connected: …", { synthetic_reason: "mcp_servers" }),
    userText("<user_query>\n拉取远程最新变更\n</user_query>", { prompt_index: 1 }),
  ]);
  assert.deepEqual(kindsOf(events), ["message", "message"]);
  assert.equal(messages(events).every((m) => m.role === "user"), true);
});

test("an assistant record whose content is empty emits no message", () => {
  // Load-bearing, not hygiene: 1,355 of the 2,007 measured assistant records
  // carry `content: ""` because the turn was pure tool calls. Emitting them
  // would put an empty row between most of the conversation's tool rows.
  const events = adapt([
    assistant("", [call("call-1", "read_file", '{"target_file":"/a"}')]),
    assistant("   "),
  ]);
  assert.deepEqual(kindsOf(events), ["tool"]);
});

test("an assistant record's tool_calls become tool events carrying arguments verbatim", () => {
  const args = '{"command":"cargo build --release","timeout":300000}';
  const events = adapt([assistant("", [call("call-1", "run_terminal_command", args)])]);
  assert.equal(events.length, 1);
  assert.equal(tools(events)[0].id, "call-1");
  assert.equal(tools(events)[0].name, "run_terminal_command");
  // `arguments` is a JSON *string*, not Claude's already-parsed `input` object.
  // `events.ts` promises the adapter keeps what it found, so it stays a string.
  assert.equal(typeof tools(events)[0].input, "string");
  assert.equal(tools(events)[0].input, args);
  assert.equal(tools(events)[0].result, null);
});

test("one assistant record's several tool_calls emit one tool event each", () => {
  // Measured: the sample's assistant records carry 1–3 calls beside their prose.
  const events = adapt([
    assistant("我先看项目结构和构建方式。", [
      call("call-0", "read_file", '{"target_file":"/a/SKILL.md"}'),
      call("call-1", "list_dir", '{"target_directory":"/repo"}'),
      call("call-2", "read_file", '{"target_file":"/b/SKILL.md"}'),
    ]),
  ]);
  assert.deepEqual(kindsOf(events), ["message", "tool", "tool", "tool"]);
  assert.deepEqual(
    tools(events).map((t) => t.id),
    ["call-0", "call-1", "call-2"],
  );
});

test("a reasoning record's summary parts join into one thinking event", () => {
  // The readable text lives in `summary[].text` — the field is neither
  // `thinking` (Claude) nor `content` (Codex), and `content` is absent here.
  const events = adapt([
    reasoning("rs_1", [summaryPart("The user wants a release build."), summaryPart("Let me read the README.")]),
  ]);
  assert.equal(events.length, 1);
  assert.equal(kindsOf(events)[0], "thinking");
  // Joined with a space: the renderer folds this to one row, so a newline
  // between parts would make the row's single line ambiguous.
  assert.equal(thinkings(events)[0].markdown, "The user wants a release build. Let me read the README.");
  assert.equal(thinkings(events)[0].sidechain, false);
  assert.equal(thinkings(events)[0].timestamp, null);
});

test("a reasoning record's own id names its event", () => {
  // Unlike `assistant` and `user`, a reasoning record is addressed: it carries
  // an `id`, which is a better name than the record's position.
  const events = adapt([reasoning("rs_a34b6c71", [summaryPart("Done. Summarize in Chinese.")])]);
  assert.equal(thinkings(events)[0].id, "rs_a34b6c71");
});

test("a reasoning record with an empty summary emits nothing", () => {
  // Measured: 13 of the corpus's 2,019 reasoning records have `summary: []`.
  // They are reasoning records whose summary was never produced; the encrypted
  // body is not readable here, so there is nothing to draw.
  assert.deepEqual(adapt([reasoning("rs_empty", [])]), []);
});

test("a reasoning record with nothing readable emits nothing", () => {
  assert.deepEqual(
    adapt([
      // Parts without a string `text` are skipped, so the join is empty.
      reasoning("rs_a", [{ type: "summary_text" }]),
      reasoning("rs_b", [{ type: "summary_text", text: "" }]),
      reasoning("rs_c", [42, "a string part"]),
      // `summary` is not an array at all — the shape has never been seen.
      reasoning("rs_d", "a summary"),
    ]),
    [],
  );
});

// ---------------------------------------------------------------------------
// Pairing — a call and its later result are one event
// ---------------------------------------------------------------------------

test("a tool call and its later result are one event, not two", () => {
  const events = adapt([
    assistant("", [call("call-11", "run_terminal_command", '{"command":"cargo build --release"}')]),
    toolResult(
      "call-11",
      "<task-id>call-11</task-id>\n<status>running</status>\n<summary>Command exceeded the default timeout.</summary>",
    ),
  ]);
  assert.equal(events.length, 1, "the result must not add a second event");
  const tool = tools(events)[0];
  assert.equal(tool.id, "call-11");
  assert.equal(tool.input, '{"command":"cargo build --release"}');
  assert.deepEqual(tool.result, {
    content: "<task-id>call-11</task-id>\n<status>running</status>\n<summary>Command exceeded the default timeout.</summary>",
    isError: false,
  });
});

test("results pair by tool_call_id when they arrive out of call order", () => {
  // Measured, and the reason pairing is a Map and not a position: the sample's
  // first assistant record calls -0, -1, -2, and the results land -2, -0, -1.
  const events = adapt([
    assistant("", [
      call("call-0", "read_file", '{"target_file":"/a"}'),
      call("call-1", "list_dir", '{"target_directory":"/repo"}'),
      call("call-2", "read_file", '{"target_file":"/b"}'),
    ]),
    toolResult("call-2", "b"),
    toolResult("call-0", "a"),
    toolResult("call-1", "repo"),
  ]);
  assert.deepEqual(kindsOf(events), ["tool", "tool", "tool"]);
  assert.deepEqual(
    tools(events).map((t) => [t.id, t.result?.content]),
    [
      ["call-0", "a"],
      ["call-1", "repo"],
      ["call-2", "b"],
    ],
  );
});

test("a tool_result whose tool_call_id matches no call is ignored", () => {
  assert.deepEqual(adapt([toolResult("call-3a145b09-never-called", "orphaned output")]), []);
});

test("an orphaned result drops out while the turns around it still read", () => {
  const events = adapt([
    toolResult("call-never-called", "orphaned output"),
    assistant("", [call("call-x", "grep", '{"pattern":"release"}')]),
    toolResult("call-x", "output"),
    userText("what did it say?"),
  ]);
  // The orphan adds nothing; the call gains its result; the turn is a turn.
  assert.deepEqual(kindsOf(events), ["tool", "message"]);
  assert.equal(tools(events)[0].id, "call-x");
  assert.equal(tools(events)[0].result?.content, "output");
  assert.equal(messages(events)[0].role, "user");
});

test("a tool_result's extra `images` key does not change its event", () => {
  // Measured: 23 of the 5,671 results carry an `images` array beside a string
  // `content`. `ToolResult` has one text field, so the images are not guessed
  // into it — the event is exactly the result it would have been without them.
  const events = adapt([
    assistant("", [call("call-img", "read_file", "{}")]),
    toolResult("call-img", "1→![diagram](d.png)", { images: [{ type: "image", data: "…" }] }),
  ]);
  assert.deepEqual(events, [
    {
      kind: "tool",
      id: "call-img",
      name: "read_file",
      input: "{}",
      result: { content: "1→![diagram](d.png)", isError: false },
      sidechain: false,
      timestamp: null,
    },
  ]);
});

test("a result is not an error, because no Grok record says it is", () => {
  // `unverified`: the one measured spelling of a `tool_result` is `type`,
  // `tool_call_id`, `content` — 5,671 records over 73 sessions, none with any
  // error flag. The corpus's one abnormal result (a harness cancellation) is
  // text inside `content`. `false` is therefore the conservative value, and it
  // is asserted here so that adding a real flag is a deliberate change.
  const events = adapt([
    assistant("", [call("call-err", "run_terminal_command", '{"command":"false"}')]),
    toolResult("call-err", "Tool execution was halted by the harness (user_cancel); the tool was not executed."),
  ]);
  assert.deepEqual(tools(events)[0].result, {
    content: "Tool execution was halted by the harness (user_cancel); the tool was not executed.",
    isError: false,
  });
});

// ---------------------------------------------------------------------------
// Identity — the model promises ids are unique, so the adapter must keep it
// ---------------------------------------------------------------------------

test("a call id written twice is one call, and its later result still attaches", () => {
  const events = adapt([
    assistant("", [call("call-dup", "read_file", '{"target_file":"/a"}')]),
    assistant("", [call("call-dup", "read_file", '{"target_file":"/a"}')]),
    toolResult("call-dup", "output"),
  ]);
  // The first call wins, and — the point — the result pairs with the call that
  // was actually emitted, not the one that was dropped.
  assert.deepEqual(kindsOf(events), ["tool"]);
  assert.equal(tools(events)[0].id, "call-dup");
  assert.equal(tools(events)[0].result?.content, "output");
});

test("the same message text twice is two turns, because no record id says otherwise", () => {
  // Measured: this happens for real. In one session the same assistant text
  // recurs 36 records apart, and the harness re-injects identical
  // `<system-reminder>` turns several times in a session. A Grok record carries
  // no uuid, so there is nothing that distinguishes "written twice" from "said
  // twice" — and positional ids are what keep the model's uniqueness promise
  // true either way. Deduping on the text would silently delete a real turn.
  const events = adapt([userText("拉取远程最新变更"), userText("拉取远程最新变更")]);
  assert.deepEqual(kindsOf(events), ["message", "message"]);
  assert.notEqual(events[0].id, events[1].id);
});

test("every id in a mixed transcript is unique", () => {
  const events = adapt([
    userText("拉取远程最新变更"),
    reasoning("rs_1", [summaryPart("The user wants the remote changes pulled.")]),
    assistant("工具链已就绪，开始编译 release。", [
      call("call-0", "read_file", '{"target_file":"/a"}'),
      call("call-1", "list_dir", '{"target_directory":"/repo"}'),
    ]),
    toolResult("call-1", "- /repo/\n  - Cargo.toml"),
    toolResult("call-0", "1→---\nname: using-superpowers"),
    reasoning("rs_2", [summaryPart("Done.")]),
    assistant("已拉取。"),
  ]);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});

test("an event's id survives an earlier window being prepended", () => {
  // This is what `firstIndex` is for, and it is not a detail: the renderer keys
  // its list on these ids and remembers the reader's scroll position by looking
  // its anchor's id up. A Grok record carries no id of its own, so an event here
  // is named after the record's *place* — and if that place were the array
  // index, `loadEarlier` would renumber the whole conversation. Every id would
  // move, the anchor's id would then name a different record, and scrolling up
  // would land the reader somewhere they never were.
  const first = [userText("A"), assistant("B")];
  const before = adapt(first, 0);
  assert.deepEqual(
    before.map((e) => e.id),
    ["r0:0", "r1:0"],
  );

  // The same two records, with an earlier window in front of them — which is
  // exactly the array `TranscriptTail` hands over after a `loadEarlier`, and the
  // index it hands over with it.
  const grown = [userText("X"), ...first];
  const after = adapt(grown, -1);
  assert.deepEqual(
    after.map((e) => e.id),
    ["r-1:0", "r0:0", "r1:0"],
    "the records already on screen kept their ids; only the newcomer took a new one",
  );
  assert.deepEqual(
    after.slice(1).map((e) => (e as MessageEvent).markdown),
    before.map((e) => (e as MessageEvent).markdown),
    "and the ids still name the same turns",
  );
});

// ---------------------------------------------------------------------------
// What is dropped
// ---------------------------------------------------------------------------

test("a system record produces no events", () => {
  // Measured: one per session — the system prompt itself, carrying a bare
  // string body that would otherwise look exactly like an assistant turn.
  assert.deepEqual(adapt([{ type: "system", content: "You are Grok 4.6 released by xAI." }]), []);
});

test("a backend_tool_call record produces no events", () => {
  // Measured in three sessions (8 records across the corpus, 5 of them in one):
  // the model's own server-side web search, with its hits inline in `kind`. It
  // is not a call this renderer can draw, and — measured — its result never
  // appears as a `tool_result`, so drawing it would be a row that never
  // resolves.
  assert.deepEqual(
    adapt([
      {
        type: "backend_tool_call",
        kind: { tool_type: "web_search", action: { type: "search", query: "claude code permission modes" } },
      },
    ]),
    [],
  );
});

test("a non-conversation type whose body looks like a turn is still dropped", () => {
  // The `type` gate is load-bearing, not the body's plausibility.
  assert.deepEqual(
    adapt([
      { type: "system", content: "pasted" },
      { type: "summary", content: "a compressed turn" },
      { type: "backend_tool_call", content: "a turn that is not one" },
    ]),
    [],
  );
});

// ---------------------------------------------------------------------------
// Malformed and unknown input — skipped, never thrown
// ---------------------------------------------------------------------------

test("a record that is not an object is skipped without throwing", () => {
  assert.deepEqual(adapt([null, undefined, 42, "type:assistant", [], true]), []);
});

test("a container that is not an array is returned empty rather than throwing", () => {
  // The caller is typed to pass an array; a value that is not one must still
  // not be the thing that throws, because that is the module's whole promise.
  for (const bad of [undefined, null, 42, "records", {}]) {
    assert.deepEqual(adapt(bad as unknown as unknown[]), []);
  }
});

test("a conversation record with a wrong-typed field is skipped", () => {
  assert.deepEqual(
    adapt([
      { type: "user", content: "a bare string, which user records never are" },
      { type: "user", content: [{ type: "text", text: 42 }] },
      { type: "user", content: [{ type: "image", source: {} }] },
      { type: "assistant", content: 42 },
      { type: "assistant", content: null, tool_calls: { id: "call-x" } },
      { type: "assistant", content: "", tool_calls: [{ id: "call-y" }] },
      { type: "tool_result", tool_call_id: 42, content: "output" },
      { type: "reasoning" },
    ]),
    [],
  );
});

test("an empty text block produces no event", () => {
  assert.deepEqual(adapt([userText("   "), assistant("")]), []);
});

test("a result whose content is not a string attaches as empty text", () => {
  // `content` is a string in every measured record (5,671 of them), so this is
  // a shape the corpus never showed. It still pairs — dropping the result would
  // leave the renderer saying "still running" about a tool that has finished —
  // and no text is invented for it.
  const events = adapt([
    assistant("", [call("call-n", "read_file", "{}")]),
    toolResult("call-n", undefined),
  ]);
  assert.deepEqual(tools(events)[0].result, { content: "", isError: false });
});

test("invalid JSON is dropped before the adapter sees it", () => {
  // A transcript is written a line at a time, so a half-written line is normal
  // input. `parseRecord` (which the tail feeds on) returns `undefined` for it,
  // and that `undefined` must be as inert as any other non-record.
  const record = parseRecord(
    new TextEncoder().encode('{"type":"assistant","content":"half'),
  );
  assert.equal(record, undefined);
  assert.deepEqual(adapt([record]), []);
});

test("an empty transcript adapts to nothing", () => {
  assert.deepEqual(adapt([]), []);
});

// ---------------------------------------------------------------------------
// End to end, over a verbatim excerpt of a real session
// ---------------------------------------------------------------------------

test("a verbatim excerpt of a real Grok session adapts into its conversation", () => {
  // Every record below is copied byte-for-byte out of
  // `~/.grok/sessions/%2FUsers%2Fmaqb11%2Fcode%2Fma-code%2FFarAgent/01a09d76-2125-7ab1-881e-9a258ab09c6e/chat_history.jsonl`.
  // The assistant record and its result are adjacent there (lines 26–27); the
  // user turn and the reasoning record are verbatim from elsewhere in the same
  // session. They go through the real byte path — `frameLines` then
  // `parseRecord` — so this is the pipeline the app runs, not a shortcut
  // around it.
  const jsonl = [
    `{"type": "user", "content": [{"type": "text", "text": "<user_query>\\n拉取远程最新变更\\n</user_query>"}], "prompt_index": 1}`,
    `{"type": "reasoning", "id": "rs_a34b6c71-e5e7-9906-a3f4-ac7d3a2ce58d", "summary": [{"type": "summary_text", "text": "Done. Summarize in Chinese."}], "encrypted_content": "J6UMfSGQnu/FZPGKgTRmNt81EvF/HaHiE5ypbDhnfXgHZCHAcpOOT4HWMuApLqcv0OxbSnxMGg", "status": "completed"}`,
    `{"type": "assistant", "content": "工具链已就绪，开始编译 release。", "tool_calls": [{"id": "call-3a145b09-df87-4e05-ab09-db48ae2562b4-11", "name": "run_terminal_command", "arguments": "{\\"command\\":\\"cargo build --release\\",\\"description\\":\\"Build FarAgent release binary\\",\\"timeout\\":300000}"}], "model_id": "grok-4.6-build", "model_fingerprint": "fp_08d0bc26c22b024e", "reasoning_effort": "xhigh"}`,
    `{"type": "tool_result", "tool_call_id": "call-3a145b09-df87-4e05-ab09-db48ae2562b4-11", "content": "<task-id>call-3a145b09-df87-4e05-ab09-db48ae2562b4-11</task-id>\\n<task-type>bash</task-type>\\n<output-file>/Users/maqb11/.grok/sessions/%2FUsers%2Fmaqb11%2Fcode%2Fma-code%2FFarAgent/01a09d76-2125-7ab1-881e-9a258ab09c6e/terminal/call-3a145b09-df87-4e05-ab09-db48ae2562b4-11.log</output-file>\\n<status>running</status>\\n<summary>Command \\"cargo build --release\\" exceeded the default timeout and was automatically moved to background. Process is still running.</summary>\\nUse get_command_or_subagent_output with task_ids=[\\"call-3a145b09-df87-4e05-ab09-db48ae2562b4-11\\"] when you need the output."}`,
  ].join("\n") + "\n"; // ends in a newline: a final line without one is held as a partial, not parsed

  const { lines } = frameLines(new TextEncoder().encode(jsonl));
  const records = lines.map(parseRecord);
  assert.equal(records.length, 4, "every line must survive framing");
  const events = adapt(records);

  assert.deepEqual(kindsOf(events), ["message", "thinking", "message", "tool"]);
  assert.equal(messages(events)[0].markdown, "<user_query>\n拉取远程最新变更\n</user_query>");
  assert.equal(messages(events)[1].markdown, "工具链已就绪，开始编译 release。");
  assert.equal(thinkings(events)[0].markdown, "Done. Summarize in Chinese.");
  // The call and its result are one event, with the argument left unparsed.
  assert.equal(tools(events)[0].id, "call-3a145b09-df87-4e05-ab09-db48ae2562b4-11");
  assert.equal(typeof tools(events)[0].input, "string");
  assert.match(tools(events)[0].result?.content ?? "", /<status>running<\/status>/);
  assert.deepEqual(events.map((e) => e.timestamp), [null, null, null, null]);
  assert.deepEqual(events.map((e) => e.sidechain), [false, false, false, false]);
  // The model promises a renderer may key a flat list on `id`; the real
  // fixture must hold that too, not just the hand-built ones.
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});

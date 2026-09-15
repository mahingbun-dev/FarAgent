/**
 * The Grok (xAI) transcript adapter.
 *
 * Turns the records of a `~/.grok/sessions/<percent-encoded-cwd>/<id>/chat_history.jsonl`
 * into the unified model in `../events.ts`. Grok's file is called a chat
 * *history* and is what its docs describe as "raw chat messages sent to the
 * model", which is exactly the four shapes below and nothing else.
 *
 * The shapes are the ones measured from a real 78-record session, then
 * cross-checked against the other 72 Grok sessions on this machine — 73 in all,
 * holding 5,671 `tool_result`, 2,007 `assistant`, 2,019 `reasoning`, 393 `user`,
 * 73 `system` and 8 `backend_tool_call` records. Where the spike's notes and the
 * corpus disagreed the corpus won, and the disagreement is called out at the
 * field.
 *
 * ## What is conversation, and what is not
 *
 * Only `user`, `assistant`, `reasoning` and `tool_result` records are
 * conversation. `system` is the system prompt itself (one per session, a bare
 * string body that would otherwise read exactly like an assistant turn) and is
 * dropped, as is `backend_tool_call` — the model's own server-side web search,
 * measured in three sessions (8 records) and named nowhere in the spec's table
 * of Grok record types. Everything else, known or not, is dropped too: the gate
 * is the four `type`s above, not the plausibility of a body.
 *
 * ## The four shapes
 *
 * Measured verbatim:
 *
 * ```
 * user         {"type":"user","content":[{"type":"text","text":"…"}]}
 * assistant    {"type":"assistant","content":"<bare string>",
 *               "tool_calls":[{"id":"call-…","name":"read_file",
 *                              "arguments":"<JSON string>"}],
 *               "model_id":"grok-4.6-build","reasoning_effort":"xhigh"}
 * reasoning    {"type":"reasoning","id":"rs_…",
 *               "summary":[{"type":"summary_text","text":"…"}],
 *               "encrypted_content":"…"}
 * tool_result  {"type":"tool_result","tool_call_id":"call-…","content":"…"}
 * ```
 *
 * `assistant.content` being a **bare string** is a third spelling, distinct
 * from both of Claude's (string or block array). A `user` record's `content` is
 * always a block array — 393 of 393 — and always one `text` block.
 *
 * A `user` record may additionally carry `synthetic_reason` or `prompt_index`
 * (213 of the 393 do). Those mark a turn the harness injected — a re-injected
 * `<system-reminder>`, a monitor event — rather than one the person typed, and
 * they are **still rendered**. The model was shown them and this transcript is
 * what the model saw; nothing measured separates an injected turn worth hiding
 * from a typed one, since the records are identical in shape, and the real
 * prompt arrives wrapped in a `<user_query>` tag inside the same block shape.
 *
 * ## Where the call is, and how it pairs
 *
 * The call is not a content block: it sits beside the prose in an
 * `assistant.tool_calls[]` array, and its `arguments` is a JSON **string**
 * where Claude's `tool_use.input` is already parsed. `events.ts` promises
 * `ToolEvent.input` is kept as the adapter found it, so the string is passed
 * through unparsed — a renderer that wants a `command` reads it from the key it
 * knows after parsing it itself.
 *
 * The pairing key is `tool_calls[].id` ↔ `tool_result.tool_call_id`. The
 * records carry no uuid, so nothing else could join them, and **the results are
 * not in call order**: in the sample's first assistant record the calls are
 * `-0, -1, -2` while the following results are `-2, -0, -1`. That is why the
 * adapter walks the whole transcript once, keeps the calls it has emitted in a
 * map, and fills each one's result when its record turns up, rather than
 * assuming a result follows its call.
 *
 * A `tool_result` naming no call the adapter holds is **ignored**: no event, no
 * error. That covers a malformed record and a result whose call fell outside
 * the tail window the reader is holding.
 *
 * ## Reasoning
 *
 * A `reasoning` record's readable text is `summary[].text`. The field is
 * neither Claude's `thinking` nor Codex's `content` — there is no `content` key
 * on the record at all, and the body itself is `encrypted_content`. The parts
 * are joined **with a space**, in order, skipping any part without a non-empty
 * string `text`: the renderer folds reasoning to one row, so a newline between
 * parts would make that row's single line ambiguous. Measured, the join is one
 * part 2,006 times and an empty `summary` 13 times — and an empty join emits
 * **no event**, because there is then nothing readable to draw.
 *
 * ## The error flag that is not there
 *
 * `isError` is always `false`, and that is a **conservative, unverified** value
 * rather than a finding. All 5,671 measured `tool_result` records carry exactly
 * `type`, `tool_call_id`, `content` (23 also carry an `images` array) — none
 * carries any error flag, and no Grok documentation describes one: the user
 * guide's session chapter lists `chat_history.jsonl` as raw chat messages, and
 * the only `is_error` it documents is in the Claude-compatible headless
 * `stream-json` output, a different surface. The one bundled reader that does
 * parse tool results — `~/.grok/bundled/skills/shared/resume-session/session_reader.py`
 * — reads `is_error` for Claude's records and `success is False` for Codex's,
 * and has no Grok branch at all. The corpus's one abnormal result — a harness
 * cancellation — is plain text inside `content`. So a failure is believed to be
 * expressed in the text, and if Grok ever adds a flag this adapter must be
 * taught it rather than having guessed at one now.
 *
 * ## There is no time, and no sidechain
 *
 * `timestamp` is `null` on every event, and that is not a defect: no measured
 * Grok record has any time field — the whole key set an `assistant` record ever
 * shows is `type`, `content`, `tool_calls`, `model_id`, `model_fingerprint`,
 * `reasoning_effort` (with `tool_calls` and the last two absent from some
 * records), and no type in the corpus has a time or a uuid. Parsing one would
 * be parsing a field that does not exist, which is why this paragraph is here.
 * The session's times live in its `summary.json` (`created_at`, `updated_at`),
 * which is not this file.
 *
 * `sidechain` is always `false` for the same kind of reason: there is no such
 * flag in a record. Grok's subagents get their own session directories, so
 * their conversations arrive as their own transcripts rather than as records
 * inside this one.
 *
 * ## Totality
 *
 * The transcript is a file another program is writing while the app reads it.
 * A half-written record, an unknown type, a field of the wrong type or a record
 * written twice is **expected input**, not a bug, so every one of them is
 * skipped. `adapt` never throws, for any input — including a container that is
 * not an array at all, or a record that is not an object.
 */
import type { ChatEvent, ToolEvent } from "../events.ts";

/** True for a plain JSON object — the only shape a record or block may have. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Join a `reasoning` record's `summary` parts into the one line the renderer
 * draws.
 *
 * Measured items are `{type: "summary_text", text}`; anything without a
 * non-empty string `text` contributes nothing rather than being stringified.
 * The separator is a single space: the renderer folds reasoning into one row,
 * so newlines between the parts would leave that row's one visible line
 * depending on which part happened to come first.
 */
function joinSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  const parts: string[] = [];
  for (const item of summary) {
    if (isObject(item) && typeof item.text === "string" && item.text.trim() !== "") {
      parts.push(item.text);
    }
  }
  return parts.join(" ");
}

/**
 * Turn a Grok `chat_history.jsonl`'s records into events.
 *
 * Records are taken in file order and each is flattened into zero or more
 * events, so an assistant record carrying prose and three tool calls emits four
 * in that order. A record that is not conversation — or is malformed in any way
 * — contributes nothing. Never throws.
 */
export function adapt(records: unknown[], firstIndex = 0): ChatEvent[] {
  // The caller is typed to hand over an array, but this value crosses a file
  // another program is writing: guarding the container is the same promise as
  // guarding the records, and it is one line.
  if (!Array.isArray(records)) return [];

  const events: ChatEvent[] = [];
  /** Calls emitted but not yet resolved, so a later result can find its call. */
  const callsById = new Map<string, ToolEvent>();
  /**
   * Every id emitted, which is what makes the model's uniqueness promise true.
   *
   * A call id or a reasoning id written twice — the transcript is appended to
   * while we read it — would otherwise produce two events a flat list cannot
   * key apart. **The first wins**: that is the event `callsById` already points
   * at, so a later result still pairs with a call that was emitted rather than
   * one that was dropped.
   */
  const emittedIds = new Set<string>();

  records.forEach((record, recordIndex) => {
    if (!isObject(record)) return;

    // A Grok record is not addressed: it has no uuid, and an assistant record's
    // keys are only `type`/`content`/`tool_calls`/`model_id`/… — so its place in
    // the file is the only stable name it has, and it is enough for a list key.
    // Two records with identical bodies are two turns, not one written twice:
    // the corpus holds a repeated `<system-reminder>` turn and an assistant turn
    // whose text recurs 36 records later, and both are real.
    //
    // **`firstIndex`, not `recordIndex`.** This array is a *window* onto a file
    // the reader can extend in both directions, and `loadEarlier` prepends to
    // it. Numbering by position in this array would renumber the whole
    // conversation every time an earlier window landed — `r0:0` would come to
    // name a different record than it did a frame ago — and the renderer keys
    // its list on these ids and remembers the reader's scroll position by them.
    // `firstIndex` is the index of `records[0]`, so the records already on
    // screen keep the number they had.
    //
    // (A reasoning record and a tool call *are* addressed, and use their own id.)
    const recordId = `r${firstIndex + recordIndex}`;

    switch (record.type) {
      case "user": {
        const content = record.content;
        if (!Array.isArray(content)) return;
        content.forEach((block, blockIndex) => {
          if (!isObject(block) || block.type !== "text") return;
          if (typeof block.text !== "string" || block.text.trim() === "") return;
          const id = `${recordId}:${blockIndex}`;
          if (emittedIds.has(id)) return;
          emittedIds.add(id);
          events.push({
            kind: "message",
            id,
            role: "user",
            markdown: block.text,
            sidechain: false,
            timestamp: null,
          });
        });
        return;
      }

      case "assistant": {
        // A bare string is a whole turn's prose: one message. Load-bearing that
        // an empty one emits nothing — 1,355 of the corpus's 2,007 assistant
        // records are `content: ""`, a pure tool-call turn, and rendering each
        // would put an empty row between most of the conversation's tool rows.
        const content = record.content;
        if (typeof content === "string" && content.trim() !== "") {
          const id = `${recordId}:0`;
          if (!emittedIds.has(id)) {
            emittedIds.add(id);
            events.push({
              kind: "message",
              id,
              role: "assistant",
              markdown: content,
              sidechain: false,
              timestamp: null,
            });
          }
        }

        // The calls are a separate array beside the prose, not blocks inside it.
        const calls = record.tool_calls;
        if (!Array.isArray(calls)) return;
        calls.forEach((call, callIndex) => {
          if (!isObject(call)) return;
          // A call with no name is not a call the renderer could draw.
          if (typeof call.name !== "string") return;
          // The call's own id is its event id as well as its pairing key; a
          // call without one still gets a stable name from its position.
          const callId =
            typeof call.id === "string" && call.id !== ""
              ? call.id
              : `${recordId}:call${callIndex}`;
          // The same call written twice is one call: `callsById` still points
          // at the event already emitted, so a later result still pairs.
          if (emittedIds.has(callId)) return;
          emittedIds.add(callId);
          const event: ToolEvent = {
            kind: "tool",
            id: callId,
            name: call.name,
            // `arguments` is a JSON string, passed through exactly as found:
            // its shape is the tool's, and `events.ts` promises no parsing.
            input: call.arguments,
            result: null,
            sidechain: false,
            timestamp: null,
          };
          callsById.set(callId, event);
          events.push(event);
        });
        return;
      }

      case "reasoning": {
        const markdown = joinSummary(record.summary);
        // An empty join is a record with nothing readable in it (measured 13
        // times, `summary: []`): emitting a blank row would claim the model
        // reasoned and said nothing.
        if (markdown.trim() === "") return;
        const id =
          typeof record.id === "string" && record.id !== "" ? record.id : recordId;
        if (emittedIds.has(id)) return;
        emittedIds.add(id);
        events.push({
          kind: "thinking",
          id,
          markdown,
          sidechain: false,
          timestamp: null,
        });
        return;
      }

      case "tool_result": {
        if (typeof record.tool_call_id !== "string") return;
        // A result with no matching call emits nothing at all — not a message,
        // not an orphan event. Grok has no record type that carries a result
        // any other way, so this is also why an unmatched result cannot be
        // recovered later in the file.
        const event = callsById.get(record.tool_call_id);
        if (!event) return;
        event.result = {
          // A string in every measured record. Anything else is a shape the
          // corpus never showed; it still pairs, with no text invented for it,
          // because a dropped result would leave the row saying "still running"
          // about a tool that has already finished.
          content: typeof record.content === "string" ? record.content : "",
          // Always false. Unverified, and deliberately conservative: no measured
          // record and no Grok documentation describes an error flag, and the
          // corpus's one abnormal result is text inside `content`. See the
          // module doc before changing this.
          isError: false,
        };
        return;
      }

      default:
        // `system` (the system prompt), `backend_tool_call` (the model's own
        // server-side web search), and any future type: not something this
        // model draws, so dropped rather than guessed at.
        return;
    }
  });

  return events;
}

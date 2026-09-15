/**
 * The Codex rollout adapter.
 *
 * Turns the records `lib/chat/transcript.ts` parsed out of a rollout JSONL into
 * the unified model in `../events.ts`.
 *
 * Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` —
 * filed by date, not grouped under a cwd the way Claude's are. The shapes below
 * are the ones 511 real rollouts on this machine **measured**, not the ones the
 * rollout protocol is remembered to have. Where the two disagree the corpus
 * wins and the disagreement is called out at the field.
 *
 * ## What is conversation, and what is not
 *
 * The top-level `type` is one of `session_meta`, `turn_context`, `event_msg`,
 * `world_state`, `compacted`, `token_usage_record` and `response_item`, and
 * **only `response_item` is read**. Everything else is plumbing: `session_meta`
 * (the session's cwd, cli version and git head), `turn_context` (one per turn),
 * `world_state`, `compacted`, `token_usage_record`, and the `event_msg` stream
 * of `task_started` / `token_count` / `task_complete` / `turn_aborted` /
 * `thread_settings_applied`. None of them is a turn, and the gate is the top
 * level `type`, not the payload's — an `event_msg` whose payload happens to
 * look like a message must not slip through on its payload alone.
 *
 * Inside a `response_item` there are more payload types than the four this
 * model draws. Measured alongside them: `custom_tool_call` and
 * `custom_tool_call_output` (94 each), `web_search_call` (14),
 * `tool_search_call` and `tool_search_output` (11 each). They are tool traffic
 * in other protocols and this model has no shape for them, so they are skipped
 * rather than guessed at.
 *
 * ## Why `event_msg` is not read: the text is written twice
 *
 * Verified record by record: every completed turn is written **twice**. Once as
 * an `event_msg` `item_completed` — `payload.item.type` is `UserMessage` or
 * `AgentMessage`, and its blocks are spelled `Text` — and once as the
 * `response_item` `message` that follows it, with the identical body string. In
 * one measured rollout, 370 `item_completed` records and 638 `message` records
 * carry the same conversation between them.
 *
 * Reading both spellings renders every turn twice. So this adapter reads
 * `response_item` only, and `event_msg` is not merely deprioritised — there is
 * no code path here that looks inside one. A body that exists only as an
 * `item_completed` (a rollout caught mid-write, between the two writes) is
 * therefore invisible for a moment rather than half-rendered, which is the
 * right way round: the next poll of the tail sees the `response_item` and the
 * turn appears once.
 *
 * ## The four payload types that are drawn
 *
 * Measured verbatim; `arguments` is a **string**, not an object:
 *
 * ```
 * message              {"type":"message","role":"user"|"assistant",
 *                        "content":[{"type":"input_text"|"output_text","text":"…"}]}
 * function_call        {"type":"function_call","name":"shell",
 *                        "arguments":"<JSON string>","call_id":"call_…"}
 * function_call_output {"type":"function_call_output","call_id":"call_…",
 *                        "output":"<JSON string>"}
 * reasoning            {"type":"reasoning","summary":[…],"content":[…],
 *                        "encrypted_content":"<ciphertext>"}
 * ```
 *
 * Inside a `message`, the block types are `input_text` (2,556 measured, all in
 * user and developer messages) and `output_text` (9,882, all in assistant
 * messages), so the text is taken from `block.text` and a block without one is
 * skipped — which is what happens to the 22 measured `input_image` blocks
 * (`{type, image_url}`, no text at all). The role gate is `user` and
 * `assistant` only: `role` is `developer` on 181 measured records, and those
 * carry the permissions and skills instructions rather than anything the
 * session said.
 *
 * ## Reasoning: where the body actually is
 *
 * The model renders a Codex `reasoning` record as a `ThinkingEvent`, and this
 * is the measurement that decides where its text comes from. Of the 5,606
 * `reasoning` records across the corpus, there are exactly **three** measured
 * spellings, and which one a rollout holds tracks its date:
 *
 * | `summary`                              | `content`                          | records | seen from |
 * | -------------------------------------- | ---------------------------------- | ------- | --------- |
 * | `[]`                                   | `null`                             | 162     | 2026-04   |
 * | `[]`                                   | `[{type:"reasoning_text",text}]`   | 2,294   | 2026-06   |
 * | `[{type:"summary_text",text}]`         | `null`                             | 3,150   | 2026-06   |
 *
 * Three things follow from that table:
 *
 * 1. **The body is readable on 97% of records.** Only the 162 April records
 *    are the fully-encrypted spelling, with nothing outside
 *    `encrypted_content`. An earlier design measured that batch alone and
 *    concluded Codex reasoning "is always encrypted, so it cannot be drawn" —
 *    the sample was unrepresentative, and reasoning is drawn.
 * 2. **The two readable fields are mutually exclusive** — no record in the
 *    corpus carries both. So the adapter reads `content` first and falls back
 *    to `summary`, which is the right order to write even though the fallback
 *    is not exercised today: a record that one day holds both must still be one
 *    thought, not two.
 * 3. **The block types are fixed and must be matched.** The text block is
 *    `reasoning_text` inside `content` and `summary_text` inside `summary`.
 *    Reading `block.text` without checking `block.type` would also pick up
 *    anything a future record puts there, which is guessing; the same rule
 *    makes a record whose body is blank produce no event at all, matching how
 *    `claude.ts` treats an empty thinking block.
 *
 * One record is one thought: every measured readable record holds exactly one
 * block, so it emits exactly one event, named `"<ordinal>:0"`.
 *
 * ## Pairing
 *
 * A call and its output are two records, joined by `function_call.call_id` ↔
 * `function_call_output.call_id`. The output normally arrives after the call
 * (sometimes in a much later record), so the adapter walks the whole transcript
 * once, holding the calls it has emitted in a map and filling each one's result
 * when its record turns up. An output that names no call the adapter holds is
 * **ignored** — no event, no error — which covers both a malformed record and a
 * result whose call fell outside the window the reader is holding.
 *
 * A call's `call_id` is also its event `id`. A `function_call_output` carries
 * **no error flag** in any measured record: the closest thing is an
 * `exit_code` inside the `output` JSON string, which this adapter does not
 * parse (the whole string is passed through verbatim) and does not interpret.
 * `isError` is therefore the conservative `false`, unverified against the
 * protocol rather than measured from it.
 *
 * ## Identity and `sidechain`
 *
 * Events are named after the record's top-level `ordinal` — present, unique and
 * monotonic within every measured rollout (61,982 records, no duplicates) —
 * rather than its position in the array the reader hands over. The reader can
 * prepend earlier records (`loadEarlier`) or drop ones it no longer holds, and
 * the view re-runs the adapter over whatever it has: an index-derived id would
 * change under it and remount every row it names. A record with no `ordinal`
 * falls back to its position, which is all a list key needs.
 *
 * `sidechain` is `false` on every event. No Codex record carries a subagent
 * flag the way Claude's `isSidechain` does — a rollout holds one conversation —
 * so this is a constant, not a field read and missed.
 *
 * ## Totality
 *
 * The rollout is a file another program is writing while the app reads it. A
 * half-written record, an unknown payload or block type, a field of the wrong
 * type or a record written twice is **expected input**, not a bug, so every one
 * of them is skipped. `adapt` never throws, for any input — including a
 * container that is not an array at all, or a record that is not an object.
 */
import type { ChatEvent, MessageEvent, ThinkingEvent, ToolEvent } from "../events.ts";

/** True for a plain JSON object — the only shape a record, payload or block may have. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The text of the first block of `type` in `blocks`, or `null` when there is
 * none.
 *
 * `null` and `""` mean different things here and the difference is what makes
 * the fallback below correct: `null` is "this field holds no text block", while
 * a returned string is what the record actually says. A blank block counts as
 * no text — the same rule `claude.ts` applies to an empty thinking block — so a
 * record whose `content` is a blank `reasoning_text` still consults its
 * `summary` instead of emitting an empty thought.
 */
function blockText(blocks: unknown, type: string): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (!isObject(block)) continue;
    // Matching `type` as well as reading `text` is deliberate: `text` alone
    // would also pick up whatever a future record puts in the array.
    if (block.type !== type) continue;
    if (typeof block.text !== "string" || block.text.trim() === "") continue;
    return block.text;
  }
  return null;
}

/**
 * A `reasoning` record's readable body, or `""` when it has none.
 *
 * Measured: 97% of the corpus's reasoning records carry readable text, in one
 * of two mutually exclusive places — `content`'s `reasoning_text` block (2,294
 * records) or `summary`'s `summary_text` block (3,150). `content` is read
 * first because it is the newer spelling and the one carried forward; the
 * `summary` fallback is unexercised against today's corpus but is what makes
 * "one record is one thought" true for a record that ever holds both. The
 * remaining 162 records (April 2026) spell nothing readable at all and come
 * back as `""`.
 */
function reasoningText(payload: Record<string, unknown>): string {
  return blockText(payload.content, "reasoning_text") ?? blockText(payload.summary, "summary_text") ?? "";
}

/**
 * Turn a Codex rollout's records into events.
 *
 * Records are taken in file order and each is flattened into zero or more
 * events. Only `response_item` records are looked at, and within them only the
 * `message`, `function_call`, `function_call_output` and `reasoning` payloads;
 * everything else — including every `event_msg`, which holds a second write of
 * the same conversation — contributes nothing. Never throws.
 */
export function adapt(records: unknown[]): ChatEvent[] {
  // The caller is typed to hand over an array, but this value crosses a file
  // another program is writing: guarding the container is the same promise as
  // guarding the records, and it is one line.
  if (!Array.isArray(records)) return [];

  const events: ChatEvent[] = [];
  /** Calls emitted but not yet resolved, so a later output can find its call. */
  const callsById = new Map<string, ToolEvent>();
  /**
   * Every id emitted, which is what makes the model's uniqueness promise true.
   *
   * The transcript is written while we read it, so the same record can reach
   * the adapter twice — a `call_id` written again, or the same record handed
   * over by two reads of the tail. Without this the second would emit an event
   * whose id collides with the first as a flat-list key. **The first wins**:
   * that is the event `callsById` already points at, so a later output still
   * pairs with a call that was emitted rather than one that was dropped.
   */
  const emittedIds = new Set<string>();

  records.forEach((record, recordIndex) => {
    if (!isObject(record)) return;
    // The one top-level type that is conversation. `event_msg` is deliberately
    // not among the types read — it repeats the same text, see the module doc.
    if (record.type !== "response_item") return;

    const payload = record.payload;
    if (!isObject(payload)) return;

    // No Codex record states that it belongs to a subagent, so this is a
    // constant rather than a field being read.
    const sidechain = false;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
    // The record's `ordinal` names its events; a record without one still gets
    // stable ids from its position, which is all a list key needs.
    const recordId =
      typeof record.ordinal === "number" && Number.isFinite(record.ordinal)
        ? String(record.ordinal)
        : `r${recordIndex}`;

    switch (payload.type) {
      case "message": {
        // Two roles, and a third measured one (`developer`) that is
        // instructions rather than a turn.
        const role = payload.role;
        if (role !== "user" && role !== "assistant") return;

        const content = payload.content;
        if (!Array.isArray(content)) return;

        content.forEach((block, blockIndex) => {
          if (!isObject(block)) return;
          // `block.type` is `input_text` or `output_text` in every measured
          // record and the text is the same field in both. A block without a
          // string `text` — an `input_image` — is skipped like any other shape
          // this model does not draw.
          if (typeof block.text !== "string" || block.text.trim() === "") return;
          const id = `${recordId}:${blockIndex}`;
          if (emittedIds.has(id)) return;
          emittedIds.add(id);
          const event: MessageEvent = {
            kind: "message",
            id,
            role,
            markdown: block.text,
            sidechain,
            timestamp,
          };
          events.push(event);
        });
        return;
      }
      case "function_call": {
        // A call with no name is not a call the renderer could draw, and a call
        // with no `call_id` is one whose output could never find it.
        if (typeof payload.name !== "string") return;
        const callId = payload.call_id;
        if (typeof callId !== "string" || callId === "") return;
        // The same call written twice is one call: `callsById` still points at
        // the event already emitted, so a later output still pairs.
        if (emittedIds.has(callId)) return;
        emittedIds.add(callId);
        const event: ToolEvent = {
          kind: "tool",
          id: callId,
          name: payload.name,
          // `arguments` is a JSON **string** here, unlike Claude's
          // `tool_use.input`, which is already an object. `ToolEvent.input`
          // promises the value as the adapter found it, so it is passed through
          // unparsed — parsing it would hand the renderer a shape the record
          // never had, and would turn a half-written call into a lost one.
          input: payload.arguments,
          result: null,
          sidechain,
          timestamp,
        };
        callsById.set(callId, event);
        events.push(event);
        return;
      }
      case "function_call_output": {
        if (typeof payload.call_id !== "string") return;
        // An output with no matching call emits nothing at all — not a
        // message, not an orphan event.
        const event = callsById.get(payload.call_id);
        if (!event) return;
        event.result = {
          // `output` is a JSON string in every measured record and is kept
          // whole; a record whose output is not a string has no text to show.
          content: typeof payload.output === "string" ? payload.output : "",
          // Unverified: no measured record carries an error signal. See the
          // module doc.
          isError: false,
        };
        return;
      }
      case "reasoning": {
        const markdown = reasoningText(payload);
        // A record with nothing readable — the fully-encrypted spelling, or a
        // blank body — is not an event with an empty thought.
        if (markdown === "") return;
        // One record is one thought: every measured readable record holds
        // exactly one block, so there is no index but the first.
        const id = `${recordId}:0`;
        if (emittedIds.has(id)) return;
        emittedIds.add(id);
        const event: ThinkingEvent = {
          kind: "thinking",
          id,
          markdown,
          sidechain,
          timestamp,
        };
        events.push(event);
        return;
      }
      default:
        // Every payload type this model has no shape for: `custom_tool_call`,
        // `web_search_call`, `tool_search_*` and whatever comes next.
        return;
    }
  });

  return events;
}

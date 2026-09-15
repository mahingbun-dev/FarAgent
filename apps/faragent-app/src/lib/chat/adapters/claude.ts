/**
 * The Claude Code transcript adapter.
 *
 * Turns the records `lib/chat/transcript.ts` parsed out of a session's
 * `.jsonl` into the unified model in `../events.ts`.
 *
 * The shapes below are the ones the S0 spike **measured** from a real
 * 15,000-line Claude session, not the ones Claude Code transcripts are
 * remembered to have. Where the spike and memory disagree, the spike wins and
 * the disagreement is called out at the field.
 *
 * ## What is conversation, and what is not
 *
 * Only `user` and `assistant` records are conversation. The measured session
 * also held `system` (hook summaries), `queue-operation`, `attachment`,
 * `last-prompt`, `custom-title` and `atis-latch` records — 400-odd of them, and
 * rendering any as a message would be the obvious way to get this wrong. They
 * are dropped by accepting exactly those two `type`s.
 *
 * ## The four shapes
 *
 * Measured verbatim; `message.content` is sometimes a bare string and sometimes
 * an array of blocks, and both spellings occur:
 *
 * ```
 * user  text       {"type":"user","message":{"role":"user","content":"<string>"}}
 * assistant text   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 * tool_use         {"type":"assistant","message":{"content":[
 *                    {"type":"tool_use","id":"call_…","name":"Bash","input":{…}}]}}
 * tool_result      {"type":"user","message":{"content":[
 *                    {"type":"tool_result","tool_use_id":"call_…","content":"<string>"}]}}
 * ```
 *
 * ## Pairing
 *
 * A call and its result are two records, and the key that joins them is
 * `tool_use.id` ↔ `tool_result.tool_use_id` — **not** the record `uuid`. The
 * spike measured 215 calls and 215 results, paired 1:1 by that key. The result
 * normally arrives *after* the call (sometimes in a much later record), so the
 * adapter walks the whole transcript once, keeping the calls it has emitted in
 * a map and filling each one's result when its record turns up.
 *
 * A `tool_result` that names no call the adapter holds is **ignored**: it
 * produces no event and no error. That covers both a malformed record and a
 * result whose call fell outside the tail window the reader is holding.
 *
 * ## Totality
 *
 * The transcript is a file another program is writing while the app reads it.
 * A half-written record, an unknown block type or a field of the wrong type is
 * **expected input**, not a bug, so every one of them is skipped. `adapt` never
 * throws, for any input.
 */
import type { ChatEvent, ToolEvent } from "../events.ts";

/** True for a plain JSON object — the only shape a record or block may have. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten a `tool_result`'s `content` to text.
 *
 * The spike's sample is a plain string. The field is also written as a block
 * array (the shape the Anthropic API uses for a result that mixes text and
 * images), so the array is joined from its text parts and anything without text
 * — an image block — contributes nothing. This keeps the string out of the
 * renderer's hands without the model having to know what an image is.
 */
function flattenResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (isObject(block) && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Turn a Claude transcript's records into events.
 *
 * Records are taken in file order and each is flattened into zero or more
 * events, so an assistant record carrying text, thinking and a tool call
 * together emits all three in block order. A record that is not conversation —
 * or is malformed in any way — contributes nothing. Never throws.
 */
export function adapt(records: unknown[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  /** Calls emitted but not yet resolved, so a later result can find its call. */
  const callsById = new Map<string, ToolEvent>();

  records.forEach((record, recordIndex) => {
    if (!isObject(record)) return;
    const type = record.type;
    if (type !== "user" && type !== "assistant") return;

    const message = record.message;
    if (!isObject(message)) return;

    const sidechain = record.isSidechain === true;
    const timestamp =
      typeof record.timestamp === "string" ? record.timestamp : null;
    // The record's `uuid` names its events; a record without one still gets
    // stable ids from its position, which is all a list key needs.
    const recordId =
      typeof record.uuid === "string" ? record.uuid : `r${recordIndex}`;
    const role =
      message.role === "assistant"
        ? "assistant"
        : message.role === "user"
          ? "user"
          : type;

    const content = message.content;

    // A bare string is a whole turn's prose: one message.
    if (typeof content === "string") {
      if (content.trim() !== "") {
        events.push({
          kind: "message",
          id: `${recordId}:0`,
          role,
          markdown: content,
          sidechain,
          timestamp,
        });
      }
      return;
    }

    if (!Array.isArray(content)) return;

    content.forEach((block, blockIndex) => {
      if (!isObject(block)) return;
      const id = `${recordId}:${blockIndex}`;
      switch (block.type) {
        case "text": {
          if (typeof block.text !== "string" || block.text.trim() === "") return;
          events.push({
            kind: "message",
            id,
            role,
            markdown: block.text,
            sidechain,
            timestamp,
          });
          return;
        }
        case "thinking": {
          // The spike names the `thinking` block but not the field holding its
          // text (Claude writes `thinking`; older traces spell it `text`), so
          // either string is accepted and an empty one is dropped.
          const text =
            typeof block.thinking === "string"
              ? block.thinking
              : typeof block.text === "string"
                ? block.text
                : "";
          if (text.trim() === "") return;
          events.push({ kind: "thinking", id, markdown: text, sidechain, timestamp });
          return;
        }
        case "tool_use": {
          // A call with no name is not a call the renderer could draw.
          if (typeof block.name !== "string") return;
          // The call's own id is its event id as well as its pairing key.
          const callId =
            typeof block.id === "string" && block.id !== "" ? block.id : id;
          const event: ToolEvent = {
            kind: "tool",
            id: callId,
            name: block.name,
            input: block.input,
            result: null,
            sidechain,
            timestamp,
          };
          callsById.set(callId, event);
          events.push(event);
          return;
        }
        case "tool_result": {
          if (typeof block.tool_use_id !== "string") return;
          // A result with no matching call emits nothing at all — not a
          // message, not an orphan event. This is also why the `user` record
          // that carries a result never shows up as a user turn.
          const event = callsById.get(block.tool_use_id);
          if (!event) return;
          event.result = {
            content: flattenResultContent(block.content),
            isError: block.is_error === true,
          };
          return;
        }
        default:
          // An unknown block type (image, redacted_thinking, a future kind) is
          // not something this model draws; it is skipped, not guessed at.
          return;
      }
    });
  });

  return events;
}

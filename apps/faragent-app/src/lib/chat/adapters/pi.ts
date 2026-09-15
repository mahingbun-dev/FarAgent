/**
 * The Pi transcript adapter.
 *
 * Turns the records `lib/chat/transcript.ts` parsed out of a session's `.jsonl`
 * into the unified model in `../events.ts`.
 *
 * ## This adapter is built from a document, and says so
 *
 * Every other adapter here was written against a transcript read off a disk,
 * and each records where a shape was seen — a real 15,000-line Claude session,
 * 511 Codex rollouts, 73 Grok sessions. **This one had no such sample.** Pi was
 * not installed on the development machine, and once it was, the credentials to
 * run a session were not available to us: the local Anthropic auth belongs to
 * the Claude desktop app's own proxy, and Pi is refused by it. So the shapes
 * below come from Pi's own documentation — `docs/session-format.md`, shipped
 * inside `@mariozechner/pi-coding-agent` — and nowhere else.
 *
 * The distinction is worth keeping visible rather than tidying away. A shape
 * read from a document has never been contradicted by a real file, which is a
 * strictly weaker thing than a shape read from one, and this directory already
 * holds an example of how much weaker: the Codex adapter first recorded that
 * `reasoning` bodies were always encrypted, generalising from one month's
 * records, and the other ten months disproved it. Everything here that the
 * documentation does not pin down is marked `unverified` in the tests and at
 * the field. Whoever first points FarAgent at a real Pi session should read
 * those markers as a checklist.
 *
 * ## What is conversation, and what is not
 *
 * Only entries with `type === "message"` are conversation. A Pi file also holds
 * a leading `SessionHeader` (`type: "session"`, carrying the cwd and version),
 * `model_change`, `thinking_level_change`, `compaction` and `branch_summary`
 * entries — metadata about the session, not turns anyone took. They are dropped
 * by accepting exactly the one entry type that holds a message.
 *
 * Within a message, only `role` `user`, `assistant` and `toolResult` are read.
 * Pi also writes four extension roles — `bashExecution`, `custom`,
 * `branchSummary`, `compactionSummary` — and all four are dropped. The model has
 * exactly two speaking roles, and folding a shell command the *reader* ran, or
 * an extension's own output, into one of them would misreport who spoke. Note
 * that dropping `bashExecution` is a decision and not a fact about the format:
 * it is something the reader really did, and a renderer could reasonably want
 * it; teaching this adapter to draw it is a mapping change, not a bug fix.
 *
 * ## Pairing
 *
 * A call and its result are two entries, joined by `toolCall.id` ↔
 * `toolResult.toolCallId`. As in `claude.ts`, the file is walked once with the
 * emitted calls held in a map, so the two do not have to be adjacent — and a
 * result naming no held call is **ignored**, which is also why the entry
 * carrying it never shows up as a turn.
 *
 * ## The tree, and what this adapter does with it
 *
 * Pi's entries are a **tree**, not a chain: each carries `id` and `parentId`,
 * and `/fork`, `/clone` and compaction leave branches interleaved in one file.
 * This adapter draws entries in file order and does not attempt to find the
 * branch that is "current".
 *
 * That is a deliberate simplification, and it is the honest one today. Finding
 * the current branch means walking `parentId` back from the newest entry, and
 * getting it right also means following `compaction`'s `firstKeptEntryId` and
 * honouring `branch_summary`'s `fromId` — a derivation this adapter's author
 * could not check against a single real file. Drawing what the file holds is
 * verifiable from the documentation alone; drawing a *reconstructed* branch
 * would be a guess wearing the clothes of a fact. The consequence is that a
 * forked session shows the abandoned path too, and is to be fixed when a real
 * forked session can be read.
 *
 * ## Totality
 *
 * The transcript is a file another program is writing while the app reads it.
 * A half-written entry, an unknown block type, a field of the wrong type or an
 * entry written twice is **expected input**, not a bug, so every one of them is
 * skipped. `adapt` never throws, for any input — including a container that is
 * not an array at all, or a record that is not an object.
 */
import type { ChatEvent, ThinkingEvent, ToolEvent } from "../events.ts";

/** True for a plain JSON object — the only shape a record, message or block may have. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten content to text, taking the `text` of the blocks that have it.
 *
 * Pi spells a message body two ways: `UserMessage.content` is
 * `string | (Text | Image)[]`, and a tool result's content is a block array.
 * Both come through here. A block without string `text` — an image — is skipped
 * for the same reason `claude.ts` skips one: the model carries a string, and an
 * image has no string to contribute.
 *
 * Parts are joined with a newline, which is what a result's several text blocks
 * visually are.
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    // Matching `type` as well as reading `text` is deliberate: `text` alone
    // would pick up whatever a future block puts in the array.
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") continue;
    parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Turn a Pi session's records into events.
 *
 * Records are taken in file order and each is flattened into zero or more
 * events, so an assistant entry carrying reasoning, prose and a call emits all
 * three in block order. Anything that is not a `message` entry — or is
 * malformed in any way — contributes nothing. Never throws.
 *
 * `firstIndex` is the index of `records[0]` in the tail window, used only to
 * name a message that somehow carries no `id` of its own; a Pi entry normally
 * has one, which is a stable name and the one this adapter prefers.
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
   * The transcript is written while we read it, so the same entry can reach the
   * adapter twice. Without this the second would emit an event whose id
   * collides with the first as a flat-list key. **The first wins**: that is the
   * event `callsById` already points at, so a later result still pairs with a
   * call that was emitted rather than one that was dropped.
   */
  const emittedIds = new Set<string>();

  records.forEach((record, recordIndex) => {
    if (!isObject(record)) return;
    // The one entry type that holds a turn. The header and the session's
    // metadata entries are deliberately not among the types read.
    if (record.type !== "message") return;

    const message = record.message;
    if (!isObject(message)) return;

    // Pi's entries carry an ISO `timestamp`; the message's own `timestamp` is
    // unix milliseconds and is not the model's spelling, so the entry's is used.
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
    // No Pi record states that it belongs to a subagent — a subagent runs as its
    // own session with its own file — so this is a constant, not a field read.
    const sidechain = false;
    // The entry's `id` (8 hex characters) names its events. An entry without one
    // still gets stable ids from its position, which is all a list key needs.
    const recordId =
      typeof record.id === "string" && record.id !== "" ? record.id : `r${firstIndex + recordIndex}`;

    const role = message.role;

    // A tool result is not a turn: it is the other half of a call that has
    // already been drawn, and it fills that row in place.
    if (role === "toolResult") {
      const callId = message.toolCallId;
      if (typeof callId !== "string") return;
      const event = callsById.get(callId);
      if (!event) return;
      event.result = {
        content: flattenContent(message.content),
        // `isError` is documented on `ToolResultMessage`, so unlike the Codex
        // and Grok adapters this one reads the format's own error signal rather
        // than defaulting. Unverified: no measured record carries it.
        isError: message.isError === true,
      };
      return;
    }

    // The two speaking roles. Every other role — `bashExecution`, `custom`,
    // `branchSummary`, `compactionSummary` — is an extension's record rather
    // than a turn, and folded into either role it would misreport who spoke.
    if (role !== "user" && role !== "assistant") return;

    const content = message.content;

    // A bare string is a whole turn's prose: one message. `UserMessage`
    // documents this spelling and `AssistantMessage` documents only a block
    // array — but the string is read for either role, because when it appears it
    // is unambiguous, and dropping a turn over which spelling a release chose
    // would be the worse failure. `claude.ts` reads it the same way.
    if (typeof content === "string") {
      const id = `${recordId}:0`;
      if (content.trim() !== "" && !emittedIds.has(id)) {
        emittedIds.add(id);
        events.push({ kind: "message", id, role, markdown: content, sidechain, timestamp });
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
          if (emittedIds.has(id)) return;
          emittedIds.add(id);
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
          // The field is `thinking`, not `text` — the same spelling Claude uses
          // (`{"type":"thinking","thinking":"…"}`), and the one Pi documents. No
          // other spelling is guessed at: a block whose text is elsewhere is
          // skipped like any other shape this model does not draw.
          if (typeof block.thinking !== "string" || block.thinking.trim() === "") return;
          if (emittedIds.has(id)) return;
          emittedIds.add(id);
          const event: ThinkingEvent = {
            kind: "thinking",
            id,
            markdown: block.thinking,
            sidechain,
            timestamp,
          };
          events.push(event);
          return;
        }
        case "toolCall": {
          // A call with no name is not a call the renderer could draw, and a
          // call with no id is one whose result could never find it.
          if (typeof block.name !== "string") return;
          const callId = block.id;
          if (typeof callId !== "string" || callId === "") return;
          // The call's own id is its event id as well as its pairing key.
          if (emittedIds.has(callId)) return;
          emittedIds.add(callId);
          const event: ToolEvent = {
            kind: "tool",
            id: callId,
            name: block.name,
            // Documented as `Record<string, any>` — an object, unlike Codex's
            // JSON string. Kept as found because `events.ts` promises exactly
            // that, and the shape belongs to the tool rather than to this model.
            input: block.arguments,
            result: null,
            sidechain,
            timestamp,
          };
          callsById.set(callId, event);
          events.push(event);
          return;
        }
        default:
          // Images, and whatever a future Pi release adds.
          return;
      }
    });
  });

  return events;
}

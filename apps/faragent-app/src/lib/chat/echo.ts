/**
 * The optimistic echo: showing a sent message before the transcript has it.
 *
 * The composer writes keystrokes to the remote agent's TUI, and the transcript
 * is written by the agent once it has *taken* the input — a beat later, and
 * sometimes much later. Rendering only the transcript therefore means pressing
 * Enter shows nothing at all, which reads as a broken send button. So the
 * composer appends the message to the list itself, and this module is how that
 * local copy is reconciled with the real one.
 *
 * ## The reconciliation, and why it cannot show a message twice
 *
 * A pending echo carries, besides its text, one number: `seen` — how many user
 * messages with *that exact text* the conversation already accounted for at the
 * moment it was sent. That count is the transcript's own matching messages
 * **plus** the echoes already in flight, which is what makes two sends of the
 * same text in quick succession behave: the second's baseline is the first's
 * plus one, so the first is absorbed by the first transcript record and the
 * second waits for the second.
 *
 * An echo is then absorbed exactly when the transcript's count for its text
 * rises **above** its `seen`. Until then it is drawn; from then on it is gone,
 * because the transcript now holds the real record — which is the same sentence,
 * since a message is recorded as it was typed. The two can never both be drawn:
 * the row the reader sees is either the echo or the transcript's own event, and
 * the moment the latter exists the former stops qualifying.
 *
 * ## What this cannot do, said plainly
 *
 * The match is **exact text, top-level only**. A remote that rewritten the
 * message on its way into the transcript — Claude Code appends context blocks
 * to some prompts — will not absorb the echo, and the message will appear twice
 * until the pane is reopened. The alternative (absorb the next user event
 * whatever it says) is worse: the terminal is still live, so a message typed
 * there would quietly eat an unrelated echo. A visible duplicate is a better
 * failure than a silently swallowed line.
 *
 * Pure: `node --test` drives it with hand-built rows.
 */
import type { MessageEvent } from "./events.ts";
import type { ChatItem } from "./sidechain.ts";

/**
 * A message the composer sent that the transcript has not accounted for yet.
 *
 * `id` is the row's identity — the echo and the transcript event it becomes are
 * never on screen together, so the id only has to be unique among echoes and
 * distinct from an adapter's ids (it is prefixed `echo:`; a transcript event's
 * id is a record uuid, which has no such prefix).
 */
export interface PendingEcho {
  id: string;
  /** The message, exactly as it was typed — the string the transcript is matched on. */
  text: string;
  /** Occurrences of `text` already accounted for when this was sent. */
  seen: number;
}

/**
 * The text of a **top-level user message** row, or `null` for any other row.
 *
 * Top-level on purpose: a subagent's transcript can carry a `user` record too
 * (its own prompt), and that is not the reader's message. Only the main thread's
 * user turns can be the record an echo becomes.
 */
function userText(item: ChatItem): string | null {
  if (item.kind !== "event") return null;
  if (item.event.kind !== "message") return null;
  return item.event.role === "user" ? item.event.markdown : null;
}

/** How many top-level user messages in `items` say exactly `text`. */
export function transcriptCount(items: readonly ChatItem[], text: string): number {
  let count = 0;
  for (const item of items) {
    if (userText(item) === text) count += 1;
  }
  return count;
}

/**
 * The `seen` baseline for a message being sent now: what the transcript holds
 * plus the echoes already in flight, so a second identical send waits for the
 * second record rather than sharing the first's.
 */
export function seenFor(
  pending: readonly PendingEcho[],
  items: readonly ChatItem[],
  text: string,
): number {
  return (
    transcriptCount(items, text) +
    absorb(pending, items).filter((echo) => echo.text === text).length
  );
}

/**
 * The echoes the transcript has **not** yet accounted for.
 *
 * Order is preserved, so a queue of identical sends is consumed oldest-first:
 * the transcript's first matching record absorbs the first echo and the count
 * comparisons do the rest.
 */
export function absorb(
  pending: readonly PendingEcho[],
  items: readonly ChatItem[],
): PendingEcho[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const text = userText(item);
    if (text === null) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return pending.filter((echo) => (counts.get(echo.text) ?? 0) <= echo.seen);
}

/**
 * One echo as the row the conversation draws.
 *
 * A `MessageEvent` like any other user turn, so it is drawn by the same
 * `ChatRow` and looks identical to the record it will become — which is the
 * point: the reconciliation replaces one row with an equal one, and a reader
 * watching must not see it change.
 */
export function echoItem(echo: PendingEcho): ChatItem {
  const event: MessageEvent = {
    kind: "message",
    id: echo.id,
    role: "user",
    markdown: echo.text,
    sidechain: false,
    // The transcript's own timestamp is the file's; an echo has only "now",
    // which nothing draws (the conversation renders no times), so it is null
    // rather than a clock reading that would be a lie the moment it mattered.
    timestamp: null,
  };
  return { kind: "event", id: echo.id, event };
}

/** The rows for a list of live echoes, in order. */
export function echoItems(pending: readonly PendingEcho[]): ChatItem[] {
  return pending.map(echoItem);
}

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
 * messages that count as *the same message* the conversation already accounted
 * for at the moment it was sent. That count is the transcript's own matching
 * messages **plus** the echoes already in flight, which is what makes two sends
 * of the same text in quick succession behave: the second's baseline is the
 * first's plus one, so the first is absorbed by the first transcript record and
 * the second waits for the second.
 *
 * An echo is then absorbed exactly when the transcript's count for it rises
 * **above** its `seen`. Until then it is drawn; from then on it is gone, because
 * the transcript now holds the real record. The two can never both be drawn: the
 * row the reader sees is either the echo or the transcript's own event, and the
 * moment the latter exists the former stops qualifying.
 *
 * ## What "the same message" means here
 *
 * The record is **not** always byte-identical to what was typed, and requiring
 * it to be is a guaranteed duplicate: the TUI's line buffer eats trailing
 * spaces, a paste's CRLF can arrive as LF, a message typed across lines can be
 * recorded with its newlines collapsed, and a slash command reaches the
 * transcript as the verb alone (`/compact`, with the argument the TUI took
 * itself). `sameMessage` therefore compares **normalised** text — line endings
 * and runs of whitespace — and, for a slash line on both sides, the command word
 * alone. Case, punctuation and word order are left alone: two messages that
 * differ in those are two messages, and absorbing one would be worse than
 * showing two.
 *
 * ## What this cannot do, said plainly
 *
 * Two differences are named and **not** matched, because matching them would
 * mean guessing:
 *
 * - **A rewrite that keeps the typed text and appends to it.** Claude Code
 *   injects context blocks into some prompts, and what lands in the transcript
 *   is then the message plus a payload. A "starts with" rule would absorb a
 *   *later, shorter* message into an earlier echo — the terminal is still live,
 *   so that is not hypothetical.
 * - **A send the remote splits into several messages.** A composer send is one
 *   payload with one trailing CR, but a remote that treats an interior LF as a
 *   second submission records two messages, neither of which is the echo.
 *
 * Both leave the echo on screen beside the real record until the pane is
 * reopened: a duplicate the reader can see, over a line silently swallowed.
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

/**
 * The key two spellings of the same message share.
 *
 * Normalises line endings and runs of whitespace, and nothing else: a record
 * can lose a trailing space to the TUI's line buffer, arrive with the LF of a
 * CRLF, or be recorded with a message's newlines collapsed, and none of those is
 * a different message. Case, punctuation and word order are untouched —
 * normalising those would make distinct messages the same, which is a worse
 * error than a duplicate.
 */
export function matchKey(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

/** The command word of a slash line: `/compact focus on tests` → `/compact`. */
function commandVerb(key: string): string {
  const space = key.indexOf(" ");
  return space === -1 ? key : key.slice(0, space);
}

/**
 * Whether `record` — the text of a transcript's user turn — is that transcript's
 * copy of the message `text`.
 *
 * Normalised equality, plus one bounded rule: a slash command's record carries
 * the verb alone, because the TUI takes the argument itself and what reaches the
 * transcript is `/compact`. The rule needs a slash line on *both* sides, so it
 * can only ever match another slash line — never a sentence, however short.
 *
 * Returns `false` for an empty either side: an empty message absorbs nothing.
 */
export function sameMessage(text: string, record: string): boolean {
  const key = matchKey(text);
  const other = matchKey(record);
  if (key === "" || other === "") return false;
  if (key === other) return true;
  return (
    key.startsWith("/") &&
    other.startsWith("/") &&
    commandVerb(key) === commandVerb(other)
  );
}

/** How many top-level user messages in `items` are the message `text`. */
export function transcriptCount(items: readonly ChatItem[], text: string): number {
  let count = 0;
  for (const item of items) {
    const record = userText(item);
    if (record !== null && sameMessage(text, record)) count += 1;
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
    absorb(pending, items).filter((echo) => sameMessage(text, echo.text)).length
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
  const records: string[] = [];
  for (const item of items) {
    const text = userText(item);
    if (text !== null) records.push(text);
  }
  return pending.filter(
    (echo) => records.filter((record) => sameMessage(echo.text, record)).length <= echo.seen,
  );
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

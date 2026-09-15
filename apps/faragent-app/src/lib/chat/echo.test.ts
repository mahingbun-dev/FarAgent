/**
 * The optimistic echo, and the one property that matters: a message is never on
 * screen twice.
 *
 * The composer shows a sent message immediately (the transcript is written by
 * the agent a beat later, so without this pressing Enter shows nothing) and
 * drops its own copy when the real record arrives. The failure this file exists
 * to make impossible is the obvious one — both drawn at once, one above the
 * other, which is what a reader would report as "my message got sent twice".
 *
 * So the tests are written as the two halves of that claim:
 *
 * - the **counts** are right (only top-level user turns, and only ones that are
 *   the same message — see the whitespace and slash-verb cases below), and
 * - the **rows** are right: for a sent message, `items` plus the surviving
 *   echoes name it exactly once, both before and after the transcript catches
 *   up.
 *
 * Pure: hand-built rows, no channel, no timers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageEvent, ThinkingEvent } from "./events.ts";
import type { ChatItem } from "./sidechain.ts";
import {
  absorb,
  echoItem,
  echoItems,
  matchKey,
  sameMessage,
  seenFor,
  transcriptCount,
  type PendingEcho,
} from "./echo.ts";

let serial = 0;
const nextId = (): string => `x${(serial += 1)}`;

function event(row: MessageEvent | ThinkingEvent): ChatItem {
  return { kind: "event", id: row.id, event: row };
}

function user(text: string): ChatItem {
  return event({
    kind: "message",
    id: nextId(),
    role: "user",
    markdown: text,
    sidechain: false,
    timestamp: null,
  });
}

function assistant(text: string): ChatItem {
  return event({
    kind: "message",
    id: nextId(),
    role: "assistant",
    markdown: text,
    sidechain: false,
    timestamp: null,
  });
}

function thinking(text: string): ChatItem {
  return event({
    kind: "thinking",
    id: nextId(),
    markdown: text,
    sidechain: false,
    timestamp: null,
  });
}

function toolRun(): ChatItem {
  return { kind: "tools", id: nextId(), events: [] };
}

function sidechain(items: ChatItem[]): ChatItem {
  return { kind: "sidechain", id: nextId(), items };
}

const echo = (text: string, seen = 0): PendingEcho => ({ id: nextId(), text, seen });

/** What the reader actually sees: the transcript's rows, then the live echoes. */
function drawn(items: readonly ChatItem[], pending: readonly PendingEcho[]): ChatItem[] {
  return [...items, ...echoItems(absorb(pending, items))];
}

/** How many rows (transcript or echo) say exactly `text` as a user message. */
function countText(items: readonly ChatItem[], text: string): number {
  let count = 0;
  for (const item of items) {
    if (item.kind !== "event") continue;
    if (item.event.kind !== "message" || item.event.role !== "user") continue;
    if (item.event.markdown === text) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------- what counts

test("only a top-level user turn of exactly that text counts", () => {
  const items = [
    user("hi"),
    assistant("hi"),
    thinking("hi"),
    toolRun(),
    user("hi there"),
  ];

  assert.equal(transcriptCount(items, "hi"), 1);
  assert.equal(transcriptCount(items, "hi there"), 1);
  // Exact, not a prefix or a case-fold: the record has to be *this* message.
  assert.equal(transcriptCount(items, "h"), 0);
  assert.equal(transcriptCount(items, "HI"), 0);
  assert.equal(transcriptCount(items, "nothing says this"), 0);
});

test("a subagent's user record is not the reader's message", () => {
  // A sidechain can carry a `user` record of its own — the prompt the subagent
  // was given. Counting it would let an echo be absorbed by a message the reader
  // never sent, which is exactly the silently-swallowed-line failure this module
  // chooses a visible duplicate over.
  const items = [sidechain([user("count the files"), assistant("counting")])];
  const pending = [echo("count the files")];
  assert.equal(transcriptCount(items, "count the files"), 0);
  assert.equal(absorb(pending, items).length, 1, "nothing absorbed it, so it is still drawn");
});

test("two sends of the same text wait for two records", () => {
  const empty: ChatItem[] = [];
  const first = echo("status?", seenFor([], empty, "status?"));
  assert.equal(first.seen, 0);

  // The second send's baseline counts the echo already in flight, so it does not
  // share the first's record.
  const second = echo("status?", seenFor([first], empty, "status?"));
  assert.equal(second.seen, 1);

  const inFlight = [first, second];

  // One record lands: it absorbs the first echo only. Without the `seen`
  // baseline both would be dropped here and the second send would vanish.
  const one = [user("status?")];
  assert.deepEqual(
    absorb(inFlight, one).map((e) => e.id),
    [second.id],
  );
  assert.equal(
    countText(drawn(one, inFlight), "status?"),
    2,
    "the record, and the send still waiting for its own",
  );

  // The second record lands: nothing is left to draw, and the two sends are the
  // two records.
  const two = [user("status?"), user("status?")];
  assert.deepEqual(absorb(inFlight, two), []);
  assert.equal(countText(drawn(two, inFlight), "status?"), 2);
});

// ------------------------------------------- the record is not always verbatim

test("a record that differs only in whitespace is still that message", () => {
  // The differences a real remote introduces without meaning to: a line buffer
  // trims trailing spaces, a paste's CRLF can arrive as LF, and a message typed
  // across lines can be recorded with its newlines collapsed. Each of them used
  // to leave the echo on screen beside the record — a guaranteed duplicate for
  // the plainest of sends.
  assert.equal(
    transcriptCount([user("why is the rail empty?")], "why is the rail empty? "),
    1,
    "the line buffer ate the trailing space",
  );
  assert.deepEqual(absorb([echo("why is the rail empty? ")], [user("why is the rail empty?")]), []);

  assert.equal(transcriptCount([user("first\nsecond")], "first\r\nsecond"), 1, "CRLF arrived as LF");
  assert.equal(
    transcriptCount([user("first second")], "first\n\n  second"),
    1,
    "the newlines were collapsed",
  );

  const pending = [echo("first\r\nsecond")];
  assert.deepEqual(absorb(pending, [user("first\nsecond")]), []);
});

test("a slash command is absorbed by the record that kept only its verb", () => {
  // A TUI parses a slash command's argument for itself, so what reaches the
  // transcript is `/compact` where the reader typed `/compact focus on tests`.
  // Without this rule the completion path is a *guaranteed* duplicate.
  assert.equal(sameMessage("/compact focus on tests", "/compact"), true);
  assert.equal(sameMessage("/compact", "/compact focus on tests"), true);
  assert.equal(sameMessage("/clear", "/clear everything"), true);
  assert.equal(sameMessage("/compact focus on tests", "/clear"), false, "a different command");

  // Bounded: the rule needs a slash line on both sides, so it can never absorb a
  // sentence — which is what makes it safe to have at all.
  assert.equal(sameMessage("/compact focus on tests", "compact focus on tests"), false);
  assert.equal(sameMessage("run the tests", "/run the tests"), false);

  const pending = [echo("/compact focus on tests")];
  assert.deepEqual(absorb(pending, [user("/compact")]), [], "absorbed by the verb alone");
  assert.equal(absorb(pending, [user("/clear")]).length, 1, "a different command absorbs nothing");
});

test("an empty message matches nothing, and normalising is not case-folding", () => {
  assert.equal(matchKey("  \n\t "), "");
  assert.equal(sameMessage("", ""), false);
  assert.equal(sameMessage("   ", "\n"), false);
  // Two messages that differ in case or punctuation are two messages: folding
  // them would make an edit look like the same send, which is the silently
  // swallowed line this module keeps choosing against.
  assert.equal(sameMessage("Hello", "hello"), false);
  assert.equal(sameMessage("hi!", "hi"), false);
});

// -------------------------------------------------------------- what is drawn

test("the reader sees the message once, before and after the transcript agrees", () => {
  const before = [assistant("working on it")];
  const pending = [echo("what changed?")];

  const sent = drawn(before, pending);
  assert.equal(countText(sent, "what changed?"), 1, "the echo, immediately");
  assert.equal(sent.length, 2, "and nothing else was added");

  // The record lands. The echo goes; the transcript's own row takes its place.
  const after = [assistant("working on it"), user("what changed?")];
  const settled = drawn(after, pending);
  assert.equal(countText(settled, "what changed?"), 1, "still one row, now the real one");
  assert.equal(settled.length, 2, "the echo row is gone, not merely duplicated away");
  assert.ok(
    settled.every((item) => item.id !== pending[0].id),
    "the echo itself is not on screen",
  );
});

test("absorb keeps order, so a queue of identical sends drains oldest-first", () => {
  const a = echo("go", 0);
  const b = echo("go", 1);
  const c = echo("go", 2);
  const two = [user("go"), user("go")];
  assert.deepEqual(
    absorb([a, b, c], two).map((e) => e.id),
    [c.id],
  );
  assert.deepEqual(
    absorb([a, b, c], []).map((e) => e.id),
    [a.id, b.id, c.id],
  );
});

test("an echo is drawn as an ordinary user turn", () => {
  const item = echoItem({ id: "echo:7", text: "hello", seen: 0 });
  assert.equal(item.kind, "event");
  if (item.kind !== "event") return;
  assert.equal(item.id, "echo:7");
  assert.equal(item.event.kind, "message");
  assert.equal(item.event.role, "user");
  assert.equal(item.event.markdown, "hello");
  assert.equal(item.event.sidechain, false);
  // Not `new Date()`: nothing draws a time, and a clock reading nothing uses
  // would be a lie the moment something did.
  assert.equal(item.event.timestamp, null);
});

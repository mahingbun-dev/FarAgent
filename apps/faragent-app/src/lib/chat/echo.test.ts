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
 * - the **counts** are right (only top-level user turns, matched exactly), and
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

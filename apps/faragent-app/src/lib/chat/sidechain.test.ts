/**
 * The fold from a flat transcript to rows.
 *
 * Two properties carry the weight:
 *
 * - **Nothing is lost and nothing moves.** The rows are the events in file
 *   order, regrouped; a transcript with no sidechain events has to come back
 *   with every event present and in place.
 * - **A subagent's turn is never drawn as the main agent's.** That is the one
 *   thing the brief asks for by name ("do not mix into the main thread
 *   silently"), and the boolean is the only signal the model carries.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEvent, MessageEvent, ThinkingEvent, ToolEvent } from "./events.ts";
import { groupEvents } from "./sidechain.ts";

let counter = 0;

function message(sidechain = false): MessageEvent {
  counter += 1;
  return {
    kind: "message",
    id: `m${counter}`,
    role: "assistant",
    markdown: `text ${counter}`,
    sidechain,
    timestamp: null,
  };
}

function thinking(sidechain = false): ThinkingEvent {
  counter += 1;
  return { kind: "thinking", id: `t${counter}`, markdown: "…", sidechain, timestamp: null };
}

function tool(sidechain = false): ToolEvent {
  counter += 1;
  return {
    kind: "tool",
    id: `c${counter}`,
    name: "Read",
    input: { file_path: `/f${counter}.ts` },
    result: null,
    sidechain,
    timestamp: null,
  };
}

/** Every event a row list carries, flattened back out — for the round trip. */
function flatten(items: ReturnType<typeof groupEvents>): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const item of items) {
    if (item.kind === "tools") out.push(...item.events);
    else if (item.kind === "event") out.push(item.event);
    else out.push(...flatten(item.items));
  }
  return out;
}

test("an empty transcript folds to nothing", () => {
  assert.deepEqual(groupEvents([]), []);
});

test("consecutive tool calls become one row", () => {
  const events = [tool(), tool(), tool()];
  const items = groupEvents(events);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tools");
  if (items[0].kind !== "tools") return;
  assert.equal(items[0].events.length, 3);
  assert.equal(items[0].id, `tools:${events[0].id}`, "the row keeps the first call's id");
});

test("a message between two calls splits them into two rows", () => {
  const items = groupEvents([tool(), message(), tool()]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["tools", "event", "tools"],
  );
});

test("thinking is a row of its own", () => {
  const items = groupEvents([thinking(), message()]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["event", "event"],
  );
});

test("a run of sidechain events becomes one nested block", () => {
  const events = [message(), message(true), tool(true), thinking(true), message()];
  const items = groupEvents(events);

  assert.deepEqual(
    items.map((item) => item.kind),
    ["event", "sidechain", "event"],
  );
  const block = items[1];
  assert.equal(block.kind, "sidechain");
  if (block.kind !== "sidechain") return;
  assert.equal(block.id, `side:${events[1].id}`);
  assert.deepEqual(
    block.items.map((item) => item.kind),
    ["event", "tools", "event"],
    "the inner rows obey the same grouping",
  );
});

test("interleaved sidechain runs are two blocks, not one imagined agent", () => {
  // There is one boolean in the model and no subagent identity, so two runs
  // separated by main-thread events cannot be claimed to be the same agent.
  const items = groupEvents([message(true), message(), message(true)]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["sidechain", "event", "sidechain"],
  );
});

test("a sidechain block never nests inside another", () => {
  const items = groupEvents([message(true), tool(true), thinking(true)]);
  assert.equal(items.length, 1);
  const block = items[0];
  assert.equal(block.kind, "sidechain");
  if (block.kind !== "sidechain") return;
  assert.ok(block.items.every((item) => item.kind !== "sidechain"));
});

test("the fold loses nothing and moves nothing", () => {
  const before: ChatEvent[] = [
    message(),
    tool(),
    tool(),
    thinking(),
    message(true),
    tool(true),
    message(),
    message(),
  ];
  assert.deepEqual(flatten(groupEvents(before)), before);
});

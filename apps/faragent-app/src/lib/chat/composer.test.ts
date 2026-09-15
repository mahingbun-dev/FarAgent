/**
 * The composer's pure logic: what a key means, what bytes a message becomes, and
 * which commands a half-typed slash word could be.
 *
 * The three things pinned here are the three the component cannot get wrong on
 * its own, because each is invisible until it is wrong in front of a reader:
 *
 * - **Enter sends and Shift+Enter does not**, including the IME case — a
 *   composer that submits the Return that confirms a Chinese candidate sends a
 *   half-composed sentence.
 * - **A message becomes its text plus one CR.** Not two, and never a CR the text
 *   brought with it: a stray CR is an early Enter, which submits mid-message.
 * - **The slash menu is a completion aid, not a gate.** It answers for a prefix,
 *   goes quiet once there is an argument, and knows nothing that would stop a
 *   command it has never heard of from being sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "../agents.ts";
import {
  agentsWithCommands,
  commandsFor,
  composerAction,
  encodeSend,
  slashMatches,
  slashQuery,
} from "./composer.ts";

// ------------------------------------------------------------------ the keys

test("Enter sends, Shift+Enter is a newline, and an IME Return is neither", () => {
  const key = (key: string, shiftKey = false, isComposing = false) => ({
    key,
    shiftKey,
    isComposing,
  });

  assert.equal(composerAction(key("Enter")), "send");
  assert.equal(composerAction(key("Enter", true)), "newline");
  // The Return that confirms a candidate in an IME is not a message. Without
  // this the composer submits mid-word for anyone typing Chinese.
  assert.equal(composerAction(key("Enter", false, true)), "none");
  assert.equal(composerAction(key("Enter", true, true)), "none");

  // Everything else is the field's own business, and `none` is what tells the
  // caller to keep its hands off the event.
  for (const other of ["a", "Escape", "ArrowUp", "Tab", "Backspace"]) {
    assert.equal(composerAction(key(other)), "none", `${other} is not a send`);
  }
});

// ----------------------------------------------------------------- the bytes

test("a message becomes its text and exactly one CR", () => {
  assert.equal(encodeSend("hello"), "hello\r");
  assert.equal(encodeSend(""), "\r");

  // The internal newline survives as LF — Ctrl+J's byte, not Enter's — so a
  // message typed with Shift+Enter is one submission, not two.
  assert.equal(encodeSend("one\ntwo"), "one\ntwo\r");

  // A CR the text brought with it (a paste from Windows, or a textarea that
  // normalised a newline to CRLF) would otherwise arrive as an Enter and submit
  // the message mid-sentence. Both spellings collapse to LF; only the final CR
  // is a Return.
  assert.equal(encodeSend("one\r\ntwo"), "one\ntwo\r");
  assert.equal(encodeSend("one\rtwo"), "one\ntwo\r");
  assert.equal(encodeSend("one\r\n"), "one\n\r");

  // One CR in the whole payload, always, and it is the last byte.
  for (const text of ["a", "a\nb", "a\r\nb", "\r", ""]) {
    const sent = encodeSend(text);
    assert.equal(sent.split("\r").length - 1, 1, `${JSON.stringify(text)} → one CR`);
    assert.ok(sent.endsWith("\r"));
  }
});

// ----------------------------------------------------------------- the slash

test("slashQuery is null unless the field is a bare leading slash word", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/clear"), "clear");
  assert.equal(slashQuery("/CL"), "CL");

  // Not a command at all: no leading slash, an argument after the name, or a
  // second line. A menu under any of those would be offering completions for
  // something the reader is not typing.
  assert.equal(slashQuery("hello"), null);
  assert.equal(slashQuery(""), null);
  assert.equal(slashQuery("/compact now"), null);
  assert.equal(slashQuery("/clear\n"), null);
  assert.equal(slashQuery(" /clear"), null);
});

test("slashMatches completes a prefix, case-insensitively, off the table", () => {
  // The table is in the order the menu shows, and the answer follows it: the
  // first N matches, never a re-sort.
  const table = ["/clear", "/compact", "/config", "/cost", "/help"];

  assert.deepEqual(slashMatches("/cl", table), ["/clear"]);
  assert.deepEqual(slashMatches("/CL", table), ["/clear"]);
  assert.deepEqual(slashMatches("/co", table), ["/compact", "/config", "/cost"]);
  assert.deepEqual(slashMatches("/c", table, 2), ["/clear", "/compact"]);

  // A bare `/` offers the table — the moment a reader most needs to be told what
  // exists. Capped, because a menu longer than the field is not a menu.
  assert.deepEqual(slashMatches("/", table, 3), ["/clear", "/compact", "/config"]);

  assert.deepEqual(slashMatches("/zzz", table), []);
  assert.deepEqual(slashMatches("clear", table), []);
  assert.deepEqual(slashMatches("/compact now", table), []);
});

test("the Claude table is per-agent, and the other three have none", () => {
  const claude = commandsFor("claude");
  assert.ok(claude.length > 0);
  for (const command of claude) {
    assert.ok(command.startsWith("/"), `${command} is spelled as a command`);
  }
  assert.equal(new Set(claude).size, claude.length, "no duplicates in the menu");
  // Sorted, so the menu's order is the table's and not an accident of editing.
  assert.deepEqual([...claude], [...claude].sort());
  // The four the brief names, plus the ones every reader reaches for.
  for (const command of ["/clear", "/compact"]) {
    assert.ok(claude.includes(command), `${command} is offered`);
  }

  // An agent with no table offers nothing rather than Claude's commands: a Codex
  // tab suggesting `/compact` would be the app writing a cheque the remote
  // cannot cash.
  for (const agent of AGENTS) {
    if (agent !== "claude") assert.deepEqual(commandsFor(agent), []);
  }
  assert.deepEqual(agentsWithCommands(), ["claude"]);
});

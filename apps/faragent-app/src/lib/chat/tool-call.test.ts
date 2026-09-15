/**
 * The tool-call summariser.
 *
 * Driven through the **real English table** (`lib/i18n.ts`'s `translate`)
 * rather than a stub, so an assertion here is the sentence a reader sees. The
 * headline case is the one the brief writes out: a run of a subagent, two file
 * reads and two commands has to come out as
 * `Ran an agent, read 2 files, ran 2 commands`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { translate } from "../i18n.ts";
import type { Lang } from "../i18n.ts";
import type { ToolEvent, ToolResult } from "./events.ts";
import { summarizeToolRun, toolKind, toolLabel, toolRunLine } from "./tool-call.ts";

function messages(lang: Lang) {
  return (key: string, params?: Record<string, string | number>) =>
    translate(lang, key, params);
}

const en = messages("en");
const zh = messages("zh");

let counter = 0;

function call(name: string, input: unknown, result: ToolResult | null = null): ToolEvent {
  counter += 1;
  return {
    kind: "tool",
    id: `call_${counter}`,
    name,
    input,
    result,
    sidechain: false,
    timestamp: null,
  };
}

const read = (path: string) => call("Read", { file_path: path });
const bash = (command: string) => call("Bash", { command });

// --------------------------------------------------------------- the kinds

test("tool names map onto the kinds, and an unknown name is never invisible", () => {
  assert.equal(toolKind("Read"), "read");
  assert.equal(toolKind("read_file"), "read");
  assert.equal(toolKind("Edit"), "edit");
  assert.equal(toolKind("MultiEdit"), "edit");
  assert.equal(toolKind("Write"), "write");
  assert.equal(toolKind("Bash"), "bash");
  assert.equal(toolKind("Grep"), "search");
  assert.equal(toolKind("WebFetch"), "fetch");
  assert.equal(toolKind("WebSearch"), "webSearch");
  assert.equal(toolKind("Task"), "agent");
  assert.equal(toolKind("TodoWrite"), "todo");
  assert.equal(toolKind("SomethingNewer"), "other");
  assert.equal(toolKind(""), "other");
});

test("matching is exact, so an unrelated name is not filed under Read", () => {
  // A substring rule would put this in the Read bucket and print "Read a file"
  // for a call that did something else entirely.
  assert.equal(toolKind("unreadable"), "other");
  assert.equal(toolKind("Reader"), "other");
});

// ----------------------------------------------------------- single labels

test("one call reads as one line, with the field that identifies it", () => {
  assert.equal(toolLabel(read("/srv/app/src/state.ts"), en), "Read /srv/app/src/state.ts");
  assert.equal(toolLabel(bash("npm test"), en), "Ran npm test");
  assert.equal(toolLabel(bash("set -e\nnpm test"), en), "Ran set -e", "first line only");
  assert.equal(toolLabel(call("Write", { file_path: "a.md" }), en), "Wrote a.md");
  assert.equal(toolLabel(call("Edit", { file_path: "a.md" }), en), "Edited a.md");
  assert.equal(toolLabel(call("Grep", { pattern: "lease" }), en), "Searched for lease");
  assert.equal(toolLabel(call("WebFetch", { url: "https://x.dev" }), en), "Fetched https://x.dev");
  assert.equal(toolLabel(call("Task", {}), en), "Ran an agent");
  assert.equal(toolLabel(call("TodoWrite", {}), en), "Updated the todo list");
  assert.equal(toolLabel(call("NewFangled", {}), en), "NewFangled");
});

test("a label whose field is missing stays a sentence", () => {
  assert.equal(toolLabel(call("Read", {}), en), "Read a file");
  assert.equal(toolLabel(call("Bash", { command: "   " }), en), "Ran a command");
  assert.equal(toolLabel(call("Grep", null), en), "Searched for something");
  assert.equal(toolLabel(call("WebFetch", 7), en), "Fetched a page");
  assert.equal(toolLabel(call("Task", undefined), en), "Ran an agent");
});

// -------------------------------------------------------------- the summary

test("the brief's sentence", () => {
  assert.equal(
    summarizeToolRun(
      [call("Task", {}), read("/a.ts"), read("/b.ts"), bash("ls"), bash("pwd")],
      en,
    ),
    "Ran an agent, read 2 files, ran 2 commands",
  );
});

test("two commands are two commands", () => {
  assert.equal(summarizeToolRun([bash("ls"), bash("pwd")], en), "Ran 2 commands");
});

test("a count of one gets the singular spelling", () => {
  assert.equal(summarizeToolRun([bash("ls")], en), "Ran one command");
  assert.equal(summarizeToolRun([read("/a.ts")], en), "Read one file");
  assert.equal(summarizeToolRun([call("Task", {})], en), "Ran an agent");
});

test("reads are counted as files, not as calls", () => {
  assert.equal(
    summarizeToolRun([read("/a.ts"), read("/b.ts"), read("/a.ts")], en),
    "Read 2 files",
    "the same file twice is one file",
  );
});

test("a call whose path cannot be read is counted on its own", () => {
  assert.equal(summarizeToolRun([read("/a.ts"), call("Read", {})], en), "Read 2 files");
  assert.equal(summarizeToolRun([call("Read", {}), call("Read", {})], en), "Read 2 files");
});

test("a tool with nothing to count reads as a constant clause", () => {
  assert.equal(
    summarizeToolRun([call("TodoWrite", {}), call("TodoWrite", {})], en),
    "Updated the todo list",
    "one list, however many writes touched it",
  );
});

test("clauses keep the order the kinds were first seen", () => {
  assert.equal(
    summarizeToolRun([bash("ls"), read("/a.ts"), bash("pwd")], en),
    "Ran 2 commands, read one file",
    "bash came first, and its calls are counted across the whole run",
  );
});

test("an unknown tool still appears in the summary", () => {
  assert.equal(summarizeToolRun([call("NewFangled", {}), call("NewFangled", {})], en), "Ran 2 other tools");
  assert.equal(summarizeToolRun([call("NewFangled", {})], en), "Ran one other tool");
});

test("an empty run is an empty string, not a stray clause", () => {
  assert.equal(summarizeToolRun([], en), "");
});

test("the other table produces the other sentence", () => {
  assert.equal(
    summarizeToolRun([call("Task", {}), read("/a.ts"), read("/b.ts"), bash("ls"), bash("pwd")], zh),
    "运行了 1 个子代理，读取了 2 个文件，执行了 2 条命令",
  );
  assert.equal(summarizeToolRun([read("/a.ts")], zh), "读取了 1 个文件");
});

test("capitalising the first clause leaves Chinese alone", () => {
  // The assembler upper-cases the sentence's first character unconditionally;
  // on this table that is a no-op, which is why it is not conditioned on the
  // language.
  assert.ok(summarizeToolRun([bash("ls")], zh).startsWith("执行"));
});

// ------------------------------------------------------------ the row's line

test("a run of one shows the call, a run of several shows the summary", () => {
  assert.equal(toolRunLine([read("/a.ts")], en), "Read /a.ts");
  assert.equal(toolRunLine([read("/a.ts"), read("/b.ts")], en), "Read 2 files");
  assert.equal(toolRunLine([], en), "");
});

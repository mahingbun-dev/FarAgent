/**
 * `tool-input.ts` against the four shapes a tool call's input actually takes.
 *
 * The interesting assertions are the two that are not about a single function:
 *
 * - every synthesised patch is fed back through `parseUnifiedDiff`
 *   (`lib/panel/diff.ts`), because "the renderer draws a diff" is only true if
 *   the text this module invents is text that parser reads;
 * - a malformed input — a string, an array, `null`, `undefined` — answers
 *   `null` rather than throwing, because that is the promise the renderer makes
 *   for a file a remote program is still writing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedDiff } from "../panel/diff.ts";
import {
  asObject,
  commandOf,
  diffTextOf,
  filePathOf,
  firstLine,
  firstString,
  inputJson,
  searchQueryOf,
  webTargetOf,
} from "./tool-input.ts";

// ------------------------------------------------------------ reading fields

test("asObject accepts a plain object and refuses everything else", () => {
  assert.deepEqual(asObject({ a: 1 }), { a: 1 });
  assert.equal(asObject(null), null);
  assert.equal(asObject(undefined), null);
  assert.equal(asObject("x"), null);
  assert.equal(asObject(7), null);
  assert.equal(asObject([1, 2]), null, "an array is not an input object");
});

test("asObject reads a JSON string as the object it holds", () => {
  // Codex writes a tool call's `arguments` as a JSON **string** where Claude
  // writes an object, and `events.ts` promises each adapter hands the value over
  // as it found it — so the string arrives here, which is the "a string where an
  // object is expected" this module's own doc opens with. Before this, every
  // field reader below answered `null` for every Codex call: a tool row read
  // "ran a command" instead of the command, and an edit showed no diff.
  assert.deepEqual(asObject('{"command":"ls"}'), { command: "ls" });
  assert.deepEqual(asObject("{}"), {}, "an empty object is still an object");
  assert.equal(asObject("not json"), null, "an unparsable string is a miss, not a throw");
  assert.equal(asObject('["a"]'), null, "a JSON array is not an input object");
  assert.equal(asObject('"a string"'), null, "a JSON string is not an input object");
  assert.equal(asObject("null"), null);
  assert.equal(asObject("7"), null);
  assert.equal(asObject(""), null);
});

test("firstString takes the first non-empty string under any spelling", () => {
  assert.equal(firstString({ path: "a", file_path: "b" }, ["file_path", "path"]), "b");
  assert.equal(firstString({ path: "" }, ["path"]), null, "an empty string is a miss");
  assert.equal(firstString({ path: 7 }, ["path"]), null, "a number is a miss");
  assert.equal(firstString(null, ["path"]), null);
});

test("firstLine keeps the first line and drops a leading blank one", () => {
  assert.equal(firstLine("npm test\nrm -rf /"), "npm test");
  assert.equal(firstLine("\n\nnpm test"), "npm test");
  assert.equal(firstLine("   "), null);
  assert.equal(firstLine(""), null);
  assert.equal(firstLine(undefined), null);
  assert.equal(firstLine("  spaced  "), "spaced");
});

test("commandOf reads an argv array, which is how Codex records a command", () => {
  // Claude's `Bash` holds a string; Codex's `shell` holds an argv array. Joining
  // it with spaces is the command as it would have been typed, and reads nothing
  // into the flags — `bash -lc '<script>'` really is what the CLI ran, argv and
  // all. Without this a Codex tool row has no command to name, and falls back to
  // "ran a command", which is the one thing the row exists not to say.
  assert.equal(commandOf({ command: ["bash", "-lc", "ls -la"] }), "bash -lc ls -la");
  assert.equal(commandOf({ command: ["ls", "-la"] }), "ls -la");
  assert.equal(commandOf({ command: ["ls", "a\nb"] }), "ls a", "still one line");
  assert.equal(commandOf({ command: [] }), null, "an empty argv is not a command");
  assert.equal(commandOf({ command: ["ls", 7] }), null, "a non-string member is not one");
  assert.equal(commandOf({ command: [["ls"]] }), null, "nor is a nested array");
});

test("a path is read under the spelling each agent's CLI uses", () => {
  // Measured across 73 Grok sessions: `read_file` names its argument
  // `target_file` (2,354 calls) and `list_dir` names it `target_directory`
  // (140). Neither is a spelling Claude uses, and `read_file` is Grok's most
  // common tool by a factor of two — without these the row says "read a file"
  // and names none, for the call a Grok conversation is mostly made of.
  assert.equal(filePathOf({ target_file: "/srv/app/a.ts" }), "/srv/app/a.ts");
  assert.equal(filePathOf({ target_directory: "/srv/app" }), "/srv/app");
});

test("the named field readers fall back to null, not to a guess", () => {
  assert.equal(filePathOf({ file_path: "/a/b.ts" }), "/a/b.ts");
  assert.equal(filePathOf({ filePath: "/a/b.ts" }), "/a/b.ts");
  assert.equal(filePathOf({ notebook_path: "/a.ipynb" }), "/a.ipynb");
  assert.equal(filePathOf({ no_path: 1 }), null);

  assert.equal(commandOf({ command: "ls -la\npwd" }), "ls -la");
  assert.equal(commandOf({ cmd: "ls" }), "ls");
  assert.equal(commandOf({}), null);

  assert.equal(searchQueryOf({ pattern: "attachLease" }), "attachLease");
  assert.equal(searchQueryOf({ glob: "**/*.ts" }), "**/*.ts");
  assert.equal(searchQueryOf({}), null);

  assert.equal(webTargetOf({ url: "https://example.com/x" }), "https://example.com/x");
  assert.equal(webTargetOf({ query: "react virtual list" }), "react virtual list");
  assert.equal(webTargetOf({}), null);
});

test("inputJson renders an object, passes a string through, and skips emptiness", () => {
  assert.equal(inputJson({ command: "ls" }), '{\n  "command": "ls"\n}');
  assert.equal(inputJson("already a string"), "already a string");
  assert.equal(inputJson({}), null);
  assert.equal(inputJson(null), null);
  assert.equal(inputJson(undefined), null);
  assert.equal(inputJson(""), null);
});

// ------------------------------------------------------------ diff synthesis

test("an Edit input becomes a patch the panel's parser reads", () => {
  const got = diffTextOf({
    file_path: "/srv/app/src/lib/lease.ts",
    old_string: "const a = 1;",
    new_string: "const a = 2;\nconst b = 3;",
  });
  assert.ok(got, "an Edit input must produce a diff");
  assert.equal(got.path, "/srv/app/src/lib/lease.ts");

  const files = parseUnifiedDiff(got.text);
  assert.equal(files.length, 1);
  // An absolute path keeps its leading slash: `a/` + `/srv/…` is `a//srv/…`, and
  // the parser strips only the `a/`. That is the path the user recognises, and
  // it is what the row's header shows.
  assert.equal(files[0].path, "/srv/app/src/lib/lease.ts");
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 1);
  assert.equal(files[0].hunks.length, 1);

  const kinds = files[0].hunks[0].lines.map((line) => line.kind);
  assert.deepEqual(kinds, ["del", "add", "add"]);
  assert.deepEqual(
    files[0].hunks[0].lines.map((line) => line.text),
    ["const a = 1;", "const a = 2;", "const b = 3;"],
  );
});

test("a Write input becomes an all-added patch", () => {
  const got = diffTextOf({
    file_path: "notes.md",
    content: "## scratch\n\n- one\n",
  });
  assert.ok(got);
  const files = parseUnifiedDiff(got.text);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "notes.md");
  assert.equal(files[0].added, 3);
  assert.equal(files[0].removed, 0, "a write never shows a removed line");
});

test("a MultiEdit input folds every pair into one patch", () => {
  const got = diffTextOf({
    file_path: "a.ts",
    edits: [
      { old_string: "one", new_string: "ONE" },
      { old_string: "two", new_string: "TWO" },
    ],
  });
  assert.ok(got);
  const files = parseUnifiedDiff(got.text);
  assert.equal(files.length, 1);
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 2);
  assert.deepEqual(
    files[0].hunks[0].lines.map((line) => line.text),
    ["one", "two", "ONE", "TWO"],
  );
});

test("a patch an agent already sent is passed through untouched", () => {
  const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const got = diffTextOf({ file_path: "x.ts", patch });
  assert.ok(got);
  assert.equal(got.text, patch, "re-synthesising would throw the real line numbers away");
  assert.equal(parseUnifiedDiff(got.text)[0].added, 1);
});

test("a call that is not an edit has no diff", () => {
  assert.equal(diffTextOf({ command: "ls" }), null, "Bash is not an edit");
  assert.equal(diffTextOf({ file_path: "x.ts" }), null, "a path alone is not an edit");
  assert.equal(diffTextOf({ old_string: "a" }), null, "no path, nothing to diff");
  assert.equal(diffTextOf({ content: "hi" }), null, "content with no path is not a write");
});

test("a malformed input is a miss, never a throw", () => {
  for (const value of [null, undefined, "a string", 42, ["a"], true]) {
    assert.equal(diffTextOf(value), null, `diffTextOf(${JSON.stringify(value)})`);
  }
  assert.deepEqual(diffTextOf({ file_path: "x", edits: "not an array" }), null);
  assert.deepEqual(diffTextOf({ file_path: "x", edits: [null, 3] }), null);
});

test("a synthesised patch with no removed lines still parses", () => {
  // The hunk header reads `@@ -1,0 +1,1 @@` here, which is the shape a
  // count-zero field makes — worth pinning, because the panel's header regex
  // has to accept it.
  const got = diffTextOf({ file_path: "new.ts", content: "export {};\n" });
  assert.ok(got);
  assert.ok(got.text.includes("@@ -1,0 +1,1 @@"), got.text);
  assert.equal(parseUnifiedDiff(got.text)[0].added, 1);
});

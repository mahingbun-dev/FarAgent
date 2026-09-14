/**
 * `diff.ts` — unified-diff parsing and the 500-file rule.
 *
 * The patches below are the shapes `src/lib/mock/helper.ts::patchFor` emits,
 * copied by hand: a modified file, an added one (`--- /dev/null`), a deleted
 * one (`+++ /dev/null`), a pure rename (no hunks at all) and a binary change.
 * If the mock's spelling ever changes, these fixtures are where it shows up —
 * the panel renders whatever this parser returns, so a hunk that parses wrong
 * is a hunk the user sees wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIFF_FILE_CAP,
  diffTotals,
  parseUnifiedDiff,
  shouldListOnly,
} from "./diff.ts";

const MODIFIED = [
  "diff --git a/src/app.rs b/src/app.rs",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/src/app.rs",
  "+++ b/src/app.rs",
  "@@ -1,4 +1,5 @@",
  " // /srv/data",
  "-const before = true;",
  "+const before = false;",
  "+const extra = 1;",
  " export {};",
  "",
].join("\n");

test("a modified file yields one hunk with numbered lines", () => {
  const files = parseUnifiedDiff(MODIFIED);
  assert.equal(files.length, 1);
  const [file] = files;
  assert.equal(file.path, "src/app.rs");
  assert.equal(file.oldPath, "src/app.rs");
  assert.equal(file.mode, "modified");
  assert.equal(file.binary, false);
  assert.equal(file.hunks.length, 1);
  assert.equal(file.hunks[0].header, "@@ -1,4 +1,5 @@");
  assert.deepEqual(
    file.hunks[0].lines.map((l) => [l.kind, l.text, l.oldNo, l.newNo]),
    [
      ["context", "// /srv/data", 1, 1],
      ["del", "const before = true;", 2, null],
      ["add", "const before = false;", null, 2],
      ["add", "const extra = 1;", null, 3],
      ["context", "export {};", 3, 4],
    ],
  );
  assert.equal(file.added, 2);
  assert.equal(file.removed, 1);
  assert.deepEqual(diffTotals(files), { added: 2, removed: 1 });
});

test("an added and a deleted file are told apart by their /dev/null side", () => {
  const patch = [
    "diff --git a/assets/icon.svg b/assets/icon.svg",
    "index 1111111..2222222 100644",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/assets/icon.svg",
    "@@ -1,4 +1,5 @@",
    " // /srv/data",
    "-const before = true;",
    "+const before = false;",
    "+const extra = 1;",
    " export {};",
    "",
    "diff --git a/old/legacy.rs b/old/legacy.rs",
    "index 3333333..4444444 100644",
    "deleted file mode 100644",
    "--- a/old/legacy.rs",
    "+++ /dev/null",
    "@@ -1,4 +1,5 @@",
    " // /srv/data",
    "-const before = true;",
    "+const before = false;",
    "+const extra = 1;",
    " export {};",
    "",
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].mode, "new");
  assert.equal(files[0].path, "assets/icon.svg");
  assert.equal(files[0].oldPath, null, "a new file has no pre-image");
  assert.equal(files[1].mode, "deleted");
  assert.equal(files[1].path, "old/legacy.rs");
});

test("a rename carries both paths and may have no hunks", () => {
  const patch = [
    "diff --git a/src/renamed-from.rs b/src/moved.rs",
    "similarity index 97%",
    "rename from src/renamed-from.rs",
    "rename to src/moved.rs",
    "",
  ].join("\n");

  const [file] = parseUnifiedDiff(patch);
  assert.equal(file.mode, "rename");
  assert.equal(file.oldPath, "src/renamed-from.rs");
  assert.equal(file.path, "src/moved.rs");
  assert.equal(file.hunks.length, 0);
  assert.equal(file.added, 0);
  assert.equal(file.removed, 0);
});

test("a binary change parses as binary with no body", () => {
  const patch = [
    "diff --git a/assets/logo.png b/assets/logo.png",
    "index 5555555..6666666 100644",
    "Binary files a/assets/logo.png and b/assets/logo.png differ",
    "",
  ].join("\n");

  const [file] = parseUnifiedDiff(patch);
  assert.equal(file.binary, true);
  assert.equal(file.hunks.length, 0);
});

test("a patch with several files keeps them separate and in order", () => {
  const patch = `${MODIFIED}\n${MODIFIED.replaceAll("src/app.rs", "src/lib.rs")}`;
  const files = parseUnifiedDiff(patch);
  assert.deepEqual(
    files.map((f) => f.path),
    ["src/app.rs", "src/lib.rs"],
  );
  // A hunk counter must restart per file, not leak across the header.
  assert.equal(files[1].hunks[0].lines[0].oldNo, 1);
});

test("a stray or unknown header line does not throw or invent a hunk", () => {
  const patch = [
    "diff --git a/x.txt b/x.txt",
    "index 1111111..2222222 100644",
    "old mode 100644",
    "new mode 100755",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -3,2 +3,2 @@",
    " keep",
    "-gone",
    "+arrived",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  const [file] = parseUnifiedDiff(patch);
  assert.equal(file.mode, "modified");
  assert.deepEqual(
    file.hunks[0].lines.map((l) => l.kind),
    ["context", "del", "add", "meta"],
    "the no-newline marker is carried as meta, not swallowed",
  );
  // The counters start where the hunk header says, not at 1.
  assert.equal(file.hunks[0].lines[0].oldNo, 3);
  assert.equal(file.hunks[0].lines[0].newNo, 3);
  assert.equal(file.added, 1);
  assert.equal(file.removed, 1);
});

test("an empty patch is an empty file list, not a phantom file", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("\n"), []);
});

// The cap the whole task turns on.

test("the diff cap is 500 files, and over it only the list may render", () => {
  assert.equal(DIFF_FILE_CAP, 500);
  assert.equal(
    shouldListOnly({ filesOnly: false, truncated: false, fileCount: DIFF_FILE_CAP }),
    false,
    "exactly 500 still gets a patch",
  );
  assert.equal(
    shouldListOnly({ filesOnly: false, truncated: false, fileCount: DIFF_FILE_CAP + 1 }),
    true,
  );
  // The mock's big repository: 620 changed files, so the list itself is cut.
  assert.equal(
    shouldListOnly({ filesOnly: false, truncated: true, fileCount: DIFF_FILE_CAP }),
    true,
  );
  // The remote saying its patch budget was blown is enough on its own.
  assert.equal(
    shouldListOnly({ filesOnly: true, truncated: false, fileCount: 3 }),
    true,
  );
  assert.equal(shouldListOnly({ filesOnly: false, truncated: false, fileCount: 0 }), false);
});

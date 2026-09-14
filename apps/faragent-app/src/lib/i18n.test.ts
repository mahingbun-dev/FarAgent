/**
 * The i18n tables are plain objects, so `node --test` can check them without a
 * DOM. What it checks is the two ways a UI string goes wrong quietly: a key
 * added to one language and not the other (the UI then prints the raw key —
 * `file.tooLarge` — which looks like a code smell rather than a missing
 * translation), and a value that is empty or still placeholder text.
 *
 * The panel work added ~70 keys at once, which is exactly the situation this
 * catches.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EN, translate, ZH } from "./i18n.ts";

test("both languages carry the same keys", () => {
  const zh = Object.keys(ZH).sort();
  const en = Object.keys(EN).sort();
  const onlyZh = zh.filter((k) => !(k in EN));
  const onlyEn = en.filter((k) => !(k in ZH));
  assert.deepEqual(onlyZh, [], "keys missing from EN");
  assert.deepEqual(onlyEn, [], "keys missing from ZH");
  assert.equal(zh.length, en.length);
});

test("no value is empty, whitespace, or a bare key", () => {
  for (const [name, table] of [
    ["ZH", ZH],
    ["EN", EN],
  ] as const) {
    for (const [k, v] of Object.entries(table)) {
      assert.ok(v.trim() !== "", `${name}: ${k} is empty`);
      assert.notEqual(v, k, `${name}: ${k} is its own value`);
    }
  }
});

test("the panel and git keys this task added are present in both", () => {
  // Two entries used to be in this list and are gone: `panel.root` (the panel's
  // root bar shows the path itself) and `changes.untracked` (untracked files
  // are listed under `changes.unstaged`, which is the only grouping the changes
  // panel has). `i18n-coverage.test.ts` is what catches that class of leftover
  // now, rather than a hand-written list that listed a key nothing used.
  const added = [
    "panel.files",
    "panel.changes",
    "panel.git",
    "panel.collapse",
    "tree.empty",
    "tree.showMore",
    "tree.truncated",
    "file.empty",
    "file.tooLarge",
    "file.binary",
    "file.truncated",
    "file.windowed",
    "file.readOnly",
    "changes.staged",
    "changes.unstaged",
    "changes.listOnly",
    "changes.diffTruncated",
    "changes.noDiff",
    "changes.binaryDiff",
    "git.notRepo",
    "git.ahead",
    "git.behind",
    "git.detached",
    "git.initial",
    "git.logMore",
    "git.current",
  ];
  for (const key of added) {
    assert.ok(key in ZH, `${key} missing from ZH`);
    assert.ok(key in EN, `${key} missing from EN`);
  }
});

test("translate substitutes params and falls back to the key", () => {
  assert.equal(translate("zh", "panel.files"), "文件");
  assert.equal(translate("en", "file.tooLargeHint", { size: "2 MB", limit: "1 MB" }), "2 MB, limit 1 MB");
  // An unregistered key is visible rather than empty, which is what makes a
  // missing translation reportable instead of silent.
  assert.equal(translate("en", "nope.missing"), "nope.missing");
});

test("the ahead/behind copy reads correctly at one, which is why it is phrased this way", () => {
  // "1 commits ahead" is what a `{count} commits` template would print, so the
  // English avoids a plural noun entirely. Pinned here because the screenshot
  // that shows the Git tab's English labels has to match shipped copy.
  assert.equal(translate("en", "git.ahead", { count: 1 }), "1 ahead of upstream");
  assert.equal(translate("en", "git.behind", { count: 3 }), "3 behind upstream");
  assert.equal(translate("en", "git.upstream", { name: "origin/main" }), "upstream origin/main");
  assert.equal(translate("zh", "git.ahead", { count: 1 }), "领先 1 个提交");
});

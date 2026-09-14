/**
 * The i18n tables against the source, both ways round.
 *
 * `i18n.test.ts` checks the tables against themselves — same keys in both
 * languages, no empty values. It cannot see the source, which is where the two
 * failures that actually reach a user live:
 *
 * - **A key a component asks for that the table does not have.** The UI then
 *   prints `file.tooLarge` where a sentence belongs.
 * - **A key in the table that nothing asks for.** A leftover from a rewritten
 *   component: a translation nobody can see, silently drifting out of date.
 *   Task 9's review found five of these by hand; Task 12 found a sixth
 *   (`changes.untracked`) that the hand check missed, which is the argument for
 *   doing it by scanner.
 *
 * The scanner reads every `.ts`/`.tsx` under `src/` except the tables
 * themselves and the tests. "Referenced" means the key appears as a string
 * literal in a file — that is what lets `theme-picker.tsx` hold
 * `labelKey: "settings.theme.dark"` in a table and pass it to `t()` at render
 * time, which no call-site regex would catch. Keys reached through a template
 * literal (`t(\`status.${status}\`)`) are matched by prefix, and the prefixes
 * are discovered from the source rather than hard-coded, so adding a second one
 * does not mean editing this file.
 *
 * Two guard tests keep the scanner honest: a scanner that silently matches
 * nothing passes both the checks above.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EN, ZH } from "./i18n.ts";

/** `src/` — this file lives in `src/lib/`. */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Files that define or assert the tables, rather than use them. */
function isExcluded(name: string): boolean {
  return name === "i18n.ts" || name.endsWith(".test.ts") || name.endsWith(".test.tsx");
}

function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (isExcluded(entry.name)) continue;
    out.push(path);
  }
  return out;
}

/**
 * A file's text with comments removed.
 *
 * The `://` case is why the line-comment rule excludes a `//` preceded by a
 * colon: `"https://api.example.com"` is a string, not a comment, and treating
 * it as one would swallow the rest of the line — including, potentially, the
 * key this scanner exists to find.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

interface Scan {
  files: string[];
  /** Every table key that appears as a literal somewhere in the source. */
  referenced: Set<string>;
  /** Every key passed to `t("…")` or `translate(x, "…")` literally. */
  called: Set<string>;
  /** Prefixes of template-literal keys, e.g. `status.` from ``t(`status.${s}`)``. */
  dynamicPrefixes: Set<string>;
}

function scan(keys: Set<string>): Scan {
  const files = sourceFiles();
  const referenced = new Set<string>();
  const called = new Set<string>();
  const dynamicPrefixes = new Set<string>();

  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));

    for (const match of text.matchAll(/"([^"\n]*)"/g)) {
      if (keys.has(match[1])) referenced.add(match[1]);
    }
    for (const match of text.matchAll(/\bt\(\s*"([^"\n]+)"/g)) {
      called.add(match[1]);
    }
    for (const match of text.matchAll(/\btranslate\(\s*[^,()]+,\s*"([^"\n]+)"/g)) {
      called.add(match[1]);
    }
    for (const match of text.matchAll(/`([a-z][A-Za-z0-9]*\.)\$\{/g)) {
      dynamicPrefixes.add(match[1]);
    }
  }

  for (const prefix of dynamicPrefixes) {
    for (const key of keys) {
      if (key.startsWith(prefix)) referenced.add(key);
    }
  }
  return { files, referenced, called, dynamicPrefixes };
}

const KEYS = new Set([...Object.keys(ZH), ...Object.keys(EN)]);
const SCAN = scan(KEYS);

/** A key is dead when nothing in the source mentions it. */
function deadKeys(): string[] {
  return [...KEYS].filter((key) => !SCAN.referenced.has(key)).sort();
}

/** A key is missing when a call site asks for it and the table has no entry. */
function missingKeys(): string[] {
  return [...SCAN.called].filter((key) => !(key in ZH) || !(key in EN)).sort();
}

test("the scanner is looking at the source, not at nothing", () => {
  // Without this, a broken walk (the wrong `src/`, a renamed extension) makes
  // both checks below pass by having nothing to check.
  assert.ok(SCAN.files.length > 20, `scanned only ${SCAN.files.length} files`);
  assert.ok(
    SCAN.files.some((file) => file.endsWith(join("components", "panel", "file-tree.tsx"))),
    "the walk did not reach the panel components",
  );
  assert.ok(SCAN.referenced.size > 100, `only ${SCAN.referenced.size} keys referenced`);
  assert.ok(SCAN.called.size > 100, `only ${SCAN.called.size} literal call sites`);
  assert.ok(
    SCAN.dynamicPrefixes.has("status."),
    "the `status.${…}` template key in diff-view.tsx was not found",
  );
});

test("every key a component asks for is in both tables", () => {
  assert.deepEqual(missingKeys(), []);
});

test("every key in the tables is asked for by something", () => {
  assert.deepEqual(deadKeys(), []);
});

test("the keys Task 12 removed are still gone", () => {
  // Named individually so that re-adding one to the table fails here with the
  // reason, rather than as a one-line diff in an empty-array assertion above.
  const removed = [
    "panel.root",
    "panel.scriptMode",
    "panel.scriptModeHint",
    "file.lines",
    "changes.empty",
    "changes.untracked",
  ];
  for (const key of removed) {
    assert.ok(!(key in ZH), `${key} is back in ZH`);
    assert.ok(!(key in EN), `${key} is back in EN`);
  }
});

test("the scanner's view of a file is the file's own text", () => {
  // The comment stripper is the one piece of cleverness here, and it is the
  // piece that could hide a key. Pinned directly.
  const stripped = stripComments('const u = "https://example.com/a"; // file.lines\nt("panel.files");');
  assert.ok(stripped.includes("https://example.com/a"), "a URL was mistaken for a comment");
  assert.ok(!stripped.includes("file.lines"), "a line comment survived");
  assert.ok(stripped.includes('t("panel.files")'));
  assert.ok(!stripComments('/* changes.empty */ t("x")').includes("changes.empty"));
});

test("every removed key has a live replacement, named", () => {
  // The reason each one could go, recorded where the scanner can see it, and
  // checked: a removal is only safe while whatever superseded it is still
  // referenced. If one of these ever goes dead in turn, this test says which
  // string was supposed to be carrying its job.
  const replacements: Record<string, string> = {
    "panel.root": "panel.rootSwitch",
    "file.lines": "file.truncated",
    "changes.empty": "changes.clean",
    "changes.untracked": "changes.unstaged",
  };
  for (const [gone, replacement] of Object.entries(replacements)) {
    assert.ok(!SCAN.referenced.has(gone), `${gone} is referenced again`);
    assert.ok(
      SCAN.referenced.has(replacement) || SCAN.called.has(replacement),
      `${gone} was removed in favour of ${replacement}, which is now unused too`,
    );
  }

  // `panel.scriptMode` and `panel.scriptModeHint` are the pair with no key
  // behind them, and the reason is worth keeping next to the check: a fallback
  // notice already exists, and it is the protocol's own (`mode.reason.message` —
  // bilingual, reason-specific, rendered by `helperFallbackNotice`). A generic
  // "script mode" label on top of it would be a second source of truth for the
  // same fact, and the less informative of the two.
  const helperSource = readFileSync(join(SRC, "lib", "helper.ts"), "utf8");
  assert.ok(
    helperSource.includes("export function helperFallbackNotice("),
    "the function that replaced the scriptMode keys is gone",
  );
  const panelSource = readFileSync(
    join(SRC, "components", "panel", "helper-context.tsx"),
    "utf8",
  );
  assert.ok(
    panelSource.includes("helperFallbackNotice("),
    "the fallback notice is no longer rendered anywhere",
  );
});

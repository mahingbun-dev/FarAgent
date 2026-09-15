/**
 * Reading a tool call's `input`.
 *
 * `ToolEvent.input` is typed `unknown` **on purpose** (`lib/chat/events.ts`):
 * the value comes out of a file another program writes on a remote machine, so
 * it can be a string where an object is expected, an object with the key
 * missing, or a key spelled differently by a different agent's CLI. The model
 * refuses to guess, and this module is where the renderer does its guessing —
 * in one place, with a fallback at every step instead of a cast.
 *
 * Everything here is total: given any `unknown`, each function either answers
 * or answers `null`. None of them throws, which is what lets the renderer draw
 * a half-recognised tool call instead of white-screening on it.
 *
 * Pure: no DOM, no React, no i18n. The Chinese/English wording lives in the
 * callers (`tool-call.ts`) so the labels are translated and this file stays a
 * data reader.
 */

/** Any JSON object, as the renderer's various probes want to see it. */
export type InputObject = Record<string, unknown>;

/** True for a plain JSON object — the only shape a tool input may have. */
export function asObject(value: unknown): InputObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as InputObject)
    : null;
}

/** The first of `keys` whose value is a non-empty string, or `null`. */
export function firstString(input: unknown, keys: readonly string[]): string | null {
  const obj = asObject(input);
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * The first line of a possibly multi-line value, trimmed.
 *
 * A one-line tool row cannot show a heredoc, and taking the first line is how
 * the reader still sees *which* command ran. `null` for anything that is not a
 * non-empty string, and for a value whose first line is blank — a command
 * starting with a newline has nothing on its first line to show.
 */
export function firstLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const cut = trimmed.indexOf("\n");
  return cut === -1 ? trimmed : trimmed.slice(0, cut).trimEnd();
}

/**
 * Split a value into lines for display, dropping one trailing newline.
 *
 * One trailing newline is dropped because `"a\n"` and `"a"` are the same edit
 * written two ways, and keeping it would add a phantom empty line to every
 * synthesised diff. Interior blank lines are kept: in a code block they are
 * content.
 */
function toLines(value: string): string[] {
  const body = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (body === "") return [];
  return body.split("\n");
}

// ---------------------------------------------------------------- the fields

/** The path a tool call names, under any of the spellings agents use. */
export function filePathOf(input: unknown): string | null {
  return firstString(input, ["file_path", "filePath", "path", "notebook_path"]);
}

/** The shell command a tool call runs, first line only. */
export function commandOf(input: unknown): string | null {
  return firstLine(firstString(input, ["command", "cmd"]));
}

/** The pattern or query a search tool was given. */
export function searchQueryOf(input: unknown): string | null {
  return firstLine(
    firstString(input, ["pattern", "query", "regex", "glob", "search"]),
  );
}

/** The URL or query a web tool was given. */
export function webTargetOf(input: unknown): string | null {
  return firstLine(firstString(input, ["url", "query", "prompt"]));
}

// ------------------------------------------------------------------- diffs

/** One before/after pair an agent's edit tool describes. */
interface EditPair {
  old: string;
  new: string;
}

/** The first of `keys` that holds an `{old, new}` pair of strings. */
function pairFrom(obj: InputObject): EditPair | null {
  const oldText = firstStringOrEmpty(obj, ["old_string", "old_str", "oldText", "old"]);
  const newText = firstStringOrEmpty(obj, [
    "new_string",
    "new_str",
    "newText",
    "new",
    "content",
  ]);
  if (oldText === null && newText === null) return null;
  return { old: oldText ?? "", new: newText ?? "" };
}

/** Like `firstString`, but an empty string is a real answer (`old_string: ""`). */
function firstStringOrEmpty(obj: InputObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Every edit a tool call describes, in order.
 *
 * Three shapes are recognised, and all three are measured shapes rather than
 * guesses: one `old_string`/`new_string` pair (Claude's `Edit`), an `edits`
 * array of such pairs (`MultiEdit`), and a bare `content` (a write, which is an
 * edit against nothing). A call with none of them is not an edit and answers
 * `[]`, which is how a diff-free call ends up rendering as an input/result
 * block instead of an empty patch.
 */
function editsOf(input: InputObject): EditPair[] {
  const single = pairFrom(input);
  if (single) return [single];

  const list = input.edits;
  if (Array.isArray(list)) {
    const pairs: EditPair[] = [];
    for (const entry of list) {
      const obj = asObject(entry);
      if (!obj) continue;
      const pair = pairFrom(obj);
      if (pair) pairs.push(pair);
    }
    if (pairs.length > 0) return pairs;
  }

  const content = input.content;
  if (typeof content === "string") return [{ old: "", new: content }];

  return [];
}

/**
 * One synthesised hunk body, as git would spell it.
 *
 * **`@@ -1,n +1,m @@` is a display convention, not the file's real line
 * numbers.** A tool call's input carries the strings it replaced, not where
 * they were; inventing a plausible offset would be a lie a reader might act
 * on, and the panel's diff parser reads the numbers straight out of this
 * header. Counting from 1 keeps the two gutters self-consistent (a removed line
 * and the line opposite it line up) and nothing more is claimed.
 */
function hunkHeader(oldLines: number, newLines: number): string {
  return `@@ -1,${oldLines} +1,${newLines} @@`;
}

/**
 * A unified diff for one tool call, or `null` when the call is not an edit.
 *
 * Returns the **text** of a patch plus the path it edits. The text is shaped to
 * what `lib/panel/diff.ts` parses, so an edit in the conversation renders
 * through the same parser, the same highlighter and the same row component the
 * panel's Changes tab uses — one diff renderer in the app, not two.
 *
 * A patch an agent already sent (`patch` / `diff` / `unified_diff`) is passed
 * through verbatim: it was written by a tool that knows the real line numbers,
 * and re-synthesising it would throw that away.
 */
export function diffTextOf(
  input: unknown,
): { path: string; text: string } | null {
  const obj = asObject(input);
  if (!obj) return null;

  const given = firstStringOrEmpty(obj, ["patch", "diff", "unified_diff"]);
  if (given !== null && given !== "") {
    return { path: filePathOf(obj) ?? "", text: given };
  }

  const path = filePathOf(obj);
  if (path === null) return null;

  const edits = editsOf(obj);
  if (edits.length === 0) return null;

  const removed: string[] = [];
  const added: string[] = [];
  for (const edit of edits) {
    removed.push(...toLines(edit.old));
    added.push(...toLines(edit.new));
  }

  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    hunkHeader(removed.length, added.length),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  return { path, text: lines.join("\n") + "\n" };
}

/**
 * A tool call's input as indented JSON, for the expanded row.
 *
 * `null` when there is nothing to show — `undefined` would read as an empty
 * result in the renderer, and "this call takes no input" and "the input was
 * empty" are different sentences.
 */
export function inputJson(input: unknown): string | null {
  const obj = asObject(input);
  if (!obj) {
    return typeof input === "string" && input !== "" ? input : null;
  }
  if (Object.keys(obj).length === 0) return null;
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    // A cyclic or otherwise unserialisable value cannot come out of
    // `JSON.parse`, but the type is `unknown` and the renderer must not be the
    // place this is discovered.
    return null;
  }
}

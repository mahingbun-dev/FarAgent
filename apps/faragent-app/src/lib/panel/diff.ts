/**
 * Unified-diff parsing, for a read-only diff view.
 *
 * The helper hands back a patch exactly as `git diff` wrote it, and the panel
 * has to turn it into rows: file headers, hunks and numbered lines. Nothing
 * here re-derives anything git already said — the file list comes from the
 * reply's own `files` array (that is what survives the remote's 6 MiB patch
 * budget), and this module only reads the patch body when the reply *has* one.
 *
 * The two rules a reader of this file should know:
 *
 * 1. **A patch is not a file list.** `git.diff` answers with `filesOnly` (or
 *    `truncated`) when the change set is too big; the panel then shows the
 *    list and fetches one file's patch at a time. `shouldListOnly` is that
 *    rule, in one place, so the threshold is testable.
 * 2. **Line numbers are carried, not counted.** A hunk header's `-a,b +c,d`
 *    seeds the counters, and `+`/`-`/` ` advance the right one, which is what
 *    makes a deletion and the line opposite it line up in the gutter.
 *
 * Pure: no DOM, no imports.
 */

/** `git.status`/`git.diff` file list entries, read-only. */
export type DiffFileStatus =
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "modified"
  | "untracked"
  | "conflicted";

/** Over this many changed files, the panel shows the list and no patch. */
export const DIFF_FILE_CAP = 500;

/** What a `git.diff` reply says about itself, for the cap decision. */
export interface DiffReplyShape {
  filesOnly: boolean;
  truncated: boolean;
  fileCount: number;
}

/**
 * True when only the file list may be rendered.
 *
 * All three signals count. `filesOnly` is the remote saying its patch budget
 * was blown; `truncated` is it saying the *list* was cut off at 500 entries,
 * which means the patch it did send describes an incomplete change set; and
 * `fileCount` catches a reply that reported neither but is over the cap all the
 * same (a hand-built reply, a future remote that drops the flags).
 */
export function shouldListOnly(reply: DiffReplyShape): boolean {
  return reply.filesOnly || reply.truncated || reply.fileCount > DIFF_FILE_CAP;
}

export type DiffLineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line's text, without git's leading `+`/`-`/` `. */
  text: string;
  /** Line number in the old file, for a `-` or ` ` line. */
  oldNo: number | null;
  /** Line number in the new file, for a `+` or ` ` line. */
  newNo: number | null;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` line, verbatim. */
  header: string;
  lines: DiffLine[];
}

export type DiffFileMode = "new" | "deleted" | "rename" | "copy" | "modified";

export interface DiffFile {
  /** Post-image path; for a deletion, the path that was removed. */
  path: string;
  /** Pre-image path, when it differs (a rename or a copy). */
  oldPath: string | null;
  /** `Binary files … differ`: there is no body to show. */
  binary: boolean;
  mode: DiffFileMode;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

interface MutableFile extends DiffFile {
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `a/src/x.rs` / `b/src/x.rs` → `src/x.rs`; `/dev/null` and others unchanged. */
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

function newFile(path: string, oldPath: string | null): MutableFile {
  return {
    path,
    oldPath,
    binary: false,
    mode: "modified",
    hunks: [],
    added: 0,
    removed: 0,
  };
}

/**
 * Parse a patch into files and hunks.
 *
 * Tolerant by construction: an unknown header line is skipped rather than
 * throwing, because the panel's worst outcome is a missing hunk, not a blank
 * panel. A patch that carries no `diff --git` line at all (a `git diff --no-index`
 * style body) still yields a file, keyed off its `+++` line.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  const files: DiffFile[] = [];
  let current: MutableFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      current = newFile(match?.[2] ?? "", match?.[1] ?? null);
      files.push(current);
      hunk = null;
      continue;
    }

    if (current === null) {
      if (line.startsWith("+++ ")) {
        const path = stripPrefix(line.slice(4));
        current = newFile(path, null);
        files.push(current);
      } else if (line.startsWith("--- ")) {
        current = newFile("", stripPrefix(line.slice(4)));
        files.push(current);
      } else {
        continue;
      }
    }

    if (line.startsWith("Binary files ")) {
      current.binary = true;
      hunk = null;
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.mode = "new";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.mode = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.mode = "rename";
      current.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.mode = "rename";
      current.path = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("copy from ")) {
      current.mode = "copy";
      current.oldPath = line.slice("copy from ".length);
      continue;
    }
    if (line.startsWith("copy to ")) {
      current.mode = "copy";
      current.path = line.slice("copy to ".length);
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = stripPrefix(line.slice(4));
      current.oldPath = path === "/dev/null" ? null : path;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = stripPrefix(line.slice(4));
      if (path !== "/dev/null") current.path = path;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = HUNK_HEADER.exec(line);
      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[3]) : 0;
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("similarity index") ||
      line.startsWith("dissimilarity index") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }

    if (hunk === null) continue;

    if (line.startsWith("\\ No newline")) {
      hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    const marker = line.charAt(0);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      newNo += 1;
      current.added += 1;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
      current.removed += 1;
    } else if (marker === " " || line === "") {
      hunk.lines.push({
        kind: "context",
        text: line === "" ? "" : line.slice(1),
        oldNo,
        newNo,
      });
      oldNo += 1;
      newNo += 1;
    }
    // Anything else (a stray line) is dropped rather than invented.
  }

  return files;
}

/** Added and removed counts over a patch. */
export function diffTotals(files: DiffFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}

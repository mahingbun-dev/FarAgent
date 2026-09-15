/**
 * Where a Claude session's transcript file lives on the remote.
 *
 * A session started from the app used to be unrenderable: we launched a bare
 * `claude`, the CLI chose its own session uuid, nothing told us, and the
 * transcript path could not be computed — so the conversation view had no file
 * to read. The launcher now pins a new session with `--session-id` and hands the
 * id back (`ensure_session` answers `{ name, session_id }`), which makes a *new*
 * session's file a pure function of that id and the tab's cwd. That function is
 * this module. A **resumed** session already knows its path from the rail and
 * must not go through here.
 *
 * ## The rule, and where it comes from
 *
 * `~/.claude/projects/<slug>/<session-id>.jsonl`, where **`<slug>` is the cwd
 * with every `/` and `.` replaced by `-`**. Measured against a real remote's
 * `~/.claude/projects/` listing: the cwd
 * `/Users/sunny/code/litellm/.claude/worktrees/x` produced
 * `-Users-sunny-code-litellm--claude-worktrees-x` — the doubled dash is the
 * `.claude` segment's leading dot, and it is the case that tells this rule from
 * a `/`-only one. The remote's own inverse (`claude_guess_cwd`, `remote.rs`)
 * replaces each `-` back to `/` and leaves every other character literal, which
 * is only sound if the forward rule maps *no* other character — so a `_` in a
 * cwd survives into the slug unchanged.
 *
 * ## POSIX only
 *
 * `src-tauri/src/helper.rs` refuses a Windows remote outright — the framed
 * channel is POSIX-only — so the chat view can never work there and there is no
 * measured Windows rule to reach for. This returns `null` for Windows rather
 * than inventing one.
 *
 * Pure: no DOM and no imports beyond the panel's own path arithmetic, so
 * `node --test` runs it directly. It is the sibling of `lib/panel/paths.ts`,
 * which does the same job for the panel's tree and git roots.
 */
import { joinPath, normalizePath } from "../panel/paths.ts";

/**
 * The `~/.claude/projects` directory name for a cwd: every `/` and `.` becomes
 * `-` and nothing else changes.
 *
 * The cwd is normalised first — a trailing slash, a `./` segment or a `..` is
 * resolved away — so two spellings of one directory cannot produce two slugs.
 * `normalizePath` leaves a `.claude` segment whole (it drops only a segment that
 * is exactly `.`), which is why the doubled dash above survives it.
 */
export function projectSlug(cwd: string): string {
  return normalizePath(cwd).replace(/[/.]/g, "-");
}

/**
 * The transcript file a Claude session pinned to `sessionId` reads and writes on
 * a host, or `null` when no path can be computed.
 *
 * `null` on a Windows remote (the chat view cannot work there — see the module
 * doc), and for the degenerate inputs that would otherwise build a confident but
 * wrong path: an empty id, an empty cwd, or an empty home. Every consumer treats
 * `null` as "there is no file to read", which is the honest answer for all four.
 */
export function claudeTranscriptPath(
  sessionId: string,
  cwd: string,
  home: string,
  os: "posix" | "windows",
): string | null {
  if (os === "windows") return null;
  const id = sessionId.trim();
  if (id === "" || cwd.trim() === "" || home.trim() === "") return null;
  return joinPath(home, `.claude/projects/${projectSlug(cwd)}/${id}.jsonl`);
}

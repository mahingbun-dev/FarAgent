/**
 * Where a *new* session's transcript file lives on the remote — one rule per agent.
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
 * Whether a rule exists at all is not a per-agent preference: it is decided by
 * whether that agent's CLI accepts `--session-id`. Only then does the app know
 * the id the CLI will use, and only then can it name the file. `AgentKind::
 * may_accept_session_id` in `crates/faragent-core/src/agents.rs` is that
 * distinction's single source, and its tests pin all four answers.
 *
 * ## Claude — the cwd slug
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
 * ## Grok — the cwd as one directory name
 *
 * `~/.grok/sessions/<encoded cwd>/<session-id>/chat_history.jsonl`, where the
 * cwd is **percent-encoded whole**, slashes and all, so the entire path is a
 * single directory name. Measured: this machine's `~/.grok/sessions/` holds a
 * directory literally named `%2FUsers%2Fmaqb11%2Fcode%2Fma-code%2FFarAgent`, and
 * the per-session directories live inside it. That measured name agrees with
 * `encodeURIComponent` on every character it contains, so the standard is used
 * rather than a hand-rolled `/\//g` substitution — the difference only shows up
 * on a cwd holding a space or a non-ASCII segment, where the standard is the
 * one the remote was built against.
 *
 * ## Codex and Pi — no rule, and that is the honest answer
 *
 * Neither accepts `--session-id`, so neither is ever told what id to use: the
 * CLI picks one and does not report it. The file therefore cannot be named at
 * launch. `null` says exactly that, and the caller already treats it as "no
 * transcript path, open on the terminal" — which is also what a `(live)` row
 * inferred from tmux gets. The chat view appears for those two when the rail
 * next scans the disk and finds the file, not before.
 *
 * A path computed from *our* would-be id would be worse than none: it would
 * name a file that never exists, and the conversation view would open on an
 * empty read instead of falling back to a working terminal.
 *
 * ## POSIX only
 *
 * `src-tauri/src/helper.rs` refuses a Windows remote outright — the framed
 * channel is POSIX-only — so the chat view can never work there and there is no
 * measured Windows rule to reach for. Every function here returns `null` for
 * Windows rather than inventing one.
 *
 * Pure: no DOM and no imports beyond the panel's own path arithmetic, so
 * `node --test` runs it directly. It is the sibling of `lib/panel/paths.ts`,
 * which does the same job for the panel's tree and git roots.
 */
import type { AgentKind } from "../agents.ts";
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

/**
 * The transcript file a Grok session pinned to `sessionId` reads and writes on
 * a host, or `null` when no path can be computed.
 *
 * Same signature and same three `null` cases as {@link claudeTranscriptPath} —
 * Windows, and the empty id / cwd / home — because the caller's question is the
 * same one and should not have to remember which agent answers it differently.
 *
 * The encoding is applied to the **normalised** cwd, so `/srv/app/` and
 * `/srv/./app` name one directory rather than two. `encodeURIComponent` leaves
 * no literal `/`, so the encoded cwd is one segment of the joined path and the
 * intermediate directories stay separate, which is what the disk has.
 */
export function grokTranscriptPath(
  sessionId: string,
  cwd: string,
  home: string,
  os: "posix" | "windows",
): string | null {
  if (os === "windows") return null;
  const id = sessionId.trim();
  if (id === "" || cwd.trim() === "" || home.trim() === "") return null;
  const dir = encodeURIComponent(normalizePath(cwd));
  return joinPath(home, `.grok/sessions/${dir}/${id}/chat_history.jsonl`);
}

/**
 * The transcript path for a new session on `agent`, by that agent's own rule.
 *
 * `null` carries two different facts, and both callers want the same thing done
 * about them. For Claude and Grok it means a degenerate input — nothing to name.
 * For Codex and Pi it means the id was never ours to know (see the module doc),
 * so the file cannot be named *yet*: the row gains its chat view when the rail
 * scans the disk, not at launch.
 *
 * Written as a switch over the union rather than a lookup table so that adding
 * an agent is a compile error here until someone decides which of the two facts
 * applies to it — a table with a `default: null` would let a new agent fall
 * silently into "no chat view".
 */
export function transcriptPathFor(
  agent: AgentKind,
  sessionId: string,
  cwd: string,
  home: string,
  os: "posix" | "windows",
): string | null {
  switch (agent) {
    case "claude":
      return claudeTranscriptPath(sessionId, cwd, home, os);
    case "grok":
      return grokTranscriptPath(sessionId, cwd, home, os);
    case "codex":
    case "pi":
      return null;
  }
}

/**
 * `chat/transcript-path.ts` — the transcript path a *new* session's id names.
 *
 * The rules are measurement, not deduction (see the module doc), so the tests
 * are the measured examples verbatim, plus the boundaries that distinguish each
 * rule from the ones it is not: a `/`-only slug, a non-alphanumeric-replacing
 * slug, and a cwd with no `.` at all for Claude; a partially-encoded cwd for
 * Grok. The Windows `null` is here too, because "we cannot know, so we say so"
 * is the whole reason the function returns a nullable — and so is the Codex/Pi
 * `null`, which says the same thing about a *different* unknowable: an id the
 * CLI chose rather than one we pinned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeTranscriptPath,
  grokTranscriptPath,
  projectSlug,
  transcriptPathFor,
} from "./transcript-path.ts";

// ---------------------------------------------------------------------------
// The slug
// ---------------------------------------------------------------------------

test("projectSlug is the measured example, double dash and all", () => {
  // The one remote path the S0 spike actually listed. The `.claude` segment's
  // dot is what makes the doubled dash, and a `/`-only rule would miss it.
  const slug = projectSlug("/Users/sunny/code/litellm/.claude/worktrees/x");
  assert.equal(slug, "-Users-sunny-code-litellm--claude-worktrees-x");
  assert.ok(slug.includes("--"), "the `.claude` segment's dot must show as a second dash");
});

test("projectSlug on a cwd with no dot at all", () => {
  assert.equal(projectSlug("/srv/app/faragent"), "-srv-app-faragent");
});

test("projectSlug leaves a character that is neither `/` nor `.` alone", () => {
  // The remote's own inverse (`claude_guess_cwd`) turns `-` back to `/` and
  // leaves the rest literal, so a `_` must survive the forward direction too —
  // a rule that replaced every non-alphanumeric would break that inverse.
  assert.equal(projectSlug("/srv/my_app"), "-srv-my_app");
});

test("projectSlug normalises before it replaces, so one directory has one slug", () => {
  assert.equal(projectSlug("/srv/app"), "-srv-app");
  assert.equal(projectSlug("/srv/app/"), "-srv-app", "a trailing slash is not a segment");
  assert.equal(projectSlug("/srv/./app"), "-srv-app", "a `.` segment drops out entirely");
  assert.equal(projectSlug("/srv/lib/../app"), "-srv-app", "a `..` resolves away");
});

test("projectSlug of the root is a single dash", () => {
  assert.equal(projectSlug("/"), "-");
});

// ---------------------------------------------------------------------------
// The path
// ---------------------------------------------------------------------------

const ID = "15c76662-2409-4f37-bd81-fd4f1b3053dd";

test("claudeTranscriptPath joins home, `.claude/projects`, the slug and the id", () => {
  assert.equal(
    claudeTranscriptPath(ID, "/srv/app/faragent", "/home/deploy", "posix"),
    `/home/deploy/.claude/projects/-srv-app-faragent/${ID}.jsonl`,
  );
});

test("claudeTranscriptPath slugs only the cwd, never the fixed middle segments", () => {
  // The `.claude` and `projects` segments are literal; only the slug is
  // rewritten, so a cwd with a dot cannot bleed into them.
  assert.equal(
    claudeTranscriptPath(ID, "/srv/a.b", "/home/deploy", "posix"),
    `/home/deploy/.claude/projects/-srv-a-b/${ID}.jsonl`,
  );
});

test("claudeTranscriptPath normalises a home with a trailing slash", () => {
  assert.equal(
    claudeTranscriptPath(ID, "/srv/app", "/home/deploy/", "posix"),
    `/home/deploy/.claude/projects/-srv-app/${ID}.jsonl`,
  );
});

test("claudeTranscriptPath is null on a Windows remote", () => {
  // The helper refuses a Windows remote outright, so there is no measured rule
  // to guess at; null is the honest answer, not a plausible-looking path.
  assert.equal(claudeTranscriptPath(ID, "C:\\Users\\me\\src", "C:\\Users\\me", "windows"), null);
});

test("claudeTranscriptPath is null for the inputs that would build a wrong path", () => {
  assert.equal(claudeTranscriptPath("", "/srv/app", "/home/deploy", "posix"), null);
  assert.equal(claudeTranscriptPath("   ", "/srv/app", "/home/deploy", "posix"), null);
  assert.equal(claudeTranscriptPath(ID, "", "/home/deploy", "posix"), null);
  assert.equal(claudeTranscriptPath(ID, "  ", "/home/deploy", "posix"), null);
  assert.equal(claudeTranscriptPath(ID, "/srv/app", "", "posix"), null);
});

// ---------------------------------------------------------------------------
// Grok: the cwd is one directory name, not a slug
// ---------------------------------------------------------------------------

test("grokTranscriptPath percent-encodes the cwd into a single path segment", () => {
  // The measured example. This machine's `~/.grok/sessions/` holds a directory
  // literally named `%2FUsers%2Fmaqb11%2Fcode%2Fma-code%2FFarAgent`, and the
  // session directories live inside it. Note what the rule is *not*: it is not
  // Claude's slug (which would be `-Users-maqb11-...`), and it is not a
  // `/`-preserving join (which would nest a directory per segment).
  assert.equal(
    grokTranscriptPath(ID, "/Users/maqb11/code/ma-code/FarAgent", "/Users/maqb11", "posix"),
    `/Users/maqb11/.grok/sessions/%2FUsers%2Fmaqb11%2Fcode%2Fma-code%2FFarAgent/${ID}/chat_history.jsonl`,
  );
});

test("grokTranscriptPath encodes the characters a path may hold", () => {
  // A space is the case that tells a real URI encoding from a hand-rolled
  // `.replace(/\//g, "%2F")`: the measured directory names are ASCII-only, so
  // this follows `encodeURIComponent` — the standard the measured names agree
  // with — rather than inventing a rule of our own.
  assert.equal(
    grokTranscriptPath(ID, "/srv/my app", "/home/deploy", "posix"),
    `/home/deploy/.grok/sessions/%2Fsrv%2Fmy%20app/${ID}/chat_history.jsonl`,
  );
});

test("grokTranscriptPath normalises the cwd, so one directory has one name", () => {
  assert.equal(
    grokTranscriptPath(ID, "/srv/app/", "/home/deploy", "posix"),
    grokTranscriptPath(ID, "/srv/./app", "/home/deploy", "posix"),
  );
  assert.equal(
    grokTranscriptPath(ID, "/srv/app/", "/home/deploy", "posix"),
    `/home/deploy/.grok/sessions/%2Fsrv%2Fapp/${ID}/chat_history.jsonl`,
  );
});

test("grokTranscriptPath is null on a Windows remote and for a degenerate input", () => {
  assert.equal(grokTranscriptPath(ID, "C:\\Users\\me\\src", "C:\\Users\\me", "windows"), null);
  assert.equal(grokTranscriptPath("", "/srv/app", "/home/deploy", "posix"), null);
  assert.equal(grokTranscriptPath("   ", "/srv/app", "/home/deploy", "posix"), null);
  assert.equal(grokTranscriptPath(ID, "", "/home/deploy", "posix"), null);
  assert.equal(grokTranscriptPath(ID, "/srv/app", "", "posix"), null);
});

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

test("transcriptPathFor gives each agent the rule that fits it", () => {
  assert.equal(
    transcriptPathFor("claude", ID, "/srv/app", "/home/deploy", "posix"),
    claudeTranscriptPath(ID, "/srv/app", "/home/deploy", "posix"),
  );
  assert.equal(
    transcriptPathFor("grok", ID, "/srv/app", "/home/deploy", "posix"),
    grokTranscriptPath(ID, "/srv/app", "/home/deploy", "posix"),
  );
});

test("transcriptPathFor is null for the agents whose CLI picks its own id", () => {
  // Not a gap to be filled later and not a rule we have not learned: Codex and
  // Pi do not accept `--session-id` (see `AgentKind::may_accept_session_id` and
  // its tests in `crates/faragent-core/src/agents.rs`), so the id — and with it
  // the file — is not knowable at launch. A plausible-looking path computed from
  // an id the CLI never used would be worse than no path at all: the chat view
  // would open on a file that does not exist and stay empty.
  assert.equal(transcriptPathFor("codex", ID, "/srv/app", "/home/deploy", "posix"), null);
  assert.equal(transcriptPathFor("pi", ID, "/srv/app", "/home/deploy", "posix"), null);
});

test("transcriptPathFor is null on a Windows remote for every agent", () => {
  for (const agent of ["claude", "codex", "grok", "pi"] as const) {
    assert.equal(
      transcriptPathFor(agent, ID, "C:\\Users\\me\\src", "C:\\Users\\me", "windows"),
      null,
      agent,
    );
  }
});

test("transcriptPathFor keeps the degenerate-input answer of the rule it dispatches to", () => {
  assert.equal(transcriptPathFor("claude", "", "/srv/app", "/home/deploy", "posix"), null);
  assert.equal(transcriptPathFor("grok", "/srv/app", "", "/home/deploy", "posix"), null);
});

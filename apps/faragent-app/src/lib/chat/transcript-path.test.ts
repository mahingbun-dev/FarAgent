/**
 * `chat/transcript-path.ts` — the transcript path a *new* session's id names.
 *
 * The rule is measurement, not deduction (see the module doc), so the tests are
 * the measured example verbatim, plus the boundaries that distinguish it from
 * the rules it is not: a `/`-only slug, a non-alphanumeric-replacing slug, and a
 * cwd with no `.` at all. The Windows `null` is here too, because "we cannot
 * know, so we say so" is the whole reason the function returns a nullable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeTranscriptPath, projectSlug } from "./transcript-path.ts";

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

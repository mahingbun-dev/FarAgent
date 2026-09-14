/**
 * `lib/helper.ts`'s own tests.
 *
 * Two halves, and the split matters:
 *
 * * the **pure** half pins the error mapping, the b64/path codecs, the mode
 *   notice and the push narrowing — no backend, no channel;
 * * the **channel** half drives the real `lib/helper.ts` client against the
 *   mock's virtual remote, through `mockIPC`. That is what proves a panel task
 *   can actually open a connection in a browser and read a tree, a big file, a
 *   binary refusal, a non-repository, a dirty repository and a 620-file diff.
 *
 * There are no React rendering tests here on purpose: the panel is Task 9/10,
 * and a test that mounted a component would be testing a component that does
 * not exist yet.
 *
 * `mockIPC` installs itself on `window`, which a plain Node process does not
 * have, so the suite lends it one — same trick as `mock/mock.test.ts`.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { invoke } from "@tauri-apps/api/core";
import {
  FALLBACK_REASONS,
  HELPER_ERROR_CODES,
  HELPER_OPS,
  HelperError,
  asFsChanged,
  asGitChanged,
  decodeText,
  encodePath,
  helperErrorText,
  helperFallbackNotice,
  openHelper,
} from "./helper.ts";
import type { HelperEvent, HelperMode } from "./helper.ts";
import { b64ToBytes } from "./bytes.ts";
import { ipc } from "./ipc.ts";
import { HELPER_FIXTURES, mockedOps } from "./mock/helper.ts";
import { installMocks, uninstallMocks } from "./mock/index.ts";

const NATIVE_HOST = "build-01.farm.internal";
const FALLBACK_HOST = "gpu-box";
const WINDOWS_HOST = "win-builder";

before(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  assert.equal(installMocks({ force: true }), true, "the suite needs the mock installed");
});

after(() => {
  uninstallMocks();
});

/** One macrotask, which is when the mock delivers a push. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// The closed sets
// ---------------------------------------------------------------------------

test("the op set matches the helper's, in order", () => {
  // `faragent_helper::ops::OPS`. The mock restates it rather than importing it
  // (the mock must not depend on the client), so this is the guard that keeps
  // the two from drifting.
  assert.deepEqual(mockedOps(), [...HELPER_OPS]);
  assert.equal(HELPER_OPS.length, 12);
});

test("the error and fallback sets are the protocol's closed ones", () => {
  assert.deepEqual(
    [...HELPER_ERROR_CODES].sort(),
    [
      "bad_request",
      "binary",
      "git_failed",
      "internal",
      "not_a_dir",
      "not_a_repo",
      "not_found",
      "too_large",
      "unreadable",
    ],
    "proto::ErrorCode's nine, no more and no fewer",
  );
  assert.deepEqual(
    [...FALLBACK_REASONS],
    [
      "unsupported_platform",
      "no_local_artifact",
      "no_checksum_tool",
      "probe_failed",
      "windows_remote",
      "upload_failed",
      "verify_failed",
      "not_executable",
    ],
    "FallbackReason::code's eight",
  );
});

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

test("a path survives the round trip through the wire", () => {
  const typed = "/srv/app/src/lib/helper/proto.rs";
  assert.equal(decodeText(b64ToBytes(encodePath(typed))), typed);
  // Not UTF-8, and it still has to arrive whole: this is why paths are bytes.
  const latin1 = "/srv/app/café/über.rs";
  assert.equal(decodeText(b64ToBytes(encodePath(latin1))), latin1);
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

test("a remote error keeps its protocol code", () => {
  const error = HelperError.from({
    kind: "remote",
    code: "not_a_repo",
    message: "no git repository at or above /srv/scratch",
  });
  assert.equal(error.kind, "remote");
  assert.equal(error.code, "not_a_repo");
  assert.equal(error.errorCode, "not_a_repo");
  assert.equal(error.retryable, false, "a missing repository is not a transient failure");
  assert.match(error.message, /no git repository/);
});

test("a Tauri-wrapped payload unwraps before it is read", () => {
  // Tauri may hand the rejection through as `{ payload: … }`; both spellings
  // reach the webview, and both have to map to the same thing. The fixture is
  // the wire's real timeout shape — `{"kind":"timeout","op":…,"seconds":…}`,
  // which carries no prose for the backend to hand over.
  const error = HelperError.from({
    payload: { kind: "timeout", op: "git.diff", seconds: 60 },
  });
  assert.equal(error.kind, "timeout");
  assert.equal(error.op, "git.diff");
  assert.equal(error.seconds, 60);
  assert.equal(error.retryable, true);
  assert.equal(error.message, "no reply to git.diff within 60s");
});

test("a disconnect is retryable and a bad request is not", () => {
  assert.equal(HelperError.from({ kind: "disconnected", message: "gone" }).retryable, true);
  assert.equal(
    HelperError.from({ kind: "remote", code: "bad_request", message: "no" }).retryable,
    false,
  );
});

test("a code outside the closed set is kept as text but not claimed as one", () => {
  const error = HelperError.from({ kind: "remote", code: "made_up", message: "?" });
  assert.equal(error.code, "made_up", "the raw code survives for a log line");
  assert.equal(error.errorCode, null, "but it is not one of the nine");
});

test("a plain CommandError, a bare string and a HelperError all normalise", () => {
  // `helper_open` fails with a `CommandError`, which is a different shape from
  // a helper call's failure. All of them come out as a HelperError.
  const plain = HelperError.from({ kind: "plain", message: "no route to host" });
  assert.equal(plain.kind, "open");
  assert.equal(plain.message, "no route to host");

  const bare = HelperError.from("something exploded");
  assert.equal(bare.kind, "open");
  assert.equal(bare.message, "something exploded");

  const already = new HelperError("remote", "nope", { code: "internal" });
  assert.equal(HelperError.from(already), already, "a HelperError passes through untouched");
});

test("a diagnosis behind an open failure is rendered in the user's language", () => {
  const failure = {
    kind: "diagnosis",
    diagnosis: {
      problem: "publickey_denied",
      summary: { zh: "远端拒绝了密钥。", en: "the remote rejected the key." },
    },
  };
  assert.equal(helperErrorText(failure, "zh"), "远端拒绝了密钥。");
  assert.equal(helperErrorText(failure, "en"), "the remote rejected the key.");
  // The same failure, one normalisation later: `openHelper` rejects with a
  // `HelperError`, whose only remaining trace of the diagnosis is `cause`. Read
  // from the top level alone, this answered in English for a Chinese user.
  const normalised = HelperError.from(failure);
  assert.equal(helperErrorText(normalised, "zh"), "远端拒绝了密钥。");
  assert.equal(helperErrorText(normalised, "en"), "the remote rejected the key.");
  // The diagnosis shape has no `message` field, so `.message` is derived from
  // the diagnosis instead of being stringified: a panel that prints
  // `error.message` directly used to print "[object Object]" here — the
  // commonest `helper_open` failure there is.
  assert.equal(HelperError.from(failure).message, "the remote rejected the key.");
  assert.equal(HelperError.from(failure).kind, "open");
  // `helper_open` reaches the webview through `payload` as often as not.
  assert.equal(
    HelperError.from({ payload: failure }).message,
    "the remote rejected the key.",
  );
  // Anything else falls back to the plain message, never to "[object Object]".
  assert.equal(helperErrorText({ kind: "plain", message: "boom" }, "zh"), "boom");
});

test("no tagged failure reaches the user as [object Object]", () => {
  // The class of bug rather than one instance: every shape below has a tag and
  // no `message`, and `String(object)` is "[object Object]" for all of them.
  for (const payload of [
    { kind: "weird" },
    { kind: "remote", code: "internal" },
    { kind: "timeout" },
  ]) {
    const message = HelperError.from(payload).message;
    assert.doesNotMatch(message, /\[object Object\]/, JSON.stringify(payload));
    assert.ok(message.length > 0, JSON.stringify(payload));
  }
  assert.equal(HelperError.from({ kind: "timeout" }).message, "no reply to the request");
});

// ---------------------------------------------------------------------------
// Mode and notices
// ---------------------------------------------------------------------------

test("the fallback notice speaks only when there is a fallback", () => {
  const native: HelperMode = { kind: "native" };
  assert.equal(helperFallbackNotice(native, "zh"), null);
  assert.equal(helperFallbackNotice(native, "en"), null);

  const fallback: HelperMode = {
    kind: "script_fallback",
    reason: {
      code: "no_checksum_tool",
      message: { zh: "缺少校验工具，改用脚本模式。", en: "no checksum tool; script mode." },
    },
  };
  assert.equal(helperFallbackNotice(fallback, "zh"), "缺少校验工具，改用脚本模式。");
  assert.equal(helperFallbackNotice(fallback, "en"), "no checksum tool; script mode.");
});

test("a push is passed through, and narrowed only when it is recognised", () => {
  const push = { event: "fs.changed", data: { subscription: 3, root_b64: "", path_b64: "", kind: "created" } };
  assert.deepEqual(asFsChanged(push), {
    subscription: 3,
    root: new Uint8Array(0),
    path: new Uint8Array(0),
    kind: "created",
  });
  assert.equal(asGitChanged(push), null, "a name this module does not know is not guessed at");

  const git = { event: "git.changed", data: { subscription: 1, root_b64: "" } };
  assert.deepEqual(asGitChanged(git), { subscription: 1, root: new Uint8Array(0) });
  assert.equal(asFsChanged(git), null);
});

// ---------------------------------------------------------------------------
// The channel, against the mock's virtual remote
// ---------------------------------------------------------------------------

test("a native host opens, answers, and closes", async () => {
  const connection = await openHelper(NATIVE_HOST);
  assert.equal(connection.host, NATIVE_HOST);
  assert.equal(connection.native, true);
  assert.equal(connection.mode.kind, "native");
  assert.equal(connection.fallbackReason, null, "a native connection has no reason to show");
  assert.equal(typeof connection.id, "number");

  const pong = await connection.ping();
  assert.equal(pong.pong, true);
  assert.deepEqual(pong.ops, [...HELPER_OPS], "both ends agree on the op set");

  await connection.close();
  assert.equal(connection.isClosed, true);
  await connection.close(); // idempotent

  await assert.rejects(
    connection.ping(),
    (e: unknown) => HelperError.from(e).kind === "disconnected",
    "a call after close must fail, not hang",
  );
});

test("a fallback host says so, with the reason the service module would give", async () => {
  const connection = await openHelper(FALLBACK_HOST);
  assert.equal(connection.native, false);
  assert.equal(connection.mode.kind, "script_fallback");
  const reason = connection.fallbackReason;
  assert.notEqual(reason, null);
  assert.equal(reason?.code, "no_checksum_tool");
  // The exact sentence `FallbackReason::NoChecksumTool` carries, so a panel that
  // renders it renders the same words the TUI does.
  assert.equal(
    helperFallbackNotice(connection.mode, "en"),
    reason?.message.en,
  );
  assert.match(reason?.message.zh ?? "", /缺少 sha256sum/);
  await connection.close();
});

test("a Windows remote fails to open, and says why", async () => {
  await assert.rejects(openHelper(WINDOWS_HOST), (e: unknown) => {
    const error = HelperError.from(e);
    assert.equal(error.kind, "open");
    assert.match(error.message, /POSIX-only/);
    return true;
  });
});

test("the multi-level tree comes back as the wire's entries", async () => {
  const helper = await openHelper(NATIVE_HOST);
  const tree = await helper.listDir(HELPER_FIXTURES.tree);
  assert.equal(decodeText(tree.path), HELPER_FIXTURES.tree);
  assert.equal(decodeText(tree.parent), "/srv");
  assert.equal(tree.truncated, false);

  const names = tree.entries.map((entry) => decodeText(entry.name));
  for (const expected of [".github", "docs", "scripts", "src", "target", "Cargo.toml"]) {
    assert.ok(names.includes(expected), `${expected} is missing from the tree`);
  }
  const src = tree.entries.find((entry) => decodeText(entry.name) === "src");
  assert.equal(src?.kind, "dir");
  const target = tree.entries.find((entry) => decodeText(entry.name) === "target");
  assert.equal(target?.kind, "symlink");
  assert.equal(target?.isSymlink, true);

  // Four levels further down, which is what makes it a *multi-level* fixture.
  const proto = await helper.stat(
    `${HELPER_FIXTURES.tree}/src/lib/helper/proto.rs`,
  );
  assert.equal(proto.kind, "file");
  assert.ok(proto.size > 0);
  assert.ok(proto.mtime > 0);
  assert.ok(proto.mode > 0, "a POSIX remote reports mode bits");

  await helper.close();
});

test("a file over 1 MiB arrives in windows, and says when it is done", async () => {
  const helper = await openHelper(NATIVE_HOST);
  const stat = await helper.stat(HELPER_FIXTURES.hugeFile);
  assert.ok(stat.size > 1024 * 1024, `expected over 1 MiB, got ${stat.size}`);

  // The default window is 256 KiB, so the first read is deliberately not the
  // whole file — a panel has to page, and this fixture makes it do so.
  const first = await helper.readFile(HELPER_FIXTURES.hugeFile);
  assert.equal(first.size, stat.size);
  assert.equal(first.data.length, 256 * 1024);
  assert.equal(first.eof, false);
  // The window is the file's *head*, not a middle slice: a panel that paged
  // from the wrong offset would still get 256 KiB, so assert on the content.
  assert.match(decodeText(first.data.subarray(0, 128)), /^2026-09-14T09:00:00Z {2}faragent-helper/);

  const tail = await helper.readFile(HELPER_FIXTURES.hugeFile, {
    offset: stat.size - 16,
    limit: 16,
  });
  assert.equal(tail.eof, true);
  assert.equal(tail.data.length, 16);

  await helper.close();
});

test("a binary file is refused with the code, not rendered as mojibake", async () => {
  const helper = await openHelper(NATIVE_HOST);
  await assert.rejects(helper.readFile(HELPER_FIXTURES.binaryFile), (e: unknown) => {
    const error = HelperError.from(e);
    assert.equal(error.kind, "remote");
    assert.equal(error.errorCode, "binary");
    return true;
  });
  // `stat` still works on it: the refusal is about *content*.
  const stat = await helper.stat(HELPER_FIXTURES.binaryFile);
  assert.equal(stat.kind, "file");
  await helper.close();
});

test("a directory that is not a repository answers not_a_repo", async () => {
  const helper = await openHelper(NATIVE_HOST);
  assert.equal(decodeText((await helper.listDir(HELPER_FIXTURES.nonRepo)).path), "/srv/scratch");
  await assert.rejects(helper.discoverGit(HELPER_FIXTURES.nonRepo), (e: unknown) => {
    assert.equal(HelperError.from(e).errorCode, "not_a_repo");
    return true;
  });
  await helper.close();
});

test("a dirty repository reports every status letter, both sides", async () => {
  const helper = await openHelper(NATIVE_HOST);
  const status = await helper.gitStatus(HELPER_FIXTURES.dirtyRepo);
  assert.equal(decodeText(status.root), HELPER_FIXTURES.dirtyRepo);
  assert.equal(decodeText(status.branch ?? new Uint8Array()), "main");
  assert.equal(status.clean, false);
  assert.equal(status.truncated, false);
  assert.equal(status.files.length, 14);

  const byPath = new Map(status.files.map((file) => [decodeText(file.path), file]));
  const unstaged = byPath.get("src/app.rs");
  assert.equal(unstaged?.status, "modified");
  assert.equal(unstaged?.staged, false);
  const staged = byPath.get("src/lib.rs");
  assert.equal(staged?.staged, true);
  const renamed = byPath.get("src/moved.rs");
  assert.equal(renamed?.status, "renamed");
  assert.equal(decodeText(renamed?.origPath ?? new Uint8Array()), "src/renamed-from.rs");
  assert.equal(byPath.get("notes.txt")?.status, "untracked");
  assert.equal(byPath.get("src/conflict.rs")?.status, "conflicted");
  assert.equal(byPath.get("bin/tool")?.status, "typechange");

  // The list is the status half; the branches are their own call.
  const branches = await helper.gitBranches(HELPER_FIXTURES.dirtyRepo);
  assert.deepEqual(
    branches.branches.filter((branch) => branch.current).map((branch) => decodeText(branch.name)),
    ["main"],
  );
  assert.ok(branches.branches.some((branch) => branch.remote));

  const log = await helper.gitLog(HELPER_FIXTURES.dirtyRepo, { limit: 3 });
  assert.equal(log.commits.length, 3);
  assert.equal(log.truncated, true, "9 commits exist, 3 were asked for");
  assert.equal(decodeText(log.commits[0].refs ?? new Uint8Array()), "HEAD -> main");
  assert.equal(log.commits[1].refs, null, "only the head carries a decoration");

  await helper.close();
});

test("a diff over 500 files is capped, and the patch is still delivered", async () => {
  const helper = await openHelper(NATIVE_HOST);
  const status = await helper.gitStatus(HELPER_FIXTURES.bigRepo);
  assert.equal(status.truncated, true, `${HELPER_FIXTURES.bigRepoChanges} changes, capped at 500`);
  assert.equal(status.files.length, 500);
  assert.equal(status.clean, false, "truncated is not clean");

  const diff = await helper.gitDiff(HELPER_FIXTURES.bigRepo);
  assert.equal(diff.files.length, 500);
  assert.equal(diff.truncated, true);
  assert.equal(diff.filesOnly, false, "this patch fits the helper's budget");
  assert.notEqual(diff.diff, null);
  const patch = decodeText(diff.diff ?? new Uint8Array());
  // `pkg-000` is one of the staged entries, so the unstaged patch opens on
  // `pkg-001` — the first file this side actually touched.
  assert.match(patch, /^diff --git a\/packages\/pkg-001\/src\/index\.ts/);
  assert.match(patch, /^\+\+\+ b\/packages\/pkg-001\/src\/index\.ts/m);

  // `files_only` asks for the list alone, which is what a panel does when it
  // only wants counts.
  const listOnly = await helper.gitDiff(HELPER_FIXTURES.bigRepo, { filesOnly: true });
  assert.equal(listOnly.filesOnly, true);
  assert.equal(listOnly.diff, null);
  assert.equal(listOnly.files.length, 500);

  // Staged and unstaged are different lists: the fixture stages 1-in-8.
  const staged = await helper.gitDiff(HELPER_FIXTURES.bigRepo, { staged: true });
  assert.ok(
    staged.files.length > 0 && staged.files.length < 500,
    `expected a strict subset, got ${staged.files.length}`,
  );

  await helper.close();
});

test("a diff names a binary file instead of printing its bytes", async () => {
  const helper = await openHelper(NATIVE_HOST);
  const diff = await helper.gitDiff(HELPER_FIXTURES.dirtyRepo);
  assert.equal(diff.binary, true);
  assert.match(decodeText(diff.diff ?? new Uint8Array()), /Binary files a\/assets\/logo\.png/);
  const png = diff.files.find((file) => decodeText(file.path) === "assets/logo.png");
  assert.notEqual(png, undefined);
  await helper.close();
});

test("a subscription is idempotent and pushes arrive on the channel", async () => {
  const pushes: HelperEvent[] = [];
  const helper = await openHelper(NATIVE_HOST, {
    onPush: (event) => pushes.push({ kind: "push", event: event.event, data: event.data }),
  });

  // A plain directory is watched by the filesystem watcher.
  const plain = await helper.subscribe(HELPER_FIXTURES.nonRepo);
  assert.equal(plain.already, false);
  assert.equal(plain.gitDir, null);
  await tick();
  assert.equal(pushes.length, 1);
  const first = pushes[0];
  assert.equal(first.kind, "push");
  if (first.kind === "push") {
    assert.equal(first.event, "fs.changed");
    assert.equal(asFsChanged(first)?.subscription, plain.subscription);
  }

  // A repository is watched by the git poll as well, which is what the panel
  // refreshes its status on.
  const watched = await helper.subscribe(HELPER_FIXTURES.tree);
  assert.notEqual(watched.gitDir, null);
  await tick();
  assert.equal(pushes.length, 2);
  const second = pushes[1];
  if (second.kind === "push") {
    assert.equal(second.event, "git.changed");
    assert.equal(asGitChanged(second)?.subscription, watched.subscription);
  }

  // Idempotent: the same watch comes back with the same id.
  const again = await helper.subscribe(HELPER_FIXTURES.tree);
  assert.equal(again.already, true);
  assert.equal(again.subscription, watched.subscription);

  assert.deepEqual(await helper.unsubscribe({ subscription: plain.subscription }), {
    removed: 1,
  });
  assert.deepEqual(await helper.unsubscribe({ subscription: plain.subscription }), {
    removed: 0,
  });
  // An unsubscribe that names nothing is a bad request, not a silent success.
  await assert.rejects(helper.unsubscribe({}), (e: unknown) => {
    assert.equal(HelperError.from(e).errorCode, "bad_request");
    return true;
  });

  // Removing the listener stops delivery to it.
  const off = helper.onPush(() => {
    throw new Error("this listener was unsubscribed");
  });
  off();
  await helper.subscribe("/var/log/faragent");
  await tick();

  await helper.close();
});

test("a late closed-listener is told immediately, and only once", async () => {
  const seen: string[] = [];
  const helper = await openHelper(NATIVE_HOST);
  const off = helper.onClosed((message) => seen.push(message));
  assert.deepEqual(seen, [], "nothing has closed yet");
  await helper.close();
  assert.equal(seen.length, 1);
  assert.equal(helper.closeReason, seen[0]);
  off();

  const after: string[] = [];
  helper.onClosed((message) => after.push(message));
  assert.equal(after.length, 1, "a subscriber after the fact is told at once");
  assert.equal(after[0], seen[0]);
});

test("an unknown op is a protocol error, never a silent undefined", async () => {
  const helper = await openHelper(NATIVE_HOST);
  await assert.rejects(helper.call("fs.chmod"), (e: unknown) => {
    const error = HelperError.from(e);
    assert.equal(error.kind, "remote");
    assert.equal(error.errorCode, "bad_request");
    assert.match(error.message, /unknown op/);
    return true;
  });
  // Arguments that are not an object are refused before they reach the wire.
  await assert.rejects(helper.call("fs.list", [] as unknown as Record<string, unknown>), (e) => {
    assert.equal(HelperError.from(e).errorCode, "bad_request");
    return true;
  });
  // And a missing required parameter is the remote's business, not this side's.
  await assert.rejects(helper.listDir(""), (e: unknown) => {
    assert.equal(HelperError.from(e).errorCode, "bad_request");
    return true;
  });
  await helper.close();
});

test("a non-existent path is not_found, and listing a file is not_a_dir", async () => {
  const helper = await openHelper(NATIVE_HOST);
  await assert.rejects(helper.stat("/no/such/place"), (e: unknown) => {
    assert.equal(HelperError.from(e).errorCode, "not_found");
    return true;
  });
  await assert.rejects(helper.listDir("/srv/app/README.md"), (e: unknown) => {
    assert.equal(HelperError.from(e).errorCode, "not_a_dir");
    return true;
  });
  await helper.close();
});

test("shutdown answers and then the channel ends", async () => {
  const helper = await openHelper(NATIVE_HOST);
  const closed = new Promise<string>((resolve) => helper.onClosed(resolve));
  assert.deepEqual(await helper.shutdown(), { bye: true });
  assert.match(await closed, /closed the helper channel/);
  assert.equal(helper.isClosed, true);
});

test("opening the same host twice replaces the first connection", async () => {
  // `helper.rs` keeps one `CommandStream` per host. A panel that re-opens on a
  // remount must not end up holding a connection the backend has already let go
  // of, so the replacement is pinned here.
  const first = await openHelper(NATIVE_HOST);
  const firstClosed: string[] = [];
  first.onClosed((message) => firstClosed.push(message));

  const second = await openHelper(NATIVE_HOST);
  assert.notEqual(first.id, second.id, "the replacement is a new session");
  await tick();
  assert.equal(first.isClosed, true, "the replaced connection is told it ended");
  assert.equal(firstClosed.length, 1);
  await assert.rejects(
    first.ping(),
    (e: unknown) => HelperError.from(e).kind === "disconnected",
    "and talking to it fails rather than hanging",
  );

  assert.equal((await second.ping()).pong, true);
  await second.close();
});

test("closing a session nobody opened is a no-op, but an unknown command still throws", async () => {
  // `helper_close` on an unknown id is not an error on the backend, and the
  // mock keeps that. The Task-3 contract is about *commands*, not sessions.
  await ipc.helperClose(4242);
  await assert.rejects(invoke("helper_nope"), (e: unknown) => {
    assert.equal((e as Error).message, "unknown mocked command: helper_nope");
    return true;
  });
});

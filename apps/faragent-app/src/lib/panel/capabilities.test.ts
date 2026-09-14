/**
 * `capabilities.ts` — the panel's op-set decision.
 *
 * The lists below are protocol facts, not fixtures: the twelve ops are
 * `crates/faragent-helper/src/ops/mod.rs`'s `OPS` (which `mockedOps()` mirrors)
 * and the seven are the bash fallback's own `ping` reply in
 * `crates/faragent-remote/src/fs.rs`, verbatim. Inlining them here rather than
 * importing the mock is the point — the decision is being pinned against the
 * real remote, not against the mock that is supposed to imitate it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPABILITY_OPS,
  OPTIMISTIC,
  capabilitiesFor,
  capabilitiesFromOps,
  type Pingable,
} from "./capabilities.ts";

const NATIVE_OPS = [
  "ping",
  "fs.list",
  "fs.read",
  "fs.stat",
  "git.discover",
  "git.status",
  "git.branches",
  "git.diff",
  "git.log",
  "watch.subscribe",
  "watch.unsubscribe",
  "shutdown",
];

/** `fs.rs`'s `ping` reply: the fallback script's whole vocabulary. */
const FALLBACK_OPS = [
  "ping",
  "fs.list",
  "fs.read",
  "fs.stat",
  "git.discover",
  "git.status",
  "git.log",
];

test("no answer yet is optimistic, so the panel does not flash disabled", () => {
  assert.deepEqual(capabilitiesFromOps(null), OPTIMISTIC);
  assert.deepEqual(OPTIMISTIC, { diff: true, branches: true, watch: true });
});

test("the native helper's full op list turns everything on", () => {
  assert.equal(NATIVE_OPS.length, 12);
  assert.deepEqual(capabilitiesFromOps(NATIVE_OPS), {
    diff: true,
    branches: true,
    watch: true,
  });
});

test("the bash fallback turns off exactly the three ops it does not speak", () => {
  // The bug this exists for: all three features were offered anyway, and the
  // only symptom was `unknown op \`git.diff\`` in the Changes tab.
  assert.equal(FALLBACK_OPS.length, 7);
  assert.deepEqual(capabilitiesFromOps(FALLBACK_OPS), {
    diff: false,
    branches: false,
    watch: false,
  });
  for (const op of Object.values(CAPABILITY_OPS)) {
    assert.ok(!FALLBACK_OPS.includes(op), `the fallback unexpectedly speaks ${op}`);
  }
});

test("an op set is read exactly, not as a whole-mode guess", () => {
  // A remote that speaks diffs but not branches is off for branches only — the
  // decision is per op, which is what makes it usable for a remote that is
  // neither of the two known shapes (a newer helper, a partial upload).
  assert.deepEqual(capabilitiesFromOps(["ping", "git.diff"]), {
    diff: true,
    branches: false,
    watch: false,
  });
  assert.deepEqual(capabilitiesFromOps(["watch.subscribe"]), {
    diff: false,
    branches: false,
    watch: true,
  });
  // An empty list is a remote that answers but claims nothing — read as such.
  assert.deepEqual(capabilitiesFromOps([]), {
    diff: false,
    branches: false,
    watch: false,
  });
});

/** A connection that counts its pings and answers with `ops`. */
function fakeConnection(ops: string[]): Pingable & { pings: number } {
  const connection = {
    pings: 0,
    ping() {
      connection.pings += 1;
      return Promise.resolve({ ops });
    },
  };
  return connection;
}

/** The same, for a channel that is up but answers nothing. */
function failingConnection(): Pingable & { pings: number } {
  const connection = {
    pings: 0,
    ping() {
      connection.pings += 1;
      return Promise.reject(new Error("the channel went away"));
    },
  };
  return connection;
}

test("a connection is asked once, however many callers ask", async () => {
  // StrictMode's remount and a second panel on the same host both land here;
  // two pings for one unchanging answer would be two round trips over the ssh
  // channel the panel is already sharing.
  const connection = fakeConnection(NATIVE_OPS);
  const first = capabilitiesFor(connection);
  const second = capabilitiesFor(connection);
  assert.equal(first, second, "the promise itself must be shared, not just its value");
  assert.deepEqual(await first, { diff: true, branches: true, watch: true });
  assert.equal(connection.pings, 1);
});

test("a second connection is asked separately", async () => {
  const native = fakeConnection(NATIVE_OPS);
  const fallback = fakeConnection(FALLBACK_OPS);
  assert.deepEqual(await capabilitiesFor(native), {
    diff: true,
    branches: true,
    watch: true,
  });
  assert.deepEqual(await capabilitiesFor(fallback), {
    diff: false,
    branches: false,
    watch: false,
  });
  assert.equal(native.pings, 1);
  assert.equal(fallback.pings, 1);
});

test("a ping that fails is optimistic, not all-off", async () => {
  // A broken channel has its own state and its own sentence. Reading it as
  // "this remote cannot show diffs" would blame the fallback for a dead pipe.
  const connection = failingConnection();
  assert.deepEqual(await capabilitiesFor(connection), OPTIMISTIC);
  assert.equal(connection.pings, 1);
  // And the failure is remembered too, so a retry loop cannot hammer ping.
  assert.equal(capabilitiesFor(connection), capabilitiesFor(connection));
  assert.equal(connection.pings, 1);
});

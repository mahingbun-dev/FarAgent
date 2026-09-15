/**
 * `lease.ts` — the keyed lease both the attach and the panel helper ride on.
 *
 * The scheduler is injected, so "the close is deferred" is tested by flushing it
 * rather than by sleeping a macrotask and hoping. Every test here is a promise
 * about *one resource per key* and *a close for every resource*: those are the
 * two halves of the invariant in the module doc, and the multi-key half is the
 * one the single-slot version got wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLease } from "./lease.ts";

function harness() {
  const queue: Array<() => void> = [];
  return {
    lease: createLease<string>((fn) => queue.push(fn)),
    flush: () => {
      for (const fn of queue.splice(0)) fn();
    },
    pending: () => queue.length,
  };
}

/** The value the lease hands back for a key, which is what `close` receives. */
const conn = (key: string) => Promise.resolve(`conn:${key}`);

test("a second acquire on the same key joins the first open", async () => {
  const { lease } = harness();
  let opens = 0;
  const open = () => {
    opens += 1;
    return conn("a");
  };

  const first = lease.acquire("a", open);
  const second = lease.acquire("a", open);
  assert.equal(await first, "conn:a");
  assert.equal(await second, "conn:a");
  assert.equal(opens, 1, "one resource, two holders");
});

test("StrictMode acquire-release-acquire in one turn opens once and closes nothing", async () => {
  const { lease, flush } = harness();
  const closed: string[] = [];
  let opens = 0;
  const open = () => {
    opens += 1;
    return conn("a");
  };
  const close = (value: string) => closed.push(value);

  await lease.acquire("a", open);
  lease.release("a", close); // StrictMode cleanup
  await lease.acquire("a", open); // remount
  flush(); // the cleanup's deferred close lands here
  await Promise.resolve();

  assert.equal(opens, 1, "the remount opened a second resource");
  assert.deepEqual(closed, [], "the remount's resource was closed under it");

  lease.release("a", close); // the real unmount
  flush();
  await Promise.resolve();
  assert.deepEqual(closed, ["conn:a"]);
});

test("the close waits for the last holder and for the scheduled tick", async () => {
  const { lease, flush } = harness();
  const closed: string[] = [];

  // Two holders: a tab and the panel that joined it.
  lease.acquire("a", () => conn("a"));
  lease.acquire("a", () => conn("a"));

  lease.release("a", (v) => closed.push(v));
  assert.deepEqual(closed, [], "the close is deferred, not immediate");
  flush();
  assert.deepEqual(closed, [], "one holder is left, so the resource stays up");

  lease.release("a", (v) => closed.push(v));
  flush();
  await Promise.resolve();
  assert.deepEqual(closed, ["conn:a"]);
});

test("the close is driven by the resolved value, not the promise", async () => {
  const { lease, flush } = harness();
  const closed: string[] = [];
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((r) => {
    resolve = r;
  });

  lease.acquire("a", () => pending);
  lease.release("a", (v) => closed.push(v));
  flush();
  assert.deepEqual(closed, [], "the open has not answered yet");
  resolve("conn:a");
  await pending;
  assert.deepEqual(closed, ["conn:a"]);
});

test("a rejected open is never closed, and does not block the next acquire", async () => {
  const { lease, flush } = harness();
  const closed: string[] = [];
  const boom = new Error("no route to host");

  const failed = lease.acquire("a", () => Promise.reject(boom));
  await assert.rejects(failed, boom);
  lease.release("a", (v) => closed.push(v));
  flush();
  await Promise.resolve();
  assert.deepEqual(closed, [], "there was no resource to close");

  let opens = 0;
  const retried = lease.acquire("a", () => {
    opens += 1;
    return conn("a");
  });
  assert.equal(await retried, "conn:a");
  assert.equal(opens, 1, "the failed slot is gone; the key opened again");
});

// ------------------------------------------------------------- the multi-key half

test("each key's release closes its own resource, not the newest one", async () => {
  const { lease, flush } = harness();
  const closed: string[] = [];

  // The shell's own sequence: a second tab opens while the first is held.
  await lease.acquire("a", () => conn("a"));
  await lease.acquire("b", () => conn("b"));
  lease.release("a", (v) => closed.push(v));

  flush();
  await Promise.resolve();
  assert.deepEqual(closed, ["conn:a"], "tab a's attach was never hung up");
});

test("releasing in either order closes each resource exactly once", async () => {
  for (const order of [
    ["a", "b"],
    ["b", "a"],
  ] as const) {
    const { lease, flush } = harness();
    const closed: string[] = [];

    await lease.acquire("a", () => conn("a"));
    await lease.acquire("b", () => conn("b"));
    for (const key of order) lease.release(key, (v) => closed.push(v));
    flush();
    await Promise.resolve();

    assert.deepEqual(
      [...closed].sort(),
      ["conn:a", "conn:b"],
      `order ${order.join("→")} did not close both`,
    );
  }
});

test("a StrictMode rebound on one key leaves the other key's slot alone", async () => {
  const { lease, flush, pending } = harness();
  const closed: string[] = [];

  await lease.acquire("a", () => conn("a"));
  await lease.acquire("b", () => conn("b"));

  // Tab a remounts: its cleanup releases a, its new effect re-acquires a —
  // both while b is live and held.
  lease.release("a", (v) => closed.push(v));
  assert.equal(await lease.acquire("a", () => conn("a")), "conn:a");
  flush();
  await Promise.resolve();
  assert.deepEqual(closed, [], "the remount re-acquired a, or b was closed");

  // Then a real close of each, in the same tick.
  lease.release("a", (v) => closed.push(v));
  lease.release("b", (v) => closed.push(v));
  flush();
  await Promise.resolve();
  assert.deepEqual([...closed].sort(), ["conn:a", "conn:b"]);
  assert.equal(pending(), 0);
});

test("three keys opened and closed in various orders close once each", async () => {
  // The reviewer's reproduction, at the generic level: open and close three
  // tabs in assorted orders and count the closes.
  const orders = [
    [["1", "2", "3"], ["1", "2", "3"]],
    [["1", "2", "3"], ["3", "2", "1"]],
    [["1", "2", "3"], ["2", "1", "3"]],
    [["1", "2", "3"], ["3", "1", "2"]],
  ] as const;

  for (const [opens, releases] of orders) {
    const { lease, flush } = harness();
    const closed: string[] = [];

    for (const key of opens) await lease.acquire(key, () => conn(key));
    for (const key of releases) lease.release(key, (v) => closed.push(v));
    flush();
    await Promise.resolve();

    assert.deepEqual(
      [...closed].sort(),
      ["conn:1", "conn:2", "conn:3"],
      `opens ${opens.join("")} / releases ${releases.join("")} leaked a slot`,
    );
  }
});

test("a slot closed and re-acquired after the tick opens a fresh resource", async () => {
  const { lease, flush } = harness();
  const closed: string[] = [];
  let opens = 0;

  await lease.acquire("a", () => conn("a"));
  lease.release("a", (v) => closed.push(v));
  flush();
  await Promise.resolve();
  assert.deepEqual(closed, ["conn:a"]);

  // Same key, later: a new tab on the same host and spec. The old resource is
  // gone, so this has to open (and later close) its own.
  const again = lease.acquire("a", () => {
    opens += 1;
    return conn("a#2");
  });
  assert.equal(await again, "conn:a#2");
  assert.equal(opens, 1);

  lease.release("a", (v) => closed.push(v));
  flush();
  await Promise.resolve();
  assert.deepEqual(closed, ["conn:a", "conn:a#2"]);
});

test("two releases of one slot in a single tick close it once", async () => {
  // StrictMode's cleanup and the real unmount can both land before the tick.
  const { lease, flush } = harness();
  const closed: string[] = [];

  await lease.acquire("a", () => conn("a"));
  lease.release("a", (v) => closed.push(v));
  await lease.acquire("a", () => conn("a")); // remount, same slot
  lease.release("a", (v) => closed.push(v)); // unmount, second callback queued
  flush();
  await Promise.resolve();

  assert.deepEqual(closed, ["conn:a"], "the resource was closed twice");
});

test("more releases than acquires do not disarm the pending close", async () => {
  const { lease, flush } = harness();
  const closed: string[] = [];

  await lease.acquire("a", () => conn("a"));
  lease.release("a", (v) => closed.push(v));
  lease.release("a", (v) => closed.push(v)); // an extra release, as React can
  flush();
  await Promise.resolve();

  assert.deepEqual(closed, ["conn:a"], "the extra release ate the close");
});

test("a release for a key that never acquired anything is a no-op", () => {
  const { lease, flush, pending } = harness();
  lease.release("unknown", () => {
    throw new Error("closed a resource that was never opened");
  });
  assert.equal(pending(), 0, "an unrelated key was scheduled for closing");
  flush();
});

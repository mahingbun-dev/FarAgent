/**
 * `attach-lease.ts` — what keeps `TerminalView` from SIGHUP-ing ssh.
 *
 * Two things are tested here, and the second is the one that was missing:
 *
 * 1. StrictMode's immediate unmount/remount does not open a second attach.
 * 2. **A second tab does not cost the first tab its lease.** The lease used to
 *    hold one slot, so opening tab B evicted tab A's; A's `release` then matched
 *    nothing, `attach_close` was never called for A, and the Rust side has no
 *    fallback (a session is reaped when its ssh child hits EOF, which a live
 *    child never does). One leaked ssh process, PTY master, pump thread and
 *    remote tmux client per extra tab. `workspace-tabs.tsx` keeps every tab
 *    mounted, so this was reachable by opening two tabs.
 *
 * The keys are the real ones — `` `${host}\0${spec}` `` — because the shell's
 * whole problem was that they differ per tab.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttachLease } from "./attach-lease.ts";

/** The key `TerminalView` derives: host, a NUL, the serialised spec. */
function key(host: string, spec: unknown) {
  return `${host}\0${JSON.stringify(spec)}`;
}

function harness() {
  const queued: Array<() => void> = [];
  return {
    lease: createAttachLease((fn) => queued.push(fn)),
    flush: () => {
      for (const fn of queued.splice(0)) fn();
    },
  };
}

/** Session ids handed out in order, so a close can be traced to its tab. */
function sessions() {
  let next = 0;
  return () => {
    next += 1;
    return Promise.resolve(next);
  };
}

test("StrictMode acquire-release-acquire in one turn opens once and does not close", async () => {
  const { lease, flush } = harness();
  let opens = 0;
  const closes: number[] = [];
  const open = async () => {
    opens += 1;
    return 7;
  };
  const close = (id: number) => {
    closes.push(id);
  };

  const k = key("devbox", { kind: "login" });
  const first = await lease.acquire(k, open);
  lease.release(k, close); // StrictMode cleanup
  const second = await lease.acquire(k, open); // remount
  flush(); // delayed close from cleanup
  await Promise.resolve();

  assert.equal(first, 7);
  assert.equal(second, 7);
  assert.equal(opens, 1);
  assert.deepEqual(closes, []);

  lease.release(k, close); // real unmount
  flush();
  await Promise.resolve();
  assert.deepEqual(closes, [7]);
});

test("real unmount after a turn closes the attach once", async () => {
  const { lease, flush } = harness();
  const close: number[] = [];
  await lease.acquire("sess", async () => 3);
  lease.release("sess", (id) => close.push(id));
  assert.deepEqual(close, []);
  flush();
  await Promise.resolve();
  assert.deepEqual(close, [3]);
});

// ------------------------------------------------------------------ multi-tab

test("two tabs: releasing the first tab's lease closes the first tab", async () => {
  const { lease, flush } = harness();
  const open = sessions();
  const closes: number[] = [];
  const close = (id: number) => closes.push(id);

  const a = key("devbox", { kind: "login" });
  const b = key("devbox", { kind: "attach", session: "s1" });

  assert.equal(await lease.acquire(a, open), 1);
  assert.equal(await lease.acquire(b, open), 2);

  // Tab A closes. Nothing has released B, so B must stay up.
  lease.release(a, close);
  flush();
  await Promise.resolve();

  assert.deepEqual(closes, [1], "tab A's attach was leaked");
});

test("two tabs: closing both hangs up both, in either order", async () => {
  for (const order of ["ab", "ba"] as const) {
    const { lease, flush } = harness();
    const open = sessions();
    const closes: number[] = [];
    const close = (id: number) => closes.push(id);

    const keys = {
      a: key("devbox", { kind: "login" }),
      b: key("devbox", { kind: "attach", session: "s1" }),
    };
    await lease.acquire(keys.a, open);
    await lease.acquire(keys.b, open);

    for (const tab of order) lease.release(keys[tab], close);
    flush();
    await Promise.resolve();

    assert.deepEqual([...closes].sort(), [1, 2], `closing ${order}`);
  }
});

test("a StrictMode rebound on one tab does not touch another tab's lease", async () => {
  const { lease, flush } = harness();
  const open = sessions();
  const closes: number[] = [];
  const close = (id: number) => closes.push(id);

  const a = key("devbox", { kind: "login" });
  const b = key("devbox", { kind: "attach", session: "s1" });
  await lease.acquire(a, open);
  await lease.acquire(b, open);

  // Tab A's effect re-runs (a dev remount): cleanup then effect, one tick.
  lease.release(a, close);
  assert.equal(await lease.acquire(a, open), 1, "the remount re-attached");
  flush();
  await Promise.resolve();
  assert.deepEqual(closes, [], "tab A's remount lost its attach, or B's");

  lease.release(a, close);
  lease.release(b, close);
  flush();
  await Promise.resolve();
  assert.deepEqual([...closes].sort(), [1, 2]);
});

test("N tabs leak N-1 attaches: three tabs in various orders close three times", async () => {
  const orders = ["abc", "acb", "bac", "bca", "cab", "cba"] as const;

  for (const order of orders) {
    const { lease, flush } = harness();
    const open = sessions();
    const closes: number[] = [];
    const keys: Record<string, string> = {
      a: key("devbox", { kind: "login" }),
      b: key("devbox", { kind: "attach", session: "s1" }),
      c: key("devbox", { kind: "attach", session: "s2" }),
    };

    for (const tab of "abc") await lease.acquire(keys[tab], open);
    for (const tab of order) lease.release(keys[tab], (id) => closes.push(id));
    flush();
    await Promise.resolve();

    assert.deepEqual(
      [...closes].sort(),
      [1, 2, 3],
      `three tabs closed in the order ${order}`,
    );
  }
});

test("two tabs on the same host and spec share one attach, closed once", async () => {
  // The other half of the keying contract: a key is the identity of one
  // attach, so two terminals that derive the same key must not open two
  // sessions — and the last one out closes the one they share.
  const { lease, flush } = harness();
  const open = sessions();
  const closes: number[] = [];
  const close = (id: number) => closes.push(id);

  const k = key("devbox", { kind: "attach", session: "s1" });
  assert.equal(await lease.acquire(k, open), 1);
  assert.equal(await lease.acquire(k, open), 1);

  lease.release(k, close);
  flush();
  await Promise.resolve();
  assert.deepEqual(closes, [], "the second tab is still holding it");

  lease.release(k, close);
  flush();
  await Promise.resolve();
  assert.deepEqual(closes, [1]);
});

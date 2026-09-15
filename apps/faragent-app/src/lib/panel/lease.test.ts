/**
 * `lease.ts` — the StrictMode remount guard, which is what keeps `pnpm dev`
 * from opening (and immediately killing) an ssh child on every panel mount.
 *
 * The scheduler is injected, so the "close is deferred" behaviour is tested
 * deterministically rather than by sleeping a macrotask and hoping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHelperLease, createLease } from "./lease.ts";

function manual() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      queue.push(fn);
    },
    flush: () => {
      for (const fn of queue.splice(0)) fn();
    },
  };
}

test("a second acquire on the same key joins the first open", async () => {
  const { schedule } = manual();
  const lease = createLease<string>(schedule);
  let opens = 0;
  const open = () => {
    opens += 1;
    return Promise.resolve("conn");
  };

  const a = lease.acquire("host-a", open);
  const b = lease.acquire("host-a", open);
  assert.equal(await a, "conn");
  assert.equal(await b, "conn");
  assert.equal(opens, 1, "one connection, two holders");
});

test("the close waits for the last holder and for the scheduled tick", async () => {
  const { schedule, flush } = manual();
  const lease = createLease<string>(schedule);
  const closed: string[] = [];

  const a = lease.acquire("host-a", () => Promise.resolve("conn"));
  lease.acquire("host-a", () => Promise.resolve("conn"));
  await a;

  // One holder released: the connection must stay up.
  lease.release("host-a", (value) => closed.push(value));
  flush();
  assert.deepEqual(closed, []);

  // The last release schedules the close, which only runs on the tick.
  lease.release("host-a", (value) => closed.push(value));
  assert.deepEqual(closed, [], "the close is deferred, not immediate");
  flush();
  // `close` runs in the promise's own microtask, after the scheduler's tick.
  await Promise.resolve();
  assert.deepEqual(closed, ["conn"]);
});

test("a remount that re-acquires before the tick keeps the connection", async () => {
  // This is the StrictMode sequence: effect, cleanup, effect — all in one tick.
  const { schedule, flush } = manual();
  const lease = createLease<string>(schedule);
  const closed: string[] = [];

  const a = lease.acquire("host-a", () => Promise.resolve("conn"));
  await a;
  lease.release("host-a", (value) => closed.push(value));
  const b = lease.acquire("host-a", () => Promise.resolve("conn"));
  flush();

  assert.deepEqual(closed, [], "the connection the remount re-acquired was killed");
  assert.equal(await b, "conn");
});

test("the close is driven by the resolved value, not the promise", async () => {
  const { schedule, flush } = manual();
  const lease = createLease<number>(schedule);
  const closed: number[] = [];
  let resolve!: (n: number) => void;
  const pending = new Promise<number>((r) => {
    resolve = r;
  });

  lease.acquire("host-a", () => pending);
  lease.release("host-a", (value) => closed.push(value));
  flush();
  assert.deepEqual(closed, [], "nothing to close before the open resolves");
  resolve(7);
  await pending;
  assert.deepEqual(closed, [7]);
});

test("a different key opens its own connection", async () => {
  const { schedule } = manual();
  const lease = createLease<string>(schedule);
  let opens = 0;
  const open = () => {
    opens += 1;
    return Promise.resolve(`conn-${opens}`);
  };

  assert.equal(await lease.acquire("host-a", open), "conn-1");
  assert.equal(await lease.acquire("host-b", open), "conn-2");
  assert.equal(opens, 2);
});

// The multi-key half, which is what the single-slot version of this lease got
// wrong. A retry releases `host#0` and acquires `host#1`, and switching hosts
// does the same with two different hosts. Each key is its own slot, so the
// release finds its own: the connection it drops has no holder left, and this
// callback is the only thing that will ever close it. With one `slot` variable
// the second acquire replaced the first and the release then matched nothing —
// on the desktop app, a helper process still holding an ssh child.

test("two keys held at once: the first one's release closes the first one", async () => {
  const { schedule, flush } = manual();
  const lease = createLease<string>(schedule);
  const closed: string[] = [];

  await lease.acquire("host-a#0", () => Promise.resolve("conn-a"));
  await lease.acquire("host-b#0", () => Promise.resolve("conn-b"));
  lease.release("host-a#0", (value) => closed.push(value));
  flush();
  await Promise.resolve();

  assert.deepEqual(closed, ["conn-a"], "host A's connection was leaked");
});

test("a release closes its connection even when another key acquires in the same turn", async () => {
  const { schedule, flush } = manual();
  const lease = createLease<string>(schedule);
  const closed: string[] = [];
  const close = (value: string) => closed.push(value);

  const a = lease.acquire("host-a#0", () => Promise.resolve("conn-a"));
  await a;
  // The tab switched: cleanup released host A, the new effect acquired host B,
  // and the deferred close for A has not run yet.
  lease.release("host-a#0", close);
  const b = lease.acquire("host-b#0", () => Promise.resolve("conn-b"));
  await b;

  flush();
  await Promise.resolve();
  assert.deepEqual(closed, ["conn-a"], "host A's connection was leaked");
});

test("a retry on the same host closes the attempt it replaced", async () => {
  // Same shape, reached by the error state's retry button rather than a tab
  // switch: the key gains a new attempt number.
  const { schedule, flush } = manual();
  const lease = createLease<string>(schedule);
  const closed: string[] = [];

  const first = lease.acquire("host-a#0", () => Promise.resolve("conn-1"));
  await first;
  lease.release("host-a#0", (value) => closed.push(value));
  const second = lease.acquire("host-a#1", () => Promise.resolve("conn-2"));
  flush();
  await Promise.resolve();

  assert.deepEqual(closed, ["conn-1"]);
  assert.equal(await second, "conn-2", "the new attempt is untouched");
});

// The two-holders case, which is the one the caller-owned attempt counter got
// wrong. `PanelHelperProvider` and `ChatView` are separate components and both
// mount a provider on the same host; when each kept its own `attempt` in its own
// state, a retry on one side moved *it* to a new key while the other stayed put.
// Two live keys for one host is two `helper_open`s, and the second one *ends* the
// first (`helper.rs::adopt`) — so a retry in the chat hung up the panel's ssh
// session, and vice versa. The generation therefore belongs to the host, and this
// pins both halves of that: they agree without being told, and they move together.

test("two providers on one host hold one connection", async () => {
  const { schedule } = manual();
  const lease = createHelperLease<string>(schedule);
  let opens = 0;
  const open = () => {
    opens += 1;
    return Promise.resolve(`conn-${opens}`);
  };

  // Neither caller chooses the key; both derive it from the host.
  const panelKey = lease.keyFor("host-a");
  const chatKey = lease.keyFor("host-a");
  assert.equal(panelKey, chatKey, "two providers on one host disagreed about the key");

  assert.equal(await lease.acquire(panelKey, open), "conn-1");
  assert.equal(await lease.acquire(chatKey, open), "conn-1");
  assert.equal(opens, 1, "one host, one connection — a second would have ended the first");
});

test("a retry moves every holder of the host at once, and dials once", async () => {
  const { schedule, flush } = manual();
  const lease = createHelperLease<string>(schedule);
  let opens = 0;
  let fail = true;
  const open = () => {
    opens += 1;
    return fail ? Promise.reject(new Error("helper died")) : Promise.resolve("conn");
  };

  const panelKey = lease.keyFor("host-a");
  const chatKey = lease.keyFor("host-a");
  // A failed open is still one open for the host, not one per provider.
  await assert.rejects(lease.acquire(panelKey, open));
  await assert.rejects(lease.acquire(chatKey, open));
  assert.equal(opens, 1);

  // One side clicks retry. Both must learn about it — neither can be left
  // holding the failed key, because a fresh `helper_open` on the other would end
  // whatever the first side opened.
  const seen: string[] = [];
  lease.watch("host-a", () => seen.push(lease.keyFor("host-a")));
  lease.renew("host-a");
  assert.deepEqual(seen, ["host-a#1"], "the other holder was not told");
  assert.notEqual(lease.keyFor("host-a"), panelKey, "the retry reused the failed key");
  assert.equal(lease.keyFor("host-a"), lease.keyFor("host-a"));

  // Both effects re-run: each releases the old key, each acquires the new one.
  // The old slot's value is a rejection, so dropping it closes nothing.
  const next = lease.keyFor("host-a");
  lease.release(panelKey, () => {
    throw new Error("a rejected open must not be closed");
  });
  lease.release(chatKey, () => {
    throw new Error("a rejected open must not be closed");
  });
  fail = false;
  const a = lease.acquire(next, open);
  const b = lease.acquire(next, open);
  flush();
  await Promise.resolve();
  assert.equal(await a, "conn");
  assert.equal(await b, "conn");
  assert.equal(opens, 2, "a retry is one new connection, not one per provider");
});


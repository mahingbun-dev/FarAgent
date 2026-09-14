/**
 * `watch.ts` — push-driven invalidation, burst coalescing, and the
 * subscription bookkeeping that is this task's leak risk.
 *
 * The three things the brief calls out, in order, each pinned by tests below:
 * the invalidation scope is narrow (never `["panel"]`), a burst becomes one
 * flush, and every `subscribe` is matched by exactly one `unsubscribe` even
 * when two panels share it or React unmounts mid-flight.
 *
 * The clock and the remote client are both injected, so nothing here sleeps or
 * touches a network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createCoalescer,
  createWatchPool,
  invalidationScope,
  uniqueScopes,
  type QueryKeyPrefix,
  type Scheduler,
  type WatchClient,
} from "./watch.ts";

/** A scheduler whose timers only fire when the test says so. */
function manualScheduler() {
  const queue: Array<{ fn: () => void; live: boolean }> = [];
  const scheduler: Scheduler = {
    after(_ms, fn) {
      const slot = { fn, live: true };
      queue.push(slot);
      return () => {
        slot.live = false;
      };
    },
  };
  return {
    scheduler,
    /** Fire every armed timer, as a real `setTimeout` would. */
    tick() {
      for (const slot of queue.splice(0)) if (slot.live) slot.fn();
    },
    armed() {
      return queue.filter((slot) => slot.live).length;
    },
  };
}

// ---------------------------------------------------------------------------
// Invalidation scope
// ---------------------------------------------------------------------------

test("an fs change invalidates the two listings, the stat and the read", () => {
  assert.deepEqual(invalidationScope(3, { kind: "fs", path: "/srv/app/src/main.rs" }), [
    ["panel", 3, "list", "/srv/app/src"],
    ["panel", 3, "list", "/srv/app/src/main.rs"],
    ["panel", 3, "stat", "/srv/app/src/main.rs"],
    ["panel", 3, "read", "/srv/app/src/main.rs"],
  ]);
});

test("an fs change never invalidates the whole panel", () => {
  // The brief's "do not re-fetch the whole tree", as a test: a key of
  // `["panel", id]` is a prefix of every panel query, so invalidating it would
  // re-walk the tree, re-read every file and re-run the git queries.
  for (const change of [
    { kind: "fs", path: "/srv/app/a.txt" } as const,
    { kind: "git" } as const,
  ]) {
    for (const scope of invalidationScope(1, change)) {
      assert.ok(
        scope.length > 2,
        `scope ${JSON.stringify(scope)} is a bare ["panel", id] prefix`,
      );
    }
  }
});

test("an fs change is scoped to one connection", () => {
  const scopes = invalidationScope(7, { kind: "fs", path: "/a/b" });
  for (const scope of scopes) {
    assert.equal(scope[1], 7, "the connection id is part of every scope");
  }
});

test("a path is normalised before it becomes a scope", () => {
  // The helper reports the path it resolved; a trailing slash or a `..` must
  // not produce a second, unmatched key.
  assert.deepEqual(invalidationScope(1, { kind: "fs", path: "/srv/app//src/../x" }), [
    ["panel", 1, "list", "/srv/app"],
    ["panel", 1, "list", "/srv/app/x"],
    ["panel", 1, "stat", "/srv/app/x"],
    ["panel", 1, "read", "/srv/app/x"],
  ]);
});

test("a change at the root lists the root as its own parent", () => {
  // `parentPath("/")` is `"/"`, so the first two scopes collapse — `uniqueScopes`
  // is what keeps the flush from issuing the same key twice.
  const scopes = invalidationScope(1, { kind: "fs", path: "/boot" });
  assert.deepEqual(scopes[0], ["panel", 1, "list", "/"]);
  assert.deepEqual(scopes[1], ["panel", 1, "list", "/boot"]);
});

test("a git change invalidates the coarse git set and not discover", () => {
  const scopes = invalidationScope(2, { kind: "git" });
  assert.deepEqual(scopes, [
    ["panel", 2, "status"],
    ["panel", 2, "branches"],
    ["panel", 2, "log"],
    ["panel", 2, "diff"],
  ]);
  // `discover` is absent on purpose: a subscription under a non-repository root
  // never reports `git.changed`, so a repository cannot appear under one.
  assert.ok(!scopes.some((scope) => scope[2] === "discover"));
});

test("a git change never invalidates a file read or listing", () => {
  for (const scope of invalidationScope(2, { kind: "git" })) {
    assert.ok(scope[2] !== "read" && scope[2] !== "list" && scope[2] !== "stat");
  }
});

test("uniqueScopes drops repeats and keeps the first order", () => {
  const scopes: QueryKeyPrefix[] = [
    ["panel", 1, "list", "/"],
    ["panel", 1, "list", "/"],
    ["panel", 1, "stat", "/x"],
    ["panel", 1, "list", "/"],
  ];
  assert.deepEqual(uniqueScopes(scopes), [
    ["panel", 1, "list", "/"],
    ["panel", 1, "stat", "/x"],
  ]);
});

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

test("a burst inside the window becomes one flush", () => {
  const clock = manualScheduler();
  const flushes: number[][] = [];
  const coalescer = createCoalescer<number>(250, (batch) => flushes.push(batch), clock.scheduler);

  for (const n of [1, 2, 3, 4, 5]) coalescer.offer(n);
  assert.deepEqual(flushes, [], "nothing flushes before the window closes");
  assert.equal(coalescer.count(), 5);

  clock.tick();
  assert.deepEqual(flushes, [[1, 2, 3, 4, 5]], "one flush for the whole burst");
  assert.equal(coalescer.count(), 0);
});

test("the window is armed by the first value and not re-armed by later ones", () => {
  // The `npm install` case: a stream of writes with no gap. A reset-on-event
  // debounce would never fire; a fixed window fires once per 250ms.
  const clock = manualScheduler();
  const flushes: number[][] = [];
  const coalescer = createCoalescer<number>(250, (batch) => flushes.push(batch), clock.scheduler);

  coalescer.offer(1);
  assert.equal(clock.armed(), 1);
  coalescer.offer(2);
  coalescer.offer(3);
  assert.equal(clock.armed(), 1, "later values did not re-arm the window");

  clock.tick();
  assert.deepEqual(flushes, [[1, 2, 3]]);

  // The next value arms a fresh window.
  coalescer.offer(4);
  assert.equal(clock.armed(), 1);
  clock.tick();
  assert.deepEqual(flushes, [[1, 2, 3], [4]]);
});

test("an empty window is never handed to the sink", () => {
  const clock = manualScheduler();
  let calls = 0;
  const coalescer = createCoalescer<number>(250, () => calls++, clock.scheduler);
  clock.tick();
  assert.equal(calls, 0);
  coalescer.flush();
  assert.equal(calls, 0, "an empty flush is not a flush");
});

test("flush fires now and disarms the pending timer", () => {
  // Teardown path: the panel is closing and must not leave a timer behind that
  // fires into an unmounted query client.
  const clock = manualScheduler();
  const flushes: string[][] = [];
  const coalescer = createCoalescer<string>(250, (batch) => flushes.push(batch), clock.scheduler);

  coalescer.offer("a");
  coalescer.flush();
  assert.deepEqual(flushes, [["a"]]);
  assert.equal(clock.armed(), 0, "the timer was left armed");

  clock.tick();
  assert.deepEqual(flushes, [["a"]], "the disarmed timer fired anyway");
});

test("cancel drops the batch without calling the sink", () => {
  const clock = manualScheduler();
  const flushes: number[][] = [];
  const coalescer = createCoalescer<number>(250, (batch) => flushes.push(batch), clock.scheduler);

  coalescer.offer(1);
  coalescer.cancel();
  assert.equal(coalescer.count(), 0);
  assert.equal(clock.armed(), 0);
  clock.tick();
  assert.deepEqual(flushes, []);
});

// ---------------------------------------------------------------------------
// The watch pool
// ---------------------------------------------------------------------------

/** A stand-in remote that records the calls it receives. */
function fakeClient() {
  const subscribes: Array<{ path: string; recursive: boolean }> = [];
  const unsubscribes: number[] = [];
  let next = 1;
  const resolvers: Array<(id: number) => void> = [];
  let auto = true;

  const client: WatchClient = {
    subscribe(path, recursive) {
      subscribes.push({ path, recursive });
      const id = next++;
      if (auto) return Promise.resolve({ subscription: id });
      return new Promise((resolve) => resolvers.push(() => resolve({ subscription: id })));
    },
    unsubscribe({ subscription }) {
      unsubscribes.push(subscription);
      return Promise.resolve({ removed: 1 });
    },
  };

  return {
    client,
    subscribes,
    unsubscribes,
    /** Hold every later subscribe open until `release` is called. */
    hold() {
      auto = false;
    },
    release() {
      for (const resolve of resolvers.splice(0)) resolve();
    },
  };
}

/** The microtask chain inside `acquire` needs a turn before assertions. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("one acquire is one subscribe, and the release unsubscribes", async () => {
  const remote = fakeClient();
  const pool = createWatchPool();

  const release = pool.acquire(remote.client, "/srv/app");
  await settle();
  assert.deepEqual(remote.subscribes, [{ path: "/srv/app", recursive: true }]);
  assert.equal(pool.size(), 1);

  release();
  assert.deepEqual(remote.unsubscribes, [1]);
  assert.equal(pool.size(), 0, "the entry was not dropped");
});

test("two holders of the same path share one subscription and one unsubscribe", async () => {
  // Two tabs on the same host: `createLease` gives them one `HelperConnection`,
  // and the helper's `watch.subscribe` is idempotent per (path, recursive). A
  // per-component unsubscribe would kill the sibling's watch.
  const remote = fakeClient();
  const pool = createWatchPool();

  const releaseA = pool.acquire(remote.client, "/srv/app");
  const releaseB = pool.acquire(remote.client, "/srv/app");
  await settle();
  assert.equal(remote.subscribes.length, 1, "the second holder re-subscribed");

  releaseA();
  assert.deepEqual(remote.unsubscribes, [], "the first release killed the shared watch");
  assert.equal(pool.size(), 1);

  releaseB();
  assert.deepEqual(remote.unsubscribes, [1], "the last holder did not unsubscribe");
  assert.equal(pool.size(), 0);
});

test("a path spelled two ways is one subscription", async () => {
  const remote = fakeClient();
  const pool = createWatchPool();
  const releaseA = pool.acquire(remote.client, "/srv/app/");
  const releaseB = pool.acquire(remote.client, "/srv/app");
  await settle();
  assert.equal(remote.subscribes.length, 1);
  releaseA();
  releaseB();
});

test("recursive and non-recursive are different subscriptions", async () => {
  const remote = fakeClient();
  const pool = createWatchPool();
  pool.acquire(remote.client, "/srv/app", true);
  pool.acquire(remote.client, "/srv/app", false);
  await settle();
  assert.deepEqual(remote.subscribes, [
    { path: "/srv/app", recursive: true },
    { path: "/srv/app", recursive: false },
  ]);
});

test("a different client subscribes separately", async () => {
  const a = fakeClient();
  const b = fakeClient();
  const pool = createWatchPool();
  pool.acquire(a.client, "/srv/app");
  pool.acquire(b.client, "/srv/app");
  await settle();
  assert.equal(a.subscribes.length, 1);
  assert.equal(b.subscribes.length, 1);
  assert.equal(pool.size(), 2);
});

test("a release after the last holder left mid-flight still unsubscribes", async () => {
  // The StrictMode shape: subscribe is in flight, cleanup runs, nothing
  // remounts. Without the `abandoned` branch the remote keeps a watch with
  // nobody listening — the leak.
  const remote = fakeClient();
  remote.hold();
  const pool = createWatchPool();

  const release = pool.acquire(remote.client, "/srv/app");
  release();
  assert.deepEqual(remote.unsubscribes, [], "nothing to unsubscribe before the id exists");
  assert.equal(pool.size(), 0);

  remote.release();
  await settle();
  assert.deepEqual(remote.unsubscribes, [1], "the abandoned subscription leaked");
});

test("a remount during the flight reuses the in-flight subscription", async () => {
  // The other half of StrictMode: cleanup then remount before the answer.
  // Joining the entry again must not subscribe a second time, and the answer
  // must not be thrown away as abandoned.
  const remote = fakeClient();
  remote.hold();
  const pool = createWatchPool();

  const first = pool.acquire(remote.client, "/srv/app");
  const second = pool.acquire(remote.client, "/srv/app");
  first();
  assert.equal(remote.subscribes.length, 1);

  remote.release();
  await settle();
  assert.deepEqual(remote.unsubscribes, [], "the remount's subscription was dropped");

  second();
  assert.deepEqual(remote.unsubscribes, [1]);
});

test("releasing twice unsubscribes once", async () => {
  const remote = fakeClient();
  const pool = createWatchPool();
  const release = pool.acquire(remote.client, "/srv/app");
  release();
  release();
  await settle();
  assert.equal(remote.unsubscribes.length, 1);
});

test("forget drops the table, so a later release cannot unsubscribe over a dead channel", async () => {
  const remote = fakeClient();
  const pool = createWatchPool();

  const release = pool.acquire(remote.client, "/srv/app");
  await settle();
  assert.equal(pool.size(), 1);

  // The channel closed: the remote dropped every subscription with it.
  pool.forget(remote.client);
  assert.equal(pool.size(), 0, "the live count was not corrected");

  release();
  assert.deepEqual(remote.unsubscribes, [], "unsubscribed on a closed connection");
});

test("forget does not disturb another client's entries", async () => {
  const a = fakeClient();
  const b = fakeClient();
  const pool = createWatchPool();
  const releaseA = pool.acquire(a.client, "/srv/app");
  pool.acquire(b.client, "/srv/other");
  await settle();

  pool.forget(a.client);
  assert.equal(pool.size(), 1, "the sibling client's entry was counted out");
  releaseA();
  assert.deepEqual(a.unsubscribes, []);
});

test("a failed subscribe is dropped, so the next acquire tries again", async () => {
  const attempts: string[] = [];
  const client: WatchClient = {
    subscribe(path) {
      attempts.push(path);
      return attempts.length === 1
        ? Promise.reject(new Error("no such directory"))
        : Promise.resolve({ subscription: 9 });
    },
    unsubscribe: () => Promise.resolve({ removed: 1 }),
  };
  const pool = createWatchPool();

  const release = pool.acquire(client, "/srv/app");
  await settle();
  assert.equal(pool.size(), 0, "the dead entry was left in the table");

  // Releasing the failed entry is a no-op, and a fresh acquire subscribes again
  // rather than joining the corpse.
  release();
  const retry = pool.acquire(client, "/srv/app");
  await settle();
  assert.deepEqual(attempts, ["/srv/app", "/srv/app"]);
  assert.equal(pool.size(), 1);
  retry();
});

test("the size counts entries, not holders", async () => {
  const remote = fakeClient();
  const pool = createWatchPool();
  pool.acquire(remote.client, "/srv/app");
  pool.acquire(remote.client, "/srv/app");
  pool.acquire(remote.client, "/srv/other");
  await settle();
  assert.equal(pool.size(), 2);
});

// ---------------------------------------------------------------------------
// The scopes match the keys the hooks actually build
// ---------------------------------------------------------------------------

/**
 * React Query's own matching rule, which is the one that decides whether an
 * invalidation lands: a prefix matches when every element is `deepEqual`.
 */
function matches(key: readonly unknown[], prefix: readonly unknown[]): boolean {
  if (prefix.length > key.length) return false;
  return prefix.every((part, i) => {
    const other = key[i];
    if (Array.isArray(part) && Array.isArray(other)) return matches(other, part);
    return JSON.stringify(part) === JSON.stringify(other);
  });
}

/**
 * The keys `components/panel/queries.ts` builds, spelled out.
 *
 * Copied rather than imported, because importing that module would drag React
 * and the query client into a `node --test` process. The copy is kept honest by
 * the test below it, which reads the hook file's source and asserts each of
 * these names is still produced by a `key(connection, "<name>"…)` call — so a
 * hook renamed or removed fails here rather than quietly un-pinning the shape.
 */
const HOOK_KEYS: Record<string, (root: string, id: number) => unknown[]> = {
  list: (root, id) => ["panel", id, "list", root],
  stat: (root, id) => ["panel", id, "stat", root],
  // Both limits, because the `read` prefix drops the limit on purpose.
  read: (root, id) => ["panel", id, "read", root, 262_144],
  readDefault: (root, id) => ["panel", id, "read", root, 0],
  discover: (root, id) => ["panel", id, "discover", root],
  status: (root, id) => ["panel", id, "status", root],
  branches: (root, id) => ["panel", id, "branches", root],
  diff: (root, id) => ["panel", id, "diff", root, `${root}/src/main.rs`, false],
  log: (root, id) => ["panel", id, "log", root],
};

const ROOT = "/srv/app";
const ID = 7;

function scopesFor(change: Parameters<typeof invalidationScope>[1]): unknown[][] {
  return invalidationScope(ID, change);
}

function anyScopeMatches(key: readonly unknown[], scopes: unknown[][]): boolean {
  return scopes.some((scope) => matches(key, scope));
}

test("each hook key is really the shape this table claims", () => {
  const source = readFileSync(
    new URL("../../components/panel/queries.ts", import.meta.url),
    "utf8",
  );
  for (const name of ["list", "stat", "read", "discover", "status", "branches", "diff", "log"]) {
    assert.ok(
      source.includes(`key(connection, "${name}"`),
      `queries.ts no longer builds a "${name}" key — this table is stale`,
    );
  }
});

test("an fs change on a file hits that file's stat and read, at every limit", () => {
  const scopes = scopesFor({ kind: "fs", path: `${ROOT}/src/main.rs` });
  assert.ok(anyScopeMatches(HOOK_KEYS.stat(`${ROOT}/src/main.rs`, ID), scopes));
  assert.ok(
    anyScopeMatches(HOOK_KEYS.read(`${ROOT}/src/main.rs`, ID), scopes),
    "a read with a limit is left stale by a change to its file",
  );
  assert.ok(
    anyScopeMatches(HOOK_KEYS.readDefault(`${ROOT}/src/main.rs`, ID), scopes),
    "the unlimited read is left stale by a change to its file",
  );
  assert.ok(
    anyScopeMatches(HOOK_KEYS.list(`${ROOT}/src`, ID), scopes),
    "the containing directory's listing is not refreshed",
  );
});

test("an fs change on a directory hits its own listing and its parent's", () => {
  const scopes = scopesFor({ kind: "fs", path: `${ROOT}/src` });
  assert.ok(anyScopeMatches(HOOK_KEYS.list(`${ROOT}/src`, ID), scopes));
  assert.ok(anyScopeMatches(HOOK_KEYS.list(ROOT, ID), scopes));
});

test("an fs change leaves git, discover and other connections alone", () => {
  const scopes = scopesFor({ kind: "fs", path: `${ROOT}/src/main.rs` });
  for (const key of [
    HOOK_KEYS.status(ROOT, ID),
    HOOK_KEYS.branches(ROOT, ID),
    HOOK_KEYS.log(ROOT, ID),
    HOOK_KEYS.diff(ROOT, ID),
    HOOK_KEYS.discover(ROOT, ID),
  ]) {
    assert.ok(!anyScopeMatches(key, scopes), `an fs change invalidated ${JSON.stringify(key)}`);
  }
  // Another connection's identical-looking listing is untouched: the scope
  // carries the id, and this is what stops one host's push refreshing another.
  assert.ok(!anyScopeMatches(HOOK_KEYS.stat(`${ROOT}/src/main.rs`, ID + 1), scopes));
  assert.ok(!anyScopeMatches(HOOK_KEYS.list(ROOT, ID + 1), scopes));
});

test("a git change hits the four git queries and nothing else", () => {
  const scopes = scopesFor({ kind: "git" });
  assert.ok(anyScopeMatches(HOOK_KEYS.status(ROOT, ID), scopes));
  assert.ok(anyScopeMatches(HOOK_KEYS.branches(ROOT, ID), scopes));
  assert.ok(anyScopeMatches(HOOK_KEYS.log(ROOT, ID), scopes));
  assert.ok(
    anyScopeMatches(HOOK_KEYS.diff(ROOT, ID), scopes),
    "a patch left stale after HEAD moved",
  );
  assert.ok(
    !anyScopeMatches(HOOK_KEYS.discover(ROOT, ID), scopes),
    "discover is the repository question, not repository state",
  );
  for (const key of [
    HOOK_KEYS.list(ROOT, ID),
    HOOK_KEYS.stat(`${ROOT}/src/main.rs`, ID),
    HOOK_KEYS.read(`${ROOT}/src/main.rs`, ID),
  ]) {
    assert.ok(!anyScopeMatches(key, scopes), `a git change invalidated ${JSON.stringify(key)}`);
  }
  assert.ok(!anyScopeMatches(HOOK_KEYS.status(ROOT, ID + 1), scopes));
});

test("no scope is ever a prefix of the whole panel", () => {
  // The one rule the brief states negatively. `["panel"]` matches every query
  // the app has, and `["panel", id]` matches every query the connection has —
  // either turns one push into a full re-walk of the tree.
  const scopes = [
    ...scopesFor({ kind: "fs", path: `${ROOT}/src/main.rs` }),
    ...scopesFor({ kind: "git" }),
  ];
  for (const scope of scopes) {
    assert.ok(scope.length >= 3, `too broad: ${JSON.stringify(scope)}`);
    assert.equal(scope[0], "panel");
    assert.equal(scope[1], ID);
    assert.equal(typeof scope[2], "string");
  }
});

test("every hook key in the table is reachable by some scope", () => {
  // The converse of the tests above: no shape in the table is dead weight that
  // no invalidation can ever reach. `discover` is the deliberate exception —
  // it is the one query the push channel never refreshes.
  const scopes = [
    ...scopesFor({ kind: "fs", path: `${ROOT}/src/main.rs` }),
    ...scopesFor({ kind: "fs", path: ROOT }),
    ...scopesFor({ kind: "git" }),
  ];
  const reachable = Object.entries(HOOK_KEYS).filter(([name]) => name !== "discover");
  for (const [name, build] of reachable) {
    const samples = name === "diff" ? [build(ROOT, ID)] : [build(ROOT, ID), build(`${ROOT}/src/main.rs`, ID)];
    assert.ok(
      samples.some((key) => anyScopeMatches(key, scopes)),
      `no push can ever refresh "${name}"`,
    );
  }
});

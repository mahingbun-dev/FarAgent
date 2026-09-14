/**
 * `persist.ts` — which of the panel's queries may be written to the disk cache,
 * and what happens to them when they come back.
 *
 * The brief's rule for this feature is one sentence — "must not cache remote
 * credentials, passwords, API keys and the like" — and the way to be sure of it
 * is an allowlist that is tested against the keys the panel actually uses plus
 * the ones it does not, rather than a denylist that has to anticipate every
 * name a later task might choose.
 *
 * The other half is staleness: a restored entry is a picture of a directory
 * that may since have changed, so the age rule and the "restore is not fresh"
 * contract are pinned here too.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeCacheValue } from "./cache.ts";
import { panelKey } from "./keys.ts";
import {
  bucketFrom,
  bucketToSave,
  collectEntries,
  loadFor,
  persistableKey,
  restoreEntries,
  PERSIST_MAX_AGE_MS,
  PERSISTED_QUERIES,
} from "./persist.ts";

const NOW = 1_700_000_000_000;
const fresh = {
  key: panelKey(4, "stat", "/srv"),
  data: { ok: true },
  updatedAt: NOW,
};

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

test("the allowlist is exactly these names", () => {
  // Spelled out rather than compared against `PANEL_QUERIES`, which is the
  // point of an allowlist: adding a query to the panel must NOT persist it by
  // itself. A new name here is a decision someone wrote down.
  assert.deepEqual([...PERSISTED_QUERIES], [
    "list",
    "stat",
    "read",
    "discover",
    "status",
    "branches",
    "log",
    "diff",
  ]);
});

test("the panel's own keys are persistable", () => {
  for (const name of PERSISTED_QUERIES) {
    assert.equal(
      persistableKey(panelKey(4, name, "/srv/app"), 4),
      true,
      `${name} is not persistable`,
    );
  }
});

test("a query for another connection is never persistable", () => {
  assert.equal(persistableKey(panelKey(4, "read", "/srv/app/x"), 5), false);
  assert.equal(persistableKey(panelKey(0, "list", "/"), 4), false);
});

test("a key outside the panel namespace is never persistable", () => {
  for (const key of [
    ["hosts"],
    ["sessions", "build-01", "claude", "posix"],
    ["probe", "build-01"],
    ["attach", 1],
  ]) {
    assert.equal(persistableKey(key, 4), false, JSON.stringify(key));
  }
});

test("anything naming a credential is refused even under a persisted name", () => {
  // Belt and braces: `cache.ts`'s own guard also refuses these, and both are
  // asserted, because either one alone would be a single point of failure for
  // the one rule in this feature that cannot be walked back.
  for (const path of [
    "/home/u/.ssh/id_rsa",
    "/home/u/.ssh/config",
    "/home/u/.config/gh/hosts.yml",
    "/etc/shadow",
  ]) {
    assert.equal(
      persistableKey(panelKey(4, "read", path), 4),
      false,
      `${path} was persistable`,
    );
  }
  // The guard is a substring match over the whole key, so it is deliberately
  // over-eager: a source file *named* `auth.ts` is refused, because "auth" is a
  // word the guard cannot afford to be clever about. Refusing a file that was
  // safe is a cache miss; the other direction is a private key on disk. The
  // ordinary case still works, which is what keeps the over-eagerness from
  // being a functional problem.
  assert.equal(persistableKey(panelKey(4, "read", "/srv/app/auth.ts"), 4), false);
  assert.equal(persistableKey(panelKey(4, "read", "/srv/app/main.ts"), 4), true);
});

test("a malformed key is refused rather than indexed into", () => {
  for (const key of [[], ["panel"], ["panel", 4], ["panel", "4", "read", "/x"]]) {
    assert.equal(persistableKey(key, 4), false, JSON.stringify(key));
  }
});

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

test("only this connection's queries are collected", () => {
  const queries = [
    { key: panelKey(4, "read", "/srv/app/a"), data: { a: 1 }, updatedAt: NOW },
    { key: panelKey(5, "read", "/srv/other/b"), data: { b: 2 }, updatedAt: NOW },
  ];
  const entries = collectEntries(4, queries, NOW);
  assert.equal(Object.keys(entries).length, 1);
  assert.ok(JSON.stringify(panelKey(4, "read", "/srv/app/a")) in entries);
});

test("a query with no data is not collected", () => {
  // `data === undefined` is a query that is loading or errored; writing it as
  // `null` would restore a null and skip the fetch.
  const entries = collectEntries(
    4,
    [
      { key: panelKey(4, "read", "/a"), data: undefined, updatedAt: NOW },
      { key: panelKey(4, "read", "/b"), data: undefined, updatedAt: NOW },
    ],
    NOW,
  );
  assert.deepEqual(entries, {});
});

test("an entry older than the age limit is dropped", () => {
  const old = { key: panelKey(4, "list", "/srv"), data: { n: 1 }, updatedAt: NOW - PERSIST_MAX_AGE_MS - 1 };
  const edge = { key: panelKey(4, "list", "/srv/x"), data: { n: 2 }, updatedAt: NOW - PERSIST_MAX_AGE_MS };
  const entries = collectEntries(4, [old, edge, fresh], NOW);
  assert.equal(Object.keys(entries).length, 2, "the out-of-date entry survived");
  assert.ok(!(JSON.stringify(old.key) in entries));
  assert.ok(JSON.stringify(edge.key) in entries, "the boundary is inclusive");
});

test("an entry with no timestamp is treated as old", () => {
  // React Query uses `dataUpdatedAt === 0` for "never fetched"; a zero here
  // would otherwise be 1970 and pass an age check written as `now - t < max`.
  for (const updatedAt of [0, -1]) {
    const entries = collectEntries(
      4,
      [{ key: panelKey(4, "read", "/a"), data: { n: 1 }, updatedAt }],
      NOW,
    );
    assert.deepEqual(entries, {}, `updatedAt ${updatedAt} was collected`);
  }
});

test("bytes survive collection and restoration", () => {
  const data = { entries: [{ name: new Uint8Array([0x61, 0xc3, 0x28]), kind: "file" }] };
  const entries = collectEntries(
    4,
    [{ key: panelKey(4, "list", "/srv"), data, updatedAt: NOW }],
    NOW,
  );
  const bucket = { host: "build-01", id: 4, entries };
  const restored = restoreEntries(bucket, 4);
  assert.equal(restored.length, 1);
  const back = restored[0].data as { entries: Array<{ name: Uint8Array; kind: string }> };
  assert.ok(back.entries[0].name instanceof Uint8Array, "bytes came back as an object of indices");
  assert.deepEqual(Array.from(back.entries[0].name), [0x61, 0xc3, 0x28]);
  assert.equal(back.entries[0].kind, "file");
});

test("bucketFrom labels the bucket with the connection that filled it", () => {
  const bucket = bucketFrom("gpu-box", 7, [freshQuery(7)], NOW);
  assert.equal(bucket.host, "gpu-box");
  assert.equal(bucket.id, 7);
  assert.equal(Object.keys(bucket.entries).length, 1);
});

test("an empty snapshot is not written at all", () => {
  // A bucket with no entries happens exactly when the panel is torn down before
  // it has fetched anything — a StrictMode double mount, a hot reload, a panel
  // closed the instant it opened. There is one bucket key, so writing it then
  // wipes the previous run's cache at the worst possible moment: on the way in,
  // before the read side has restored from it. Found by running the feature:
  // a hot reload during verification emptied the bucket and hydration stopped
  // working, with every unit test still green.
  const empty = [
    { key: panelKey(4, "read", "/a"), data: undefined, updatedAt: NOW },
    { key: ["hosts"], data: { ok: true }, updatedAt: NOW },
    { key: panelKey(4, "read", "/b"), data: { n: 1 }, updatedAt: 0 },
    { key: panelKey(4, "read", "/c"), data: { n: 1 }, updatedAt: NOW - PERSIST_MAX_AGE_MS - 1 },
  ];
  assert.equal(bucketToSave("build-01", 4, empty, NOW), null);

  // Nothing at all is the same answer.
  assert.equal(bucketToSave("build-01", 4, [], NOW), null);

  // And one real entry is enough to be worth writing.
  const worth = bucketToSave("build-01", 4, [freshQuery(4)], NOW);
  assert.notEqual(worth, null);
  assert.equal(Object.keys(worth?.entries ?? {}).length, 1);
});

function freshQuery(id: number) {
  return { key: panelKey(id, "read", "/srv/app/x"), data: { ok: true }, updatedAt: NOW };
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

test("nothing, and an empty bucket, restore nothing", () => {
  assert.deepEqual(restoreEntries(null, 4), []);
  assert.deepEqual(restoreEntries({ host: "build-01", id: 4, entries: {} }, 4), []);
});

test("the keys are rewritten onto the connection that is live now", () => {
  // The bug this pins, found by running the feature rather than by reading it:
  // a stored key embeds the id of the run that wrote it, and ids are a per-run
  // counter — the same host is connection 3 in one run and connection 1 in the
  // next. Restoring the key verbatim puts the data under a key no hook will
  // ever ask for: the hydration "succeeds" and nothing ever reads it, so the
  // disk cache does nothing at all while every unit test passes. Element 1 is
  // therefore replaced with the live id, and the rest of the key is kept.
  const written = bucketFrom("build-01", 3, [freshQuery(3)], NOW);
  const restored = restoreEntries(written, 1);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].key, panelKey(1, "read", "/srv/app/x"));
  assert.ok(
    !JSON.stringify(restored[0].key).includes('"3"'),
    "the previous run's id is still in the key",
  );
});

test("a corrupt entry is dropped without losing the rest", () => {
  const good = bucketFrom("build-01", 4, [freshQuery(4)], NOW);
  const bent = {
    ...good,
    entries: {
      ...good.entries,
      "not json": "{}",
      '{"no":"panel"}': encodeCacheValue({ nope: 1 }),
      "[]": "{}",
      "[null,null,null]": "{}",
      '[1,"read","/x"]': "{}",
      [JSON.stringify(panelKey(4, "read", "/srv/app/bad"))]: "{{{ not json",
    },
  };
  const restored = restoreEntries(bent, 4);
  assert.equal(restored.length, 1, "one good entry, six bad ones");
  assert.deepEqual(restored[0].key, panelKey(4, "read", "/srv/app/x"));
});

test("a file removed from the allowlist does not come back from an old bucket", () => {
  // The forward-compatibility case: an entry written by an older build with a
  // wider allowlist must not be restored by a build that has narrowed it.
  const bucket = {
    host: "build-01",
    id: 4,
    entries: { [JSON.stringify(panelKey(4, "transcript", "/srv/app"))]: encodeCacheValue({ t: 1 }) },
  };
  assert.deepEqual(restoreEntries(bucket, 4), []);
});

test("loadFor is the store's load, host-guarded, keyed onto the live connection", () => {
  const bucket = bucketFrom("build-01", 4, [freshQuery(4)], NOW);
  const store = { load: (host: string) => (host === "build-01" ? bucket : null) };

  // The same host, a different run's id: restored, and keyed onto 9.
  const restored = loadFor(store, "build-01", 9);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].key, panelKey(9, "read", "/srv/app/x"));

  // A host with no bucket gets nothing, which is the guard that matters: the
  // id alone could never tell two machines apart.
  assert.deepEqual(loadFor(store, "gpu-box", 9), []);
});

test("what is restored decodes to what was stored", () => {
  // End to end through the codec: the object identity is not preserved, the
  // value is — including the part that is not JSON.
  const data = { path: "/srv/app", truncated: false, blob: new Uint8Array([1, 2, 3]) };
  const bucket = bucketFrom("build-01", 4, [{ key: panelKey(4, "list", "/srv/app"), data, updatedAt: NOW }], NOW);
  const [restored] = restoreEntries(bucket, 4);
  assert.deepEqual(restored.key, panelKey(4, "list", "/srv/app"));
  const back = restored.data as typeof data;
  assert.equal(back.path, "/srv/app");
  assert.equal(back.truncated, false);
  assert.ok(back.blob instanceof Uint8Array, "the bytes came back as indices");
  assert.deepEqual(Array.from(back.blob), [1, 2, 3]);
});

/**
 * `cache.ts` — the optional on-disk cache.
 *
 * Four rules from the brief are what these tests are for: the setting starts
 * off, nothing that names a credential is ever written, the bucket belongs to
 * exactly one host, and the clear button clears everything. The store is
 * injected, so none of this touches a real `localStorage`.
 *
 * "Exactly one host" and not "one connection" is deliberate and is pinned below:
 * a connection id is a per-run counter, so guarding on it would refuse every
 * bucket written by a previous run — the only case a disk cache exists for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_CACHE_BUCKET,
  APP_CACHE_DIR,
  APP_CACHE_SETTING,
  appCacheEnabled,
  createMemoryStore,
  createPanelCache,
  createWebStore,
  decodeCacheValue,
  encodeCacheValue,
  isCacheableKey,
  setAppCacheEnabled,
  usableBucket,
  type CacheBucket,
  type WebStorageLike,
} from "./cache.ts";

const bucket = (over: Partial<CacheBucket> = {}): CacheBucket => ({
  host: "build-01",
  id: 1,
  entries: { '["panel",1,"read","/srv/app/x"]': "{}" },
  ...over,
});

/** A `localStorage` stand-in that records what it was asked to do. */
function fakeStorage(): WebStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

// ---------------------------------------------------------------------------
// The designated directory
// ---------------------------------------------------------------------------

test("the cache directory is the one the product designates", () => {
  assert.equal(APP_CACHE_DIR, "~/.faragent/app-cache/");
});

// ---------------------------------------------------------------------------
// Off by default
// ---------------------------------------------------------------------------

test("the cache setting starts off", () => {
  assert.equal(appCacheEnabled(createMemoryStore()), false);
});

test("the setting round-trips through the store", () => {
  const store = createMemoryStore();
  setAppCacheEnabled(true, store);
  assert.equal(appCacheEnabled(store), true);
  setAppCacheEnabled(false, store);
  assert.equal(appCacheEnabled(store), false);
  assert.equal(store.read(APP_CACHE_SETTING), null, "off leaves no key behind");
});

test("an unreadable setting value reads as off", () => {
  // Anything that is not the exact "on" is off. A corrupted profile must not
  // turn the cache on, because "on" is the state that writes data to disk.
  const store = createMemoryStore();
  store.write(APP_CACHE_SETTING, "yes");
  assert.equal(appCacheEnabled(store), false);
});

// ---------------------------------------------------------------------------
// The credential guard
// ---------------------------------------------------------------------------

test("no query key naming a credential is cacheable", () => {
  const forbidden: Array<readonly unknown[]> = [
    ["panel", 1, "read", "/home/u/.ssh/id_rsa"],
    ["hosts", "build-01", "password"],
    ["auth", "token"],
    ["panel", 1, "list", "/home/u/.config/gh/hosts.yml"],
    ["ssh", "privateKey"],
    ["api_key"],
    ["connect", 1, "askpass"],
    ["credential", "get"],
    ["secret", "shh"],
    ["identityFile", "/k"],
    ["passwd"],
    ["panel", 1, "read", "/etc/shadow"],
  ];
  for (const key of forbidden) {
    assert.equal(isCacheableKey(key), false, `allowed ${JSON.stringify(key)}`);
  }
});

test("the panel's own query keys are cacheable", () => {
  const allowed: Array<readonly unknown[]> = [
    ["panel", 1, "list", "/srv/app"],
    ["panel", 1, "stat", "/srv/app/main.rs"],
    ["panel", 1, "read", "/srv/app/main.rs", 262_144],
    ["panel", 1, "status"],
    ["panel", 1, "branches"],
    ["panel", 1, "log"],
    ["panel", 1, "diff", "/srv/app/main.rs"],
  ];
  for (const key of allowed) {
    assert.equal(isCacheableKey(key), true, `refused ${JSON.stringify(key)}`);
  }
});

test("the guard is case-insensitive", () => {
  assert.equal(isCacheableKey(["Password"]), false);
  assert.equal(isCacheableKey(["AUTH"]), false);
  assert.equal(isCacheableKey(["APIKey"]), false);
});

// ---------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------

test("plain JSON survives the codec unchanged", () => {
  const value = { name: "main.rs", size: 1234, dirty: false, tags: ["a", "b"], nested: { n: null } };
  assert.deepEqual(decodeCacheValue(encodeCacheValue(value)), value);
});

test("a Uint8Array round-trips as bytes, not as an object of indices", () => {
  // `JSON.stringify` alone would give `{"0":137,"1":80,…}` — a round trip that
  // looks like it worked and stores 20 bytes per byte.
  const bytes = new Uint8Array([0, 137, 80, 78, 71, 255]);
  const text = encodeCacheValue({ data: bytes });
  assert.ok(!text.includes('"0":'), "the byte array was stringified as indices");

  const back = decodeCacheValue(text) as { data: Uint8Array };
  assert.ok(back.data instanceof Uint8Array);
  assert.deepEqual(Array.from(back.data), [0, 137, 80, 78, 71, 255]);
});

test("a byte array nested inside the value round-trips", () => {
  const value = { entries: [{ path: new Uint8Array([47, 115, 114, 118]), kind: "dir" }] };
  const back = decodeCacheValue(encodeCacheValue(value)) as {
    entries: Array<{ path: Uint8Array; kind: string }>;
  };
  assert.equal(back.entries[0].kind, "dir");
  assert.deepEqual(Array.from(back.entries[0].path), [47, 115, 114, 118]);
});

test("an empty byte array survives", () => {
  const back = decodeCacheValue(encodeCacheValue({ data: new Uint8Array(0) })) as {
    data: Uint8Array;
  };
  assert.ok(back.data instanceof Uint8Array);
  assert.equal(back.data.length, 0);
});

test("text that is not JSON throws rather than decoding to a half-value", () => {
  assert.throws(() => decodeCacheValue("<html>not found</html>"));
});

// ---------------------------------------------------------------------------
// The bucket, and who it belongs to
// ---------------------------------------------------------------------------

test("a bucket loads back for the host that wrote it", () => {
  const cache = createPanelCache(createMemoryStore());
  cache.save(bucket({ host: "gpu-box", id: 4 }));
  const loaded = cache.load("gpu-box");
  assert.equal(loaded?.host, "gpu-box");
  assert.equal(loaded?.id, 4);
  assert.deepEqual(Object.keys(loaded?.entries ?? {}), ['["panel",1,"read","/srv/app/x"]']);
});

test("another host never reads this host's bucket", () => {
  // The guard that carries the meaning: a bucket is for the alias that wrote it.
  const cache = createPanelCache(createMemoryStore());
  cache.save(bucket({ host: "build-01", id: 1 }));
  assert.equal(cache.load("gpu-box"), null);
  assert.notEqual(cache.load("build-01"), null);
});

test("a bucket from a previous run hydrates, because the id is not the guard", () => {
  // The bug this pins, found by running the feature: connection ids are a
  // per-run counter (the same host is id 1 in one run and id 3 in the next), so
  // a guard that required the id to match refused every bucket written before
  // this launch — which is the only case a *disk* cache exists for. The host is
  // the discriminator; the id is a record, and the keys are rewritten on
  // restore.
  const cache = createPanelCache(createMemoryStore());
  cache.save(bucket({ host: "build-01", id: 7 }));
  const loaded = cache.load("build-01");
  assert.notEqual(loaded, null, "a bucket from an earlier run must still be usable");
  assert.equal(loaded?.id, 7, "and it still says which run wrote it");
});

test("an absent bucket is null, not an empty one", () => {
  const cache = createPanelCache(createMemoryStore());
  assert.equal(cache.load("build-01"), null);
});

test("a corrupt bucket reads as absent", () => {
  const store = createMemoryStore();
  store.write(APP_CACHE_BUCKET, "{ not json");
  const cache = createPanelCache(store);
  assert.equal(cache.load("build-01"), null);
});

test("a bucket of the wrong shape reads as absent", () => {
  const store = createMemoryStore();
  store.write(APP_CACHE_BUCKET, JSON.stringify({ id: 1, entries: {} }));
  assert.equal(createPanelCache(store).load("build-01"), null);

  store.write(APP_CACHE_BUCKET, JSON.stringify(["not", "a", "bucket"]));
  assert.equal(createPanelCache(store).load("build-01"), null);
});

test("usableBucket is a pure guard over the host", () => {
  assert.equal(usableBucket(null, "a"), null);
  assert.equal(usableBucket(bucket({ host: "a", id: 1 }), "b"), null);
  assert.notEqual(usableBucket(bucket({ host: "a", id: 1 }), "a"), null);
  assert.notEqual(
    usableBucket(bucket({ host: "a", id: 99 }), "a"),
    null,
    "the id is not part of the guard",
  );
});

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

test("clear removes the whole bucket, not one entry", () => {
  const store = createMemoryStore();
  const cache = createPanelCache(store);
  cache.save(bucket({ entries: { a: "1", b: "2" } }));
  assert.ok(cache.size() > 0);

  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(store.read(APP_CACHE_BUCKET), null, "the key itself was left behind");
  assert.equal(cache.load("build-01"), null);
});

test("clear does not touch the enabled setting", () => {
  // Clearing the cache is not a way to turn it off, and must not silently do so.
  const store = createMemoryStore();
  setAppCacheEnabled(true, store);
  createPanelCache(store).clear();
  assert.equal(appCacheEnabled(store), true);
});

test("size reports the stored length, and zero when there is nothing", () => {
  const store = createMemoryStore();
  const cache = createPanelCache(store);
  assert.equal(cache.size(), 0);
  cache.save(bucket());
  assert.equal(cache.size(), (store.read(APP_CACHE_BUCKET) ?? "").length);
  assert.ok(cache.size() > 0);
});

// ---------------------------------------------------------------------------
// The store seam
// ---------------------------------------------------------------------------

test("a byte cache value survives a real string store", () => {
  // The end-to-end shape: write a value with bytes through the store, read it
  // back through the cache.
  const storage = fakeStorage();
  const cache = createPanelCache(createWebStore(storage));
  const entries = { key: encodeCacheValue(new Uint8Array([104, 105])) };
  cache.save(bucket({ entries }));

  const loaded = cache.load("build-01");
  const value = decodeCacheValue(loaded?.entries.key ?? "") as Uint8Array;
  assert.ok(value instanceof Uint8Array);
  assert.deepEqual(Array.from(value), [104, 105]);
});

test("a storage that throws on read does not take the panel down", () => {
  const hostile: WebStorageLike = {
    getItem() {
      throw new Error("storage disabled");
    },
    setItem() {
      throw new Error("quota exceeded");
    },
    removeItem() {
      throw new Error("storage disabled");
    },
  };
  const store = createWebStore(hostile);
  assert.equal(store.read("k"), null);

  const cache = createPanelCache(store);
  // None of these throw: a cache that failed closed is the point of "optional".
  cache.save(bucket());
  assert.equal(cache.size(), 0);
  assert.equal(cache.load("build-01"), null);
  cache.clear();
});

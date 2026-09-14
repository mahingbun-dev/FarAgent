/**
 * What of the panel's cache is allowed to reach the disk, and how it is put
 * back.
 *
 * [`encodeCacheValue`] and the bucket live in `cache.ts`; this module decides
 * *which* queries go in one. That decision is the security-relevant half of the
 * feature, so it is a pure function over plain values and is tested as one —
 * no React, no query client, no storage.
 *
 * Three rules, and they are deliberately redundant with `cache.ts`'s own guard:
 *
 * 1. **An allowlist of query names, not a denylist.** A later task adding a
 *    query has to add it here to get it persisted, so an ssh password or a
 *    conversation transcript cannot be cached by omission. `isCacheableKey` in
 *    `cache.ts` is the second lock, on the key's text.
 * 2. **Only this host.** The bucket is written for one host and read back for
 *    the same alias; a bucket naming another host is refused. The connection id
 *    is deliberately *not* part of that guard — it is a per-run counter, so
 *    requiring it to match would refuse every bucket written by a previous run,
 *    which is the only case a disk cache has. The restored keys are rewritten
 *    onto the live connection instead, in [`restoreEntries`].
 * 3. **Nothing old.** An entry past `maxAgeMs` is dropped rather than restored:
 *    a cached listing is a picture of a directory that may not exist any more.
 *
 * Restoring never makes data *fresh*. The caller sets it back with an
 * `updatedAt` of zero, so the panel paints instantly from the copy and then
 * revalidates — see `panel-watch.tsx`.
 */
import {
  decodeCacheValue,
  encodeCacheValue,
  isCacheableKey,
  type CacheBucket,
} from "./cache.ts";
import { PANEL_ROOT } from "./keys.ts";

/**
 * The query names whose data may be persisted.
 *
 * Everything here is a file listing, a file's bytes, a stat, or git metadata —
 * all of it the remote's, all of it read-only. Notably absent: anything from
 * `discover` is in, but no future "conversation" or "attach" query would be by
 * default, which is the point of an allowlist.
 */
export const PERSISTED_QUERIES = [
  "list",
  "stat",
  "read",
  "discover",
  "status",
  "branches",
  "log",
  "diff",
] as const;

/** How long a cached entry may live before it is dropped instead of restored. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One query as the cache sees it. */
export interface QuerySnapshot {
  key: readonly unknown[];
  data: unknown;
  /** `state.dataUpdatedAt` — the epoch ms the data was stored. */
  updatedAt: number;
}

/** True when this key names persistable data for this connection. */
export function persistableKey(key: readonly unknown[], connectionId: number): boolean {
  if (key.length < 3) return false;
  if (key[0] !== PANEL_ROOT) return false;
  if (key[1] !== connectionId) return false;
  const name = key[2];
  if (typeof name !== "string") return false;
  if (!(PERSISTED_QUERIES as readonly string[]).includes(name)) return false;
  return isCacheableKey(key);
}

/**
 * The entries to write, as serialised key → encoded data.
 *
 * `updatedAt` of zero is treated as old: a query that has never been given data
 * by a fetch has no timestamp worth trusting, and React Query uses zero for
 * exactly that state.
 */
export function collectEntries(
  connectionId: number,
  queries: readonly QuerySnapshot[],
  now: number,
  maxAgeMs: number = PERSIST_MAX_AGE_MS,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const query of queries) {
    if (query.data === undefined) continue;
    if (!persistableKey(query.key, connectionId)) continue;
    if (query.updatedAt <= 0 || now - query.updatedAt > maxAgeMs) continue;
    entries[JSON.stringify(query.key)] = encodeCacheValue(query.data);
  }
  return entries;
}

/** The bucket to hand [`CacheStore`], from the queries the client holds. */
export function bucketFrom(
  host: string,
  id: number,
  queries: readonly QuerySnapshot[],
  now: number,
  maxAgeMs: number = PERSIST_MAX_AGE_MS,
): CacheBucket {
  return { host, id, entries: collectEntries(id, queries, now, maxAgeMs) };
}

/**
 * The bucket to write, or `null` when there is nothing worth writing.
 *
 * The rule this exists for: **an empty bucket must never overwrite a good one.**
 * There is a single bucket key, and a snapshot with no entries happens exactly
 * when the panel is being torn down before it has fetched anything — a
 * StrictMode double mount, a hot reload, a panel closed the instant it opened.
 * Writing then destroys the previous run's cache at the worst possible moment:
 * on the way in, before the read side has had a chance to restore from it.
 *
 * Found by running the feature rather than by reading it, which is why the
 * decision is a pure function here and not a line inside the component: a
 * tear-down that clobbers the cache is invisible to both the UI and the type
 * checker.
 *
 * A user who wants the cache gone has the settings page's clear button, so
 * "write nothing" is strictly better than "write nothing useful".
 */
export function bucketToSave(
  host: string,
  id: number,
  queries: readonly QuerySnapshot[],
  now: number,
  maxAgeMs: number = PERSIST_MAX_AGE_MS,
): CacheBucket | null {
  const bucket = bucketFrom(host, id, queries, now, maxAgeMs);
  return Object.keys(bucket.entries).length === 0 ? null : bucket;
}

/** One query to put back, as the caller's `setQueryData` wants it. */
export interface RestoredEntry {
  key: unknown[];
  data: unknown;
}

/**
 * The queries to put back into the client, from a bucket.
 *
 * Everything is re-checked rather than trusted: the bucket was written by a
 * previous run of the app, and the allowlist, the host guard and the key's own
 * text are the things that must hold *now*. An entry that fails to decode is
 * dropped, not thrown — one corrupt row must not cost the user the rest of
 * their cache.
 *
 * ## Why the keys are rewritten
 *
 * A stored key embeds the connection id of the run that wrote it, and that id
 * is a per-run counter: the same host is connection 3 this run and connection 1
 * the next. Restoring the key verbatim would therefore put data under a key no
 * hook will ever ask for — the hydration would "work" and nothing would ever
 * read it. So element 1 is replaced with the live `connectionId`, and the
 * rewritten key is what comes back for `setQueryData`. Everything else about the
 * key (the query name, the path, the read's limit) is the previous run's and is
 * exactly what is wanted: it names a file that is still that file.
 */
export function restoreEntries(
  bucket: CacheBucket | null,
  connectionId: number,
): RestoredEntry[] {
  if (!bucket) return [];
  const out: RestoredEntry[] = [];
  for (const [text, encoded] of Object.entries(bucket.entries)) {
    let stored: unknown;
    try {
      stored = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(stored)) continue;
    if (typeof stored[0] !== "string" || typeof stored[2] !== "string") continue;
    const key = [stored[0], connectionId, ...stored.slice(2)];
    if (!persistableKey(key, connectionId)) continue;
    try {
      out.push({ key, data: decodeCacheValue(encoded) });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The whole read path in one call: load the bucket for a host and return what to
 * restore from it, keyed onto `id` — the connection that is live now.
 *
 * An unset cache is a no-op, so the caller can wire this up unconditionally and
 * let the setting decide.
 */
export function loadFor(
  store: { load(host: string): CacheBucket | null },
  host: string,
  id: number,
): RestoredEntry[] {
  return restoreEntries(store.load(host), id);
}

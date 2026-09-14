/**
 * Push-driven refresh, and the subscription bookkeeping behind it.
 *
 * The remote helper pushes `fs.changed` / `git.changed` (see
 * `crates/faragent-helper/src/watch.rs`). This module is the frontend's half of
 * that: which panel queries a change invalidates, how a burst of changes is
 * collapsed into one flush, and how the remote subscription is shared and
 * released.
 *
 * Three rules, all of them from the brief, are enforced by construction:
 *
 * 1. **Never re-fetch the whole tree.** A change invalidates the *directory*
 *    that gained or lost an entry, plus the changed file's own `stat` and
 *    `read` — not `["panel"]`, not the root. See [`invalidationScope`].
 * 2. **A burst must not hammer SSH.** `git checkout` writes thousands of files
 *    and `npm install` writes tens of thousands; one round trip per event would
 *    make the panel the load on the remote. [`createCoalescer`] gathers a
 *    window's worth into one flush. A *fixed* window, not a reset-on-each-event
 *    debounce: a debounce under a steady stream of writes would never fire.
 * 3. **Every subscribe is matched by an unsubscribe.** The remote's
 *    `watch.subscribe` is idempotent per (path, recursive), so two panels
 *    watching the same root share one subscription id and the second
 *    `subscribe` answers `already: true`. That makes naive bookkeeping a leak:
 *    the first panel to close would unsubscribe the id out from under the
 *    second. [`createWatchPool`] reference-counts per (client, path) and only
 *    unsubscribes when the last holder releases — and it unsubscribes a
 *    subscription that resolved *after* its last holder left, which is the
 *    StrictMode shape (subscribe in flight, cleanup, remount).
 *
 * Pure: no React, no DOM, no timers of its own (`scheduler` is injectable).
 * `node --test` runs it directly.
 */
import { panelKey, type KeyPart } from "./keys.ts";
import { normalizePath, parentPath } from "./paths.ts";

/** How long a burst of pushes is gathered before one flush. */
export const COALESCE_MS = 250;

/** One push, reduced to the two facts that decide what to invalidate. */
export type Change = { kind: "fs"; path: string } | { kind: "git" };

/** A React Query key, or a key *prefix* — `invalidateQueries` matches by prefix. */
export type QueryKeyPrefix = KeyPart[];

/**
 * The panel queries one change invalidates.
 *
 * For an `fs.changed` at `P`, exactly four prefixes, and never the whole panel:
 *
 * | prefix | why |
 * | --- | --- |
 * | `list` of `P`'s parent | that directory's listing gained or lost an entry |
 * | `list` of `P` | `P` may itself be a directory whose contents changed |
 * | `stat` of `P` | the preview asks for the size before it reads |
 * | `read` of `P` | the preview's bytes |
 *
 * The `read` prefix omits the key's `limit` part on purpose: it is a prefix, so
 * every window of that path is invalidated at once, which is what a file that
 * changed under the reader wants.
 *
 * A `git.changed` is coarse (HEAD or the index moved), so the whole git query
 * set goes: status, branches, log and every open patch. `discover` is *not*
 * invalidated — a subscription whose root had no repository never reports
 * `git.changed` at all, so a repository cannot appear underneath one.
 */
export function invalidationScope(
  connectionId: number,
  change: Change,
): QueryKeyPrefix[] {
  if (change.kind === "git") {
    // `["panel", id, "status"]` and its siblings: no root part, so every
    // repository's status under this connection is invalidated. `git.changed`
    // carries a root, and a panel only ever has one root open — but the key
    // does not, so the prefix stops at the name.
    return ["status", "branches", "log", "diff"].map((name) =>
      panelKey(connectionId, name),
    );
  }
  const path = normalizePath(change.path);
  return [
    panelKey(connectionId, "list", parentPath(path)),
    panelKey(connectionId, "list", path),
    panelKey(connectionId, "stat", path),
    panelKey(connectionId, "read", path),
  ];
}

/** De-duplicate the prefixes of a batch, so a flush issues each key once. */
export function uniqueScopes(scopes: QueryKeyPrefix[]): QueryKeyPrefix[] {
  const seen = new Set<string>();
  const out: QueryKeyPrefix[] = [];
  for (const scope of scopes) {
    const id = JSON.stringify(scope);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(scope);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

/** The one side effect the coalescer needs. Injectable so a test can flush. */
export interface Scheduler {
  /** Run `fn` after `ms`; return the "do not run it" function. */
  after(ms: number, fn: () => void): () => void;
}

export const realScheduler: Scheduler = {
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

export interface Coalescer<T> {
  /** Add to the pending batch, arming the window if it is not already armed. */
  offer(value: T): void;
  /** Fire now, whatever the timer says. Used on teardown. */
  flush(): void;
  /** Drop the pending batch and disarm. Used on teardown. */
  cancel(): void;
  /** How many values are waiting. For tests and assertions. */
  count(): number;
}

/**
 * Gather values for `windowMs` and hand them to `sink` in one batch.
 *
 * The window is armed by the *first* value and not re-armed by later ones, so a
 * stream that never pauses still flushes once per window instead of starving
 * until it ends. The sink is not called with an empty batch.
 */
export function createCoalescer<T>(
  windowMs: number,
  sink: (batch: T[]) => void,
  scheduler: Scheduler = realScheduler,
): Coalescer<T> {
  let pending: T[] = [];
  let disarm: (() => void) | null = null;

  const fire = () => {
    disarm = null;
    const batch = pending;
    pending = [];
    if (batch.length > 0) sink(batch);
  };

  return {
    offer(value) {
      pending.push(value);
      disarm ??= scheduler.after(windowMs, fire);
    },
    flush() {
      disarm?.();
      fire();
    },
    cancel() {
      disarm?.();
      disarm = null;
      pending = [];
    },
    count() {
      return pending.length;
    },
  };
}

// ---------------------------------------------------------------------------
// The shared remote subscription
// ---------------------------------------------------------------------------

/** The two `watch.*` calls, as `HelperConnection` spells them. */
export interface WatchClient {
  subscribe(path: string, recursive: boolean): Promise<{ subscription: number }>;
  unsubscribe(opts: { subscription: number }): Promise<{ removed: number }>;
}

export interface WatchPool {
  /**
   * Join (or start) the shared watch on `path`. The returned function releases
   * this holder; the remote subscription ends when the last holder does.
   */
  acquire(client: WatchClient, path: string, recursive?: boolean): () => void;
  /**
   * Forget every subscription held against `client`. Called when the channel
   * closes: the remote side is gone with it, and a later `release` must not try
   * to unsubscribe on a dead connection.
   */
  forget(client: WatchClient): void;
  /** Live (client, path) entries. For tests. */
  size(): number;
}

interface Entry {
  holders: number;
  /** `null` until the remote has answered the subscribe. */
  id: number | null;
  /** The last holder left before the answer arrived. */
  abandoned: boolean;
}

/**
 * Reference-counted `watch.subscribe`, keyed by (client, path).
 *
 * The delicate case is the one StrictMode produces on every mount: an effect
 * subscribes, is cleaned up before the answer arrives, and remounts. Three
 * things have to hold, and all three are tested:
 *
 * - The remount's `acquire` joins the *same* entry rather than subscribing
 *   again (the entry is keyed by path, not by holder).
 * - If no remount comes, the answer's arrival unsubscribes immediately — the
 *   `abandoned` branch. Without it, the subscription would live on the remote
 *   with nobody listening, which is the leak.
 * - `forget` drops the table entry for a client whose channel closed, so a
 *   stale `release` cannot call `unsubscribe` on a dead connection.
 *
 * A failed subscribe is not retried here: the next panel mount acquires again,
 * and the helper's own idempotence makes that cheap.
 */
export function createWatchPool(): WatchPool {
  const tables = new WeakMap<WatchClient, Map<string, Entry>>();
  // A `WeakMap` cannot be walked, so the live count is kept beside it. Dropping
  // a client with `forget` subtracts its table, which is why the tables are
  // counted rather than the entries: a table is only ever removed whole.
  let live = 0;

  const tableFor = (client: WatchClient): Map<string, Entry> => {
    let table = tables.get(client);
    if (!table) {
      table = new Map();
      tables.set(client, table);
    }
    return table;
  };

  const unsubscribe = (client: WatchClient, id: number): void => {
    // Swallowed on purpose: the channel may be gone, and a teardown path must
    // not surface an error nobody can act on. `helper_close` already ends every
    // subscription the remote held.
    void client.unsubscribe({ subscription: id }).catch(() => {});
  };

  return {
    acquire(client, path, recursive = true) {
      const key = `${recursive ? "r" : "n"}:${normalizePath(path)}`;
      const table = tableFor(client);
      let entry = table.get(key);
      if (!entry) {
        entry = { holders: 0, id: null, abandoned: false };
        table.set(key, entry);
        live += 1;
        const started = entry;
        void client.subscribe(path, recursive).then(
          (subscription) => {
            // The last holder may have left while this was in flight. The entry
            // is the current one *only* if nobody removed it; when it is not,
            // remembering the id would leak the remote watch, so it is
            // unsubscribed on the spot.
            if (started.abandoned || table.get(key) !== started) {
              unsubscribe(client, subscription.subscription);
              return;
            }
            started.id = subscription.subscription;
          },
          () => {
            // No subscription exists, so the entry has nothing to hold. Drop it
            // so a later acquire tries again instead of joining a dead slot.
            if (table.get(key) === started) {
              table.delete(key);
              live -= 1;
            }
          },
        );
      }
      entry.holders += 1;

      let released = false;
      return () => {
        if (released) return;
        released = true;
        // The client may have been forgotten (its channel closed); its table is
        // gone and the remote holds nothing to unsubscribe from.
        if (tables.get(client)?.get(key) !== entry) return;
        entry.holders -= 1;
        if (entry.holders > 0) return;
        table.delete(key);
        live -= 1;
        if (entry.id !== null) unsubscribe(client, entry.id);
        else entry.abandoned = true;
      };
    },

    forget(client) {
      const table = tables.get(client);
      if (!table) return;
      live -= table.size;
      tables.delete(client);
    },

    size() {
      return live;
    },
  };
}

/** The pool the app uses. One, because the subscription table is global. */
export const panelWatches = createWatchPool();

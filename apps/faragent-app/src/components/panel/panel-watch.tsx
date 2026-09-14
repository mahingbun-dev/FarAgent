/**
 * The panel's half of the helper's push channel.
 *
 * Renders nothing. Mounted once per open panel, inside
 * `PanelHelperProvider`, its only job is to keep three things true while the
 * panel is on screen:
 *
 * 1. **One subscription to the panel's root**, shared with any other panel on
 *    the same connection (two workspace tabs on one host share a
 *    `HelperConnection`, and the remote's `watch.subscribe` is idempotent per
 *    path — see `lib/panel/watch.ts`'s pool, which is what makes a shared
 *    subscription safe to release).
 * 2. **A refresh when the remote says something changed.** Pushes are gathered
 *    for `COALESCE_MS` and then turned into a handful of *specific* query
 *    invalidations — the changed directory, the changed file's stat and read,
 *    or the git query set. Never `["panel"]`: that would re-walk the tree and
 *    re-read every open file, which is the cost this task exists to avoid, and
 *    one `npm install` would trigger it thousands of times.
 * 3. **Nothing left behind.** The subscription is released, the coalescer's
 *    pending timer is cancelled, and the connection's queries are dropped from
 *    the local cache when the panel closes, when the tab switches (which
 *    unmounts this component — `PanelSlot` keys `RightPanel` by tab) and when
 *    the channel closes. This project has had two leaks of exactly this shape;
 *    this is the third, and `watch.test.ts` pins the release path.
 *
 * ## A note on the panel's own tabs
 *
 * Switching between the files / changes / git tabs does *not* drop the watch.
 * The watch is on the panel's **root**, which all three read, and the three
 * `TabsContent`s unmount their contents on switch — so a per-tab subscription
 * would be a `watch.unsubscribe` + `watch.subscribe` round trip on every tab
 * click, for a subscription the next tab is about to make again. The lifecycle
 * the brief asks for is the panel's: closing it, switching the workspace tab it
 * belongs to, or losing the channel.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePanelHelper } from "@/components/panel/helper-context";
import { asFsChanged, asGitChanged, decodeText } from "@/lib/helper";
import { panelCache } from "@/lib/panel/cache";
import { bucketToSave, loadFor } from "@/lib/panel/persist";
import {
  COALESCE_MS,
  createCoalescer,
  invalidationScope,
  panelWatches,
  uniqueScopes,
  type Change,
} from "@/lib/panel/watch";
import { useStore } from "@/state";

/**
 * How long a settled query waits before the cache is rewritten.
 *
 * Longer than the push coalescer on purpose: writes to disk are not urgent, and
 * a `git checkout` settles hundreds of queries in a row. Only reached when the
 * cache is switched on.
 */
const PERSIST_DEBOUNCE_MS = 1_000;

export function PanelWatch({ root }: { root: string }) {
  const { connection, capabilities } = usePanelHelper();
  const queryClient = useQueryClient();
  const cacheOn = useStore((s) => s.appCacheEnabled);

  /**
   * Whether this remote can be subscribed to at all. A bash-fallback remote
   * cannot: `watch.subscribe` is one of the three ops it does not speak, and a
   * failed subscribe is dropped by design inside `lib/panel/watch.ts` — which
   * made "live refresh never happens here" the one shortfall with no symptom at
   * all. `right-panel.tsx` states it instead, and this skips the doomed round
   * trip. Optimistic while the ping is in flight, so a native host still
   * subscribes on the first paint; a fallback host's wasted subscribe is
   * released by the pool as soon as the decision lands.
   */
  const subscribable = capabilities.watch;

  /**
   * The persist effect's "write the bucket now", published for the teardown
   * below.
   *
   * A ref rather than a call, because the two effects' cleanups run in the order
   * they are declared — this file's watch effect first, the persist effect
   * second — and only the first is early enough to be useful: by the time the
   * persist effect's cleanup runs, the watch effect has already dropped this
   * connection's queries and there is nothing left to save. So the save is
   * published here and invoked from the watch effect's teardown, before the
   * queries go. With the cache off nothing publishes one and this is a no-op.
   */
  const snapshotRef = useRef<(() => void) | null>(null);

  // The subscription, the pushes, and the release.
  useEffect(() => {
    if (!connection || root === "" || !subscribable) return;

    const release = panelWatches.acquire(connection, root);
    const invalidate = (changes: Change[]) => {
      const scopes = uniqueScopes(
        changes.flatMap((change) => invalidationScope(connection.id, change)),
      );
      for (const queryKey of scopes) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const coalescer = createCoalescer<Change>(COALESCE_MS, invalidate);

    const stopPushes = connection.onPush((event) => {
      const fs = asFsChanged(event);
      if (fs) {
        // `fs.changed` always names a path, so the path is never absent — an
        // unreadable one decodes to "" and invalidates nothing, which is the
        // safe direction to fail in.
        coalescer.offer({ kind: "fs", path: decodeText(fs.path) });
        return;
      }
      if (asGitChanged(event)) coalescer.offer({ kind: "git" });
    });

    const stopClosed = connection.onClosed(() => {
      // The remote took every subscription with it. Dropping the pool's table
      // now means a later release cannot try to unsubscribe over a dead
      // channel, and the cache goes with the connection it described.
      coalescer.cancel();
      panelWatches.forget(connection);
      void queryClient.removeQueries({ queryKey: ["panel", connection.id] });
    });

    return () => {
      stopPushes();
      stopClosed();
      coalescer.cancel();
      release();
      // Before the queries go: the panel's last state is what the next run
      // restores, and it is the one thing that would otherwise never be saved.
      snapshotRef.current?.();
      // The connection's data is about to be unreachable; keeping it would let
      // a *different* remote's panel read it if the id were ever reused.
      void queryClient.removeQueries({ queryKey: ["panel", connection.id] });
    };
  }, [connection, root, subscribable, queryClient]);

  // The optional disk cache, read side. Once per connection, and only when the
  // setting is on — with it off this effect does nothing at all.
  useEffect(() => {
    if (!connection || !cacheOn) return;
    const cache = panelCache();
    for (const { key, data } of loadFor(cache, connection.host, connection.id)) {
      // `updatedAt: 0` is the whole point: the panel paints from the copy on
      // disk and immediately treats it as stale, so the fetch that follows is
      // the real answer. A restored entry is a head start, never a substitute.
      queryClient.setQueryData(key, data, { updatedAt: 0 });
    }
  }, [connection, cacheOn, queryClient]);

  // The optional disk cache, write side. Same guard.
  useEffect(() => {
    if (!connection || !cacheOn) return;
    const cache = panelCache();

    const snapshot = () => {
      const queries = queryClient.getQueryCache().getAll().map((query) => ({
        key: query.queryKey,
        data: query.state.data,
        updatedAt: query.state.dataUpdatedAt,
      }));
      // `bucketToSave` returns `null` for a snapshot with no entries, and that
      // refusal is the point: a teardown before anything was fetched — a
      // StrictMode double mount, a hot reload, a panel closed the instant it
      // opened — would otherwise write an empty bucket over the previous run's,
      // destroying the cache before the read side below could restore from it.
      // The rule lives in `lib/panel/persist.ts` so it can be tested; see
      // `bucketToSave` there.
      const bucket = bucketToSave(connection.host, connection.id, queries, Date.now());
      if (bucket) cache.save(bucket);
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        snapshot();
      }, PERSIST_DEBOUNCE_MS);
    };

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      // Only a query this connection owns is worth rewriting the bucket for.
      if (event.query.queryKey[1] !== connection.id) return;
      schedule();
    });
    snapshotRef.current = snapshot;
    schedule();

    return () => {
      // No `snapshot()` here on purpose — see the ref's comment above. This
      // cleanup runs *after* the watch effect's, which has already dropped this
      // connection's queries, so a write from here is always the empty one the
      // guard above exists to refuse. The watch effect's teardown is the single
      // owner of the save.
      snapshotRef.current = null;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [connection, cacheOn, queryClient]);

  return null;
}

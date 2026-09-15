/**
 * The panel's helper connection, as a lease.
 *
 * The implementation — and the invariant that keeps a released slot closeable —
 * lives in `lib/lease.ts`. The algorithm is not copied here: it used to be a
 * second copy with a single `slot`, and that copy is what leaked an ssh child on
 * every key change (the story is at the bottom of this comment). What this module
 * adds is the one thing the generic lease cannot know: **which key the helper
 * connection should use, and when that key changes.**
 *
 * ## Why the key is not the caller's to choose
 *
 * `lib/lease.ts` caches the *promise*, including a rejected one, so asking again
 * under the same key replays the same failure. A retry therefore needs a new key,
 * and the obvious place to put the counter is the caller — which is where it
 * used to be: `helper-context.tsx` keyed by `` `${host}#${attempt}` `` with
 * `attempt` in its own component state.
 *
 * That is correct while exactly one component holds the connection, and it broke
 * the moment a second one did. The panel and the chat view (`components/chat/`)
 * are separate components with separate `attempt` counters, so a retry on one
 * side moved *it* to `host#1` while the other side stayed on `host#0` — two live
 * keys for one host, hence two `helper_open`s, and `helper.rs::adopt` is
 * destructive about the second one: **it ends the first session**. One side's
 * retry hung up the other side's channel, which is precisely the outcome the
 * lease exists to prevent.
 *
 * So the generation lives here, where every holder on a host reads the same one.
 * `keyFor(host)` is still `host#generation` — the shape `lib/lease.ts` wants —
 * but no caller picks the generation, so no two holders can disagree about it.
 * `renew` bumps it and tells the holders, and they move together: each releases
 * the old key and acquires the new one, the old slot's last release drops it (a
 * rejected open closes nothing on the way out, so the drop is free), and exactly
 * one of them opens the replacement while the rest join it.
 *
 * Pure: no DOM, no React. `watch` is a Set of listeners rather than any React
 * state, which is what keeps it so.
 *
 * ## The history this file exists to record
 *
 * It used to be a second copy of the lease algorithm, with a single `slot`:
 * `acquire` replaced a slot that still had a holder whenever the key differed,
 * and `release` then early-returned on the key mismatch — so `acquire("hA")`,
 * `acquire("hB")`, `release("hA")` closed nothing and hA's helper was leaked. The
 * comment here claimed the opposite ("a released slot whose key was replaced in
 * the meantime has no holder left and is closed by the same callback"); it
 * described an earlier arrangement of the code, not the one below it. That is the
 * failure mode worth naming: a comment asserting a guarantee the code does not
 * provide is how the next person ships the bug, and it is why this file no longer
 * has its own copy of the algorithm to drift out of step with the attach lease's.
 */
import { createLease, type Lease, type Schedule } from "../lease.ts";

export { createLease, type Lease, type Schedule } from "../lease.ts";

/**
 * A lease whose keys are the host's current generation, and whose holders can be
 * moved to the next generation together.
 *
 * `acquire` and `release` are `Lease`'s unchanged — a helper lease *is* a lease,
 * with the choice of key taken away from the caller and the ability to move every
 * holder of a host added.
 */
export interface HelperLease<T> extends Lease<T> {
  /** The key to acquire for this host right now. Changes when the host is renewed. */
  keyFor(host: string): string;
  /** Ask for a fresh channel on this host. The error state's retry. */
  renew(host: string): void;
  /** Learn that this host moved. Returns the unsubscribe. */
  watch(host: string, listener: () => void): () => void;
}

export function createHelperLease<T>(schedule?: Schedule): HelperLease<T> {
  const lease = createLease<T>(schedule);
  /** One generation per host. Bumped only by `renew`. */
  const generations = new Map<string, number>();
  const watchers = new Map<string, Set<() => void>>();

  return {
    keyFor: (host) => `${host}#${generations.get(host) ?? 0}`,
    acquire: (key, open) => lease.acquire(key, open),
    release: (key, close) => lease.release(key, close),

    renew: (host) => {
      generations.set(host, (generations.get(host) ?? 0) + 1);
      for (const listener of watchers.get(host) ?? []) listener();
    },

    watch: (host, listener) => {
      const existing = watchers.get(host);
      const listeners = existing ?? new Set<() => void>();
      if (!existing) watchers.set(host, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

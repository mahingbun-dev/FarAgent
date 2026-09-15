/**
 * A keyed lease: one deferred-close slot **per key**.
 *
 * `TerminalView` needs it for the ssh attach and the panel for its helper
 * connection, and both need the same two things from it:
 *
 * - **A remount must not re-open.** React StrictMode mounts, unmounts and
 *   remounts in one tick in `pnpm dev`. A resource opened by the first effect
 *   has to survive the cleanup that follows it, or every mount in dev spawns
 *   an `ssh` child and immediately kills it.
 * - **A release must always be able to close its own resource.** The deferred
 *   close is the only cleanup path there is. The attach is the sharp case: the
 *   Rust side only reaps a session when the ssh child's stdout hits EOF
 *   (`attach.rs`), which a live child never does, so a slot that nobody can
 *   release is a leaked ssh process, PTY master and pump thread — plus an
 *   unwanted remote tmux client — for the life of the app.
 *
 * The single-slot version of this satisfied the first and broke the second as
 * soon as a *second* key existed, which the multi-tab shell made normal:
 * acquiring B evicted A, and A's `release` then matched nothing, so nothing
 * ever closed A. N tabs leaked N−1 attaches. Three earlier leaks on the same
 * branch had the same shape, which is why the rule below is written as an
 * invariant rather than left implicit in the code:
 *
 * ```
 * a key's slot is only ever removed from the map by that slot's own deferred
 * close — never by another key, never by a second acquire.
 * ```
 *
 * The key is therefore the identity, not something to compare against a global:
 * `release` looks *its own* slot up by *its own* key, so it always has something
 * to close; no key can evict another's slot, so no resource can lose the only
 * callback that closes it; and two holders on one key share one resource, which
 * is what both consumers actually want.
 *
 * Pure: no DOM, no React. `schedule` is injectable, so a test flushes the
 * deferral deterministically instead of sleeping a macrotask and hoping.
 */

export type Schedule = (fn: () => void) => void;

export interface Lease<T> {
  /** One resource per key. A second call on a live key joins the first. */
  acquire(key: string, open: () => Promise<T>): Promise<T>;
  /** Drop one holder. The last one closes the resource, one macrotask later. */
  release(key: string, close: (value: T) => void): void;
}

interface Slot<T> {
  /** The map key this slot lives under — and the only key it can be found by. */
  key: string;
  /** Holders. 0 only in the window between the last release and its close. */
  holders: number;
  /** Set once the deferred close has committed; the slot is then out of the map. */
  closed: boolean;
  value: Promise<T>;
}

export function createLease<T>(
  schedule: Schedule = (fn) => setTimeout(fn, 0),
): Lease<T> {
  const slots = new Map<string, Slot<T>>();

  return {
    acquire(key, open) {
      // A slot that is still in the map is still open, even at zero holders:
      // that is the window before its deferred close, and re-joining it here is
      // what makes StrictMode's effect → cleanup → effect reuse one resource
      // instead of opening a second one.
      const slot = slots.get(key);
      if (slot) {
        slot.holders += 1;
        return slot.value;
      }
      const fresh: Slot<T> = { key, holders: 1, closed: false, value: open() };
      slots.set(key, fresh);
      return fresh.value;
    },

    release(key, close) {
      const slot = slots.get(key);
      // No slot: this key was never acquired, or its close has already
      // committed. A release outliving its resource is not an error — React
      // runs a cleanup for every effect that ran — it just has nothing to do.
      if (!slot) return;
      // More releases than acquires. Releasing the pending close instead would
      // leave the resource open with no holder left to close it, which is the
      // leak this whole file exists to prevent.
      if (slot.holders === 0) return;
      slot.holders -= 1;
      if (slot.holders > 0) return;

      schedule(() => {
        // Settled: a second release of this slot scheduled its own callback,
        // and whichever ran first closed the resource. Closing again would
        // double-close a resource that is already gone.
        if (slot.closed) return;
        // Re-acquired between the release and this tick — StrictMode's remount.
        // The slot has a holder again, so closing would kill a live resource;
        // the next release schedules the close.
        if (slot.holders > 0) return;
        slot.closed = true;
        slots.delete(slot.key);
        // The close is driven by the resolved value, not by the promise, so a
        // resource that never opened (a rejected `open`) is not "closed".
        void slot.value.then((value) => close(value)).catch(() => {});
      });
    },
  };
}

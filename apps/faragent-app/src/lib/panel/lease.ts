/**
 * Hold a shared resource across React StrictMode's immediate unmount/remount.
 *
 * `TerminalView` needed exactly this for the ssh attach and got its own
 * `createAttachLease` (typed to the numeric session id). The panel needs the
 * same for the helper connection, so this is the generic form: a second
 * `acquire` with the same key joins the first caller's promise instead of
 * opening a second connection, and the close is deferred by a macrotask so a
 * remount that lands in the same tick re-acquires the slot before it is torn
 * down.
 *
 * That deferral is the whole point. Without it, `pnpm dev`'s StrictMode
 * remount would open a helper channel, immediately close it, and open another
 * — which on the real backend means an ssh child spawned and killed on every
 * panel mount, and a remote log full of noise.
 *
 * Pure: no DOM, no React. `schedule` is injectable so a test can flush it.
 */

export type Schedule = (fn: () => void) => void;

export interface Lease<T> {
  acquire(key: string, open: () => Promise<T>): Promise<T>;
  release(key: string, close: (value: T) => void): void;
}

export function createLease<T>(
  schedule: Schedule = (fn) => setTimeout(fn, 0),
): Lease<T> {
  let slot: { key: string; holders: number; value: Promise<T> } | null = null;

  return {
    acquire(key, open) {
      if (slot && slot.key === key) {
        slot.holders += 1;
        return slot.value;
      }
      slot = { key, holders: 1, value: open() };
      return slot.value;
    },

    release(key, close) {
      if (!slot || slot.key !== key) return;
      slot.holders -= 1;
      const captured = slot;
      if (captured.holders > 0) return;
      schedule(() => {
        // A remount may have re-acquired the slot between the release and this
        // callback; closing then would kill a live connection.
        if (slot !== captured || captured.holders > 0) return;
        slot = null;
        void captured.value.then((value) => close(value)).catch(() => {});
      });
    },
  };
}

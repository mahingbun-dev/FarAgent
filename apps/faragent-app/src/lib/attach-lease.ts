/** Hold an attach across React StrictMode's immediate unmount/remount. */

export type Schedule = (fn: () => void) => void;

export function createAttachLease(schedule: Schedule = (fn) => setTimeout(fn, 0)) {
  let slot: { key: string; holders: number; id: Promise<number> } | null = null;

  return {
    acquire(key: string, open: () => Promise<number>): Promise<number> {
      if (slot && slot.key === key) {
        slot.holders += 1;
        return slot.id;
      }
      slot = { key, holders: 1, id: open() };
      return slot.id;
    },

    release(key: string, close: (id: number) => void) {
      if (!slot || slot.key !== key) return;
      slot.holders -= 1;
      const captured = slot;
      if (captured.holders > 0) return;
      schedule(() => {
        if (slot !== captured || captured.holders > 0) return;
        slot = null;
        void captured.id.then((id) => close(id)).catch(() => {});
      });
    },
  };
}

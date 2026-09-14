/**
 * `Channel` plumbing, shared by the mock's command groups.
 *
 * Under `mockIPC` a Tauri `Channel` reaches the handler as the object itself
 * (only a real invoke serialises it to `__CHANNEL__:<id>`), so both spellings
 * are accepted. Delivery goes through `__TAURI_INTERNALS__.runCallback`, and
 * `Channel` drops anything whose `index` is out of order — hence the counter.
 *
 * Extracted from `handlers.ts` when the helper group needed the same two
 * functions: a second copy of an ordering rule is a second chance to get the
 * ordering wrong.
 */

/** The id a `Channel` argument arrived under, or `null` if it is not one. */
export function channelId(value: unknown): number | null {
  if (typeof value === "string" && value.startsWith("__CHANNEL__:")) {
    const id = Number(value.slice("__CHANNEL__:".length));
    return Number.isInteger(id) ? id : null;
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === "number" ? id : null;
  }
  return null;
}

/** Per-channel message counter — `Channel` drops anything out of order. */
export const nextIndex = new Map<number, number>();

/**
 * Deliver one message on a channel. A no-op when no runtime is listening, which
 * is what keeps `handlers.ts` callable from a plain Node test.
 */
export function emit(id: number, message: unknown): void {
  const internals = (
    globalThis as {
      window?: {
        __TAURI_INTERNALS__?: {
          runCallback?: (id: number, data: unknown) => void;
        };
      };
    }
  ).window?.__TAURI_INTERNALS__;
  if (typeof internals?.runCallback !== "function") return;
  const index = nextIndex.get(id) ?? 0;
  nextIndex.set(id, index + 1);
  internals.runCallback(id, { index, message });
}

/** Forget a channel's counter once it is hung up. */
export function forgetChannel(id: number): void {
  nextIndex.delete(id);
}

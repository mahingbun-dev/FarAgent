/**
 * The attach, owned by the tab and shared by both of its views.
 *
 * A session tab has two views of one session — the agent's terminal and its
 * conversation (`components/chat/`) — and they are mounted **at the same time**,
 * the terminal kept invisible behind the chat so switching costs nothing. One
 * attach must back both of them, and that is not a tidiness preference:
 * `useAttach` keeps one `Channel` per key and **re-binds its `onmessage` on
 * every mount** (deliberately — see its module doc). Two calls for one tab would
 * hand the same channel two mounts, the second would replace the first's
 * `onmessage`, and the terminal would go silently deaf. There is no error and no
 * log line; the pane just stops updating.
 *
 * So the hook is called **once**, here, by whatever renders the tab's two views.
 * The two halves then take what each needs:
 *
 * - the composer takes {@link TabAttach.write} — input to the PTY, the same
 *   bytes a keystroke would produce;
 * - the terminal takes `write` and `resize` and, through {@link TabAttach.bind},
 *   supplies the things only a renderer of the bytes can know: the live size and
 *   where an event's bytes should be drawn.
 *
 * S1's two invariants survive untouched, because nothing here changes what
 * `useAttach` is called *with*: the key is still `` `${host}\0${specKey}` ``, the
 * lease is still the module-level keyed one, and the channel map is still keyed
 * by the same key. There is simply one call per tab instead of one per view —
 * which is what the key, the lease and the channel always assumed.
 */
import { useCallback, useMemo, useRef } from "react";
import type { AttachEvent, AttachSpec, Diagnosis } from "./ipc.ts";
import { useAttach, type AttachHandle, type Size } from "./use-attach.ts";

/**
 * What the terminal half supplies to the attach it shares.
 *
 * The attach cannot know any of this — it renders no terminal — so the terminal
 * registers it once and the attach reads it whenever an event arrives. Every
 * method reads the live xterm through a ref rather than capturing it, so a
 * remount of the terminal is not a remount of the attach.
 */
export interface TerminalSink {
  /** The terminal's current size, or `0×0` before it exists (the hook floors it). */
  size(): Size;
  /** One attach event, already routed: `data` bytes still need decoding. */
  event(event: AttachEvent): void;
  /** The attach opened: take focus. */
  focus(): void;
  /** The open failed with a plain message: show it where the terminal is. */
  error(message: string): void;
}

export interface TabAttach extends AttachHandle {
  /** The terminal registers here, and clears itself by binding `null`. */
  bind(sink: TerminalSink | null): void;
}

export interface TabAttachOptions {
  host: string;
  spec: AttachSpec;
  /** A connection diagnosis from the open; the tab shows it in its own dialog. */
  onDiagnosis?: (d: Diagnosis) => void;
}

/**
 * Lease the tab's one attach and hand back the handles both views use.
 *
 * Call it exactly once per tab, in the component that renders the terminal and
 * the conversation. See the module doc for why twice is a regression rather
 * than an extra connection.
 */
export function useTabAttach(options: TabAttachOptions): TabAttach {
  const sink = useRef<TerminalSink | null>(null);

  const attach = useAttach({
    host: options.host,
    spec: options.spec,
    // All three read the sink at call time, never at registration time: the
    // open resolves and events arrive after the terminal exists, and the
    // terminal's own ref is the only thing that knows where its bytes go.
    size: () => sink.current?.size(),
    onEvent: (event) => sink.current?.event(event),
    onDiagnosis: options.onDiagnosis,
    onError: (message) => sink.current?.error(message),
    onOpen: () => sink.current?.focus(),
  });

  const bind = useCallback((next: TerminalSink | null) => {
    sink.current = next;
  }, []);

  // Memoised on the pieces, which are all stable: the terminal's xterm effect
  // and the composer both read this object, and a fresh one per render would
  // make the terminal's once-only effect depend on something that changes.
  return useMemo(
    () => ({ write: attach.write, resize: attach.resize, bind }),
    [attach.write, attach.resize, bind],
  );
}

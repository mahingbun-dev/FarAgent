/**
 * The attach, without the terminal.
 *
 * A workspace tab used to own both halves of a session at once: `TerminalView`
 * opened the leased `ssh -tt` PTY stream *and* rendered its bytes with xterm.
 * Phase 3's chat view needs the first half without the second — the remote
 * agent's TUI stays the input channel and the thing that keeps the session
 * alive, but the conversation is rendered from the transcript, not from a
 * terminal. This module is that first half, lifted out of `TerminalView`
 * unchanged in behaviour:
 *
 * - the attach lease acquire/release (one ssh per key, StrictMode-safe),
 * - the per-key event channel,
 * - the pending-write queue (input typed before `attach_open` answers),
 * - resize,
 * - and a `write(data)` the caller drives.
 *
 * It is a hook, but its heart — `createAttach` — holds no React and no xterm:
 * the hook is a `useEffect` around it. That is what keeps the queue, the
 * default size and the teardown testable in a plain Node test, the way
 * `lease.ts` is, without a DOM or a renderer.
 *
 * Two invariants were paid for in blood on this branch (see the doc in
 * `lease.ts`); both are preserved here and both are the reason the two maps
 * below are keyed on the tab's key rather than being single module-level slots:
 *
 * 1. **One slot per key, and a release only closes its own.** `createAttach`
 *    hands the key to `lease.acquire`/`lease.release`, which is the keyed lease
 *    — a second tab cannot evict a first tab's slot.
 * 2. **One channel per key, re-bound on the same object.** The backend sends
 *    to the callback id a `Channel` was built with, so a remount must find the
 *    channel its attach was opened with. `createAttach` looks the channel up in
 *    `channels` (the module map, shared across mounts) and only builds one when
 *    the key has none, then re-binds `onmessage` on that one object.
 */
import { useCallback, useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { asDiagnosis, errorMessage, ipc } from "./ipc.ts";
import type { AttachEvent, AttachSpec, Diagnosis } from "./ipc.ts";
import { bytesToB64 } from "./bytes.ts";
import { createAttachLease, type Lease } from "./attach-lease.ts";

/**
 * The size an attach opens with when the caller renders no terminal.
 *
 * xterm's own default is 80×24 and `TerminalView` floors its live size the same
 * way (`Math.max(term.cols, 80)`), so a chat composer and a terminal agree on
 * what a fresh attach is worth until the first real resize. A remote agent that
 * renders at 80×24 until told otherwise is exactly what an un-fitted xterm is.
 */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export interface Size {
  cols: number;
  rows: number;
}

/**
 * The slice of `Channel<AttachEvent>` the attach actually uses: a single
 * assignable slot for the backend's callback. Structural on purpose — the core
 * never needs a Tauri runtime to be exercised, so a test hands it a plain
 * object and `TerminalView`/the hook hand it the real `Channel`.
 */
export interface AttachChannel {
  onmessage: ((event: AttachEvent) => void) | null;
}

export interface AttachSession {
  /** Input to the PTY. Queued until the attach opens; dropped once disposed. */
  write(data: string): void;
  /** Tell the remote the new size. Ignored for degenerate sizes and pre-open. */
  resize(cols: number, rows: number): void;
  /** Release this holder. The last one closes the attach on the next tick. */
  dispose(): void;
}

export interface AttachOptions<C extends AttachChannel> {
  /** The tab's identity; the lease and the channel are keyed on it. */
  key: string;
  /** The keyed lease. One slot per key; `release` closes its own. */
  lease: Lease<number>;
  /** The live channels, one per key, shared across mounts. */
  channels: Map<string, C>;
  /** Builds a channel, called only when this key has none yet. */
  makeChannel: () => C;
  /** Opens the remote attach over the given channel. */
  open(args: { cols: number; rows: number; channel: C }): Promise<number>;
  /** Raw PTY operations, b64 already applied to the write payload. */
  writePty(id: number, b64: string): void;
  resizePty(id: number, cols: number, rows: number): void;
  closePty(id: number): void;
  /**
   * The caller's current terminal size, or `undefined` when it renders none.
   * Read once when the attach opens; a smaller-than-default answer is floored.
   */
  size?: () => Size | undefined;
  /** One attach event, already routed (`data` / `exit` / `error`). */
  onEvent(event: AttachEvent): void;
  /** The open failed with a connection diagnosis. */
  onDiagnosis(d: Diagnosis): void;
  /** The open failed with a plain message (no diagnosis). */
  onError(message: string): void;
  /** The attach opened. Focus the terminal, or the composer. */
  onOpen?(): void;
}

/** The size to open at: the caller's, floored at the no-terminal default. */
function openSize(size: (() => Size | undefined) | undefined): Size {
  const s = size?.();
  return {
    cols: Math.max(s?.cols ?? 0, DEFAULT_COLS),
    rows: Math.max(s?.rows ?? 0, DEFAULT_ROWS),
  };
}

/**
 * The attach's logic, framework-free. See the module doc for the two
 * invariants; the code that enforces them is called out inline.
 */
export function createAttach<C extends AttachChannel>(
  options: AttachOptions<C>,
): AttachSession {
  const { key, lease, channels, makeChannel } = options;

  // Invariant 2, first half: look the channel up by key; build one only when
  // this key has none. A remount of the same key therefore gets the *same*
  // object the attach was opened with, which is the object the backend holds a
  // callback id for.
  let found = channels.get(key);
  if (!found) {
    found = makeChannel();
    channels.set(key, found);
  }
  const channel: C = found;

  let id: number | null = null;
  let disposed = false;
  const pending: string[] = [];
  let pendingSize: Size | null = null;

  // Invariant 2, second half: re-bind `onmessage` on that same object every
  // time. The handler is fresh per mount (it captures this mount's `disposed`),
  // and it is the *only* handler — the previous one is replaced here, never
  // left shadowed on a different channel.
  channel.onmessage = (event) => {
    if (!disposed) options.onEvent(event);
  };

  // Invariant 1: the key is the identity. `acquire` joins an existing slot (a
  // StrictMode remount) instead of opening a second one, and `release` below
  // finds *this* key's slot however many other tabs are open.
  lease
    .acquire(key, () => options.open({ ...openSize(options.size), channel }))
    .then((session) => {
      if (disposed) return;
      id = session;
      for (const data of pending) {
        options.writePty(session, bytesToB64(new TextEncoder().encode(data)));
      }
      pending.length = 0;
      // Any resize that arrived before the id did, or the size the caller
      // reports now (a terminal fitted while ssh dialled).
      const size = pendingSize ?? options.size?.();
      if (size && size.cols >= 2 && size.rows >= 2) {
        options.resizePty(session, size.cols, size.rows);
      }
      pendingSize = null;
      options.onOpen?.();
    })
    .catch((e) => {
      if (disposed) return;
      const d = asDiagnosis(e);
      if (d) options.onDiagnosis(d);
      else options.onError(errorMessage(e));
    });

  return {
    write(data) {
      if (disposed) return;
      if (id === null) {
        pending.push(data);
        return;
      }
      options.writePty(id, bytesToB64(new TextEncoder().encode(data)));
    },

    resize(cols, rows) {
      if (disposed) return;
      if (cols < 2 || rows < 2) return;
      if (id === null) {
        pendingSize = { cols, rows };
        return;
      }
      options.resizePty(id, cols, rows);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // The deferred close is the one place a channel entry is dropped and the
      // remote attach is hung up — and it is driven by *this* key's slot only.
      lease.release(key, (session) => {
        channels.delete(key);
        options.closePty(session);
      });
    },
  };
}

/** One lease for every attach, keyed by tab. */
const attachLease = createAttachLease();

/**
 * One channel per key, the lease's twin. It is module-level because a remount
 * is a *new effect*, not a new module: the channel the attach opened with has
 * to survive the effect that opened it and be found by the one that follows.
 */
const liveChannels = new Map<string, Channel<AttachEvent>>();

export interface UseAttachOptions {
  host: string;
  spec: AttachSpec;
  /**
   * The caller's live terminal size, or omitted when it renders no terminal —
   * then the attach opens at the default (80×24). Re-read on every mount.
   */
  size?: () => Size | undefined;
  /** Attach events, already routed. `data` bytes still need decoding. */
  onEvent?: (event: AttachEvent) => void;
  onDiagnosis?: (d: Diagnosis) => void;
  onError?: (message: string) => void;
  onOpen?: () => void;
}

export interface AttachHandle {
  /** Input to the PTY. Queued until the attach opens; safe to call anytime. */
  write(data: string): void;
  /** Report a new terminal size. No-op below 2×2 or once disposed. */
  resize(cols: number, rows: number): void;
}

/**
 * Lease one attach for a tab and return the handles that drive it.
 *
 * Rendering no terminal is a first-class case: with no `size`, the attach opens
 * at 80×24 and the only thing the caller must do is call `write`.
 */
export function useAttach(options: UseAttachOptions): AttachHandle {
  // Callbacks and the size getter change identity every render; the effect must
  // not re-run for that, so read the latest through a ref instead of depending
  // on them. The deps that do matter are the attach's identity: host and spec.
  const latest = useRef(options);
  latest.current = options;

  const specKey = JSON.stringify(options.spec);
  const session = useRef<AttachSession | null>(null);

  useEffect(() => {
    const attach = createAttach({
      key: `${options.host}\0${specKey}`,
      lease: attachLease,
      channels: liveChannels,
      makeChannel: () => new Channel<AttachEvent>(),
      open: ({ cols, rows, channel }) =>
        ipc.attachOpen({
          host: options.host,
          spec: JSON.parse(specKey) as AttachSpec,
          cols,
          rows,
          onEvent: channel,
        }),
      writePty: (id, b64) => {
        ipc.attachWrite(id, b64).catch(() => {});
      },
      resizePty: (id, cols, rows) => {
        ipc.attachResize(id, cols, rows).catch(() => {});
      },
      closePty: (id) => {
        ipc.attachClose(id).catch(() => {});
      },
      size: () => latest.current.size?.(),
      onEvent: (event) => latest.current.onEvent?.(event),
      onDiagnosis: (d) => latest.current.onDiagnosis?.(d),
      onError: (message) => latest.current.onError?.(message),
      onOpen: () => latest.current.onOpen?.(),
    });
    session.current = attach;
    return () => {
      session.current = null;
      attach.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.host, specKey]);

  const write = useCallback((data: string) => session.current?.write(data), []);
  const resize = useCallback(
    (cols: number, rows: number) => session.current?.resize(cols, rows),
    [],
  );

  return { write, resize };
}

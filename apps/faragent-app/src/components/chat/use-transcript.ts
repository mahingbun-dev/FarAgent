/**
 * One tail per transcript file, shared by everything on screen that reads it.
 *
 * Tailing is not a query that settles; it is a subscription with a cost. A
 * `TranscriptTail` takes a `watch.subscribe` on the transcript's directory and
 * follows it (`lib/chat/transcript.ts`), so two of them on one file are two
 * remote subscriptions for the same bytes — and worse, the remote's
 * `watch.subscribe` **dedupes by path**: the second `open` joins the first's
 * subscription id, and the first `close` then unsubscribes it out from under the
 * survivor, after which the file silently stops updating.
 *
 * So the tail lives in a module-level lease keyed by host and path
 * (`lib/panel/lease.ts`, the same mechanism the helper connection and the
 * attach use), and mount points join it rather than opening their own. Three
 * things fall out of that, and each of them is a bug that would otherwise be
 * shipped:
 *
 * 1. **StrictMode's mount → unmount → mount keeps one tail.** The first effect's
 *    cleanup drops a holder; the deferred close finds a holder again and does
 *    nothing; the second mount re-joins the same tail. This is exactly the leak
 *    shape `lib/lease.ts` was written for, one level down.
 * 2. **A remount is not a re-read.** The tail's model still holds the records,
 *    so the second mount paints the conversation immediately instead of flashing
 *    an empty pane while 256 KiB of transcript is re-read.
 * 3. **Two readers share one subscription.** Today that is one reader; the shape
 *    is what keeps the terminal-side and chat-side views of one file from
 *    fighting when there is a second.
 *
 * The listener set is a fan-out because `TranscriptTail`'s `onChange` is fixed
 * when it is constructed: the tail cannot be told about a new reader afterwards,
 * so the one callback it does hold walks a set that readers add themselves to.
 *
 * Pure React over an impure tail: no `node --test` here (there is no renderer to
 * test with, and none is being added), which is why the interesting logic —
 * framing, appending, prepending — stays in `transcript.ts` where it is tested.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { TranscriptTail, type TranscriptChannel } from "@/lib/chat/transcript";
import { createLease } from "@/lib/panel/lease";

/** A tail and everyone waiting on it. */
interface SharedTail {
  tail: TranscriptTail;
  listeners: Set<() => void>;
}

/** One tail per `host#path`, shared by every mount point. */
const lease = createLease<SharedTail>();

/**
 * Open a tail and hand back both it and the set its readers join.
 *
 * The set is created here and closed over by `onChange`, so the object the
 * lease stores and the set the callback fans out to are the same one — including
 * for a second holder, which receives this object rather than making its own.
 */
async function openShared(channel: TranscriptChannel, path: string): Promise<SharedTail> {
  const listeners = new Set<() => void>();
  const tail = await TranscriptTail.open(channel, path, {
    onChange: () => {
      for (const listener of listeners) listener();
    },
  });
  return { tail, listeners };
}

export type TranscriptStatus = "connecting" | "ready" | "error";

export interface TranscriptState {
  /** The records the tail holds, in file order. Raw: an adapter gives them meaning. */
  records: readonly unknown[];
  /**
   * The index of {@link records}'s first record, for an adapter naming an event
   * after a record that carries no id of its own.
   *
   * It is a position only in the sense the renderer needs — stable across a
   * `loadEarlier` and across appends — and it can be negative, because the
   * numbering is anchored at the tail of a file whose head is not loaded yet.
   */
  firstIndex: number;
  status: TranscriptStatus;
  /** The rejection that stopped the *initial* read; meaningful only for `status === "error"`. */
  error: unknown;
  /**
   * The rejection from the most recent {@link loadEarlier}, or `null`.
   *
   * Kept apart from {@link error} on purpose: a failure to load *older* content
   * is not a failure of the read that put this conversation on screen, and it
   * must not take that conversation away. It belongs where the action is — a
   * notice on the "load earlier" strip — which is why it is its own field rather
   * than a `status`.
   */
  earlierError: unknown;
  /** True while there are bytes before `records[0]` that `loadEarlier` can fetch. */
  hasEarlier: boolean;
  /** How many bytes are not loaded yet — the figure the "load earlier" strip names. */
  unloadedBefore: number;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  /** Dial again. The error state's retry. */
  retry: () => void;
}

const NOTHING: readonly unknown[] = [];

/**
 * The conversation in `path`, on `channel`, as a live list of records.
 *
 * `channel` is `null` until the helper connection is open; the hook stays in
 * `connecting` until it arrives, which is what lets it be called
 * unconditionally from a component that is still waiting for the connection.
 * `path` is `null` for a tab with no transcript to read; the hook then does
 * nothing at all, and the caller renders its own "there is no conversation
 * here" state.
 */
export function useTranscript(
  channel: TranscriptChannel | null,
  host: string,
  path: string | null,
): TranscriptState {
  const [records, setRecords] = useState<readonly unknown[]>(NOTHING);
  /**
   * The index of `records[0]`, carried beside the records rather than derived
   * from them because it is not a function of them: it moves only when an
   * earlier window is prepended, which is exactly what keeps the indices of the
   * records already on screen unchanged. Set in the same turn as the records it
   * describes, so React's batching commits them together.
   */
  const [firstIndex, setFirstIndex] = useState(0);
  const [status, setStatus] = useState<TranscriptStatus>("connecting");
  const [error, setError] = useState<unknown>(null);
  const [earlierError, setEarlierError] = useState<unknown>(null);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [unloadedBefore, setUnloadedBefore] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [attempt, setAttempt] = useState(0);

  /** The tail this mount is listening to, for `loadEarlier` and the cleanup. */
  const sharedRef = useRef<SharedTail | null>(null);
  /** Guards a second `loadEarlier` without making the callback depend on state. */
  const loadingRef = useRef(false);

  useEffect(() => {
    if (path === null || channel === null) {
      setRecords(NOTHING);
      setFirstIndex(0);
      setStatus("connecting");
      setError(null);
      setEarlierError(null);
      setHasEarlier(false);
      setUnloadedBefore(0);
      return;
    }

    let alive = true;
    // The attempt is part of the key for the reason the helper's is: the lease
    // caches a rejected open as readily as a resolved one, so a retry under the
    // same key would replay the failure instead of reading again.
    const key = `${host}#${path}#${attempt}`;
    setStatus("connecting");
    setError(null);
    setEarlierError(null);
    setRecords(NOTHING);
    setFirstIndex(0);
    setHasEarlier(false);
    setUnloadedBefore(0);

    /** Pull the tail's current state into React. Safe to call at any time. */
    const sync = () => {
      if (!alive) return;
      const shared = sharedRef.current;
      if (!shared) return;
      setRecords(shared.tail.records.slice());
      setFirstIndex(shared.tail.firstIndex);
      setHasEarlier(!shared.tail.complete);
      setUnloadedBefore(shared.tail.unloadedBefore);
    };
    const listener = () => sync();

    lease.acquire(key, () => openShared(channel, path)).then(
      (shared) => {
        if (!alive) return;
        sharedRef.current = shared;
        shared.listeners.add(listener);
        setStatus("ready");
        // The tail may already hold records — a remount joining a live tail, or
        // a read that landed before this effect ran.
        sync();
      },
      (rejection: unknown) => {
        if (!alive) return;
        setStatus("error");
        setError(rejection);
      },
    );

    return () => {
      alive = false;
      sharedRef.current?.listeners.delete(listener);
      sharedRef.current = null;
      lease.release(key, (shared) => {
        void shared.tail.close();
      });
    };
  }, [channel, host, path, attempt]);

  const loadEarlier = useCallback(() => {
    const shared = sharedRef.current;
    if (!shared || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingEarlier(true);
    // A second press is a retry: clear the last failure so the strip shows the
    // normal "load earlier" affordance while the read is in flight.
    setEarlierError(null);
    shared.tail
      .loadEarlier()
      .then(() => {
        setRecords(shared.tail.records.slice());
        // The one place `firstIndex` actually moves: an earlier window went in
        // front of the records already rendered, so their indices hold and only
        // this number drops.
        setFirstIndex(shared.tail.firstIndex);
        setHasEarlier(!shared.tail.complete);
        setUnloadedBefore(shared.tail.unloadedBefore);
      })
      .catch((rejection: unknown) => {
        // A failed scroll-up is reported **where the action was taken** — on the
        // "load earlier" strip — not as a whole-pane error. The earlier fix set
        // `status` to "error" here, and the view draws its error only for
        // `status === "error"`, so a failure to load *older* bytes replaced the
        // entire conversation with a blank card. A failure to load more must
        // never take away what is already on screen.
        setEarlierError(rejection);
      })
      .finally(() => {
        loadingRef.current = false;
        setLoadingEarlier(false);
      });
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    records,
    firstIndex,
    status,
    error,
    earlierError,
    hasEarlier,
    unloadedBefore,
    loadingEarlier,
    loadEarlier,
    retry,
  };
}

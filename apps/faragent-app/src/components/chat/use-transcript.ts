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
  status: TranscriptStatus;
  /** The rejection, meaningful only for `status === "error"`. */
  error: unknown;
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
  const [status, setStatus] = useState<TranscriptStatus>("connecting");
  const [error, setError] = useState<unknown>(null);
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
      setStatus("connecting");
      setError(null);
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
    setRecords(NOTHING);
    setHasEarlier(false);
    setUnloadedBefore(0);

    /** Pull the tail's current state into React. Safe to call at any time. */
    const sync = () => {
      if (!alive) return;
      const shared = sharedRef.current;
      if (!shared) return;
      setRecords(shared.tail.records.slice());
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
    shared.tail
      .loadEarlier()
      .then(() => {
        setRecords(shared.tail.records.slice());
        setHasEarlier(!shared.tail.complete);
        setUnloadedBefore(shared.tail.unloadedBefore);
      })
      .catch((rejection: unknown) => {
        // A failed scroll-up is a read that failed, and the pane says so — the
        // same words and the same retry as any other read failure. Setting only
        // `error` left `status` at "ready", and the view draws an error only for
        // `status === "error"`, so the failure was silent: the reader pressed
        // "load earlier", nothing happened, and nothing said why.
        setStatus("error");
        setError(rejection);
      })
      .finally(() => {
        loadingRef.current = false;
        setLoadingEarlier(false);
      });
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    records,
    status,
    error,
    hasEarlier,
    unloadedBefore,
    loadingEarlier,
    loadEarlier,
    retry,
  };
}

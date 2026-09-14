/**
 * The panel's helper connection.
 *
 * The three tabs read one remote, so they share one channel rather than opening
 * three. It is held in a module-level lease keyed by host, which is what keeps
 * React StrictMode's mount → unmount → mount from opening (and immediately
 * killing) an ssh child on every panel mount in `pnpm dev` — the same guard
 * `TerminalView` uses for its attach, in its generic form
 * (`lib/panel/lease.ts`).
 *
 * Two states are surfaced rather than smoothed over:
 *
 * - **The mode.** A remote on the bash fallback says so, because a panel that
 *   worked quietly while unable to do everything the native helper can would be
 *   the silent degradation `faragent_service::helper` exists to prevent.
 * - **A closed channel.** The remote helper can exit; when it does, the panel
 *   says so instead of spinning forever.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { helperFallbackNotice, openHelper, type HelperConnection } from "@/lib/helper";
import { createLease } from "@/lib/panel/lease";
import { useStore } from "@/state";

export type PanelHelperStatus = "connecting" | "open" | "closed" | "error";

export interface PanelHelperValue {
  host: string;
  status: PanelHelperStatus;
  /** Non-null once `status === "open"` or `"closed"`. */
  connection: HelperConnection | null;
  /** The rejection; only meaningful for `status === "error"`. */
  error: unknown;
  /** The fallback's bilingual sentence, or `null` on a native helper. */
  notice: string | null;
  /** Ask for a fresh channel. The error state's retry. */
  retry: () => void;
}

const PanelHelperContext = createContext<PanelHelperValue | null>(null);

/** One channel per host, held across StrictMode's immediate remount. */
const lease = createLease<HelperConnection>();

interface HelperState {
  status: PanelHelperStatus;
  connection: HelperConnection | null;
  error: unknown;
}

const CONNECTING: HelperState = { status: "connecting", connection: null, error: null };

export function PanelHelperProvider({
  host,
  children,
}: {
  host: string;
  children: ReactNode;
}) {
  const lang = useStore((s) => s.lang);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<HelperState>(CONNECTING);

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    // The attempt is part of the key on purpose: the lease caches the *promise*,
    // including a rejected one, so retrying under the same key would replay the
    // same failure instead of dialling again.
    const key = `${host}#${attempt}`;
    setState(CONNECTING);

    lease.acquire(key, () => openHelper(host)).then(
      (connection) => {
        if (!alive) return;
        setState({ status: "open", connection, error: null });
        stop = connection.onClosed(() => {
          if (alive) setState({ status: "closed", connection, error: null });
        });
      },
      (error: unknown) => {
        if (alive) setState({ status: "error", connection: null, error });
      },
    );

    return () => {
      alive = false;
      stop?.();
      lease.release(key, (connection) => {
        void connection.close();
      });
    };
  }, [host, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo<PanelHelperValue>(
    () => ({
      host,
      status: state.status,
      connection: state.connection,
      error: state.error,
      notice: state.connection
        ? helperFallbackNotice(state.connection.mode, lang)
        : null,
      retry,
    }),
    [host, state, lang, retry],
  );

  return (
    <PanelHelperContext.Provider value={value}>{children}</PanelHelperContext.Provider>
  );
}

/** The panel's helper channel. Only valid below `PanelHelperProvider`. */
export function usePanelHelper(): PanelHelperValue {
  const value = useContext(PanelHelperContext);
  if (!value) throw new Error("usePanelHelper outside PanelHelperProvider");
  return value;
}

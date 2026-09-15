/**
 * The shell's read model: which hosts exist, what the selected one looks like,
 * and which sessions it has.
 *
 * Every region of the shell asks for these through the same hooks so the query
 * keys cannot drift apart — the rail and the session launcher are two views of
 * one fetch, not two probes of the same host.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type { AgentKind } from "@/lib/ipc";
import { sessionPollInterval, type WindowActivity } from "@/lib/panel/poll";

export function useHosts() {
  return useQuery({ queryKey: ["hosts"], queryFn: ipc.listHosts });
}

/** The selected host's probe. Disabled until a host is chosen. */
export function useProbe(alias: string | null) {
  return useQuery({
    queryKey: ["probe", alias],
    queryFn: () => ipc.probeHost(alias as string),
    enabled: !!alias,
  });
}

/** What the window is doing, as the two booleans the poll's rule wants. */
function readWindowActivity(): WindowActivity {
  return {
    hidden: document.visibilityState === "hidden",
    focused: document.hasFocus(),
  };
}

/**
 * The window's visibility and focus, kept current.
 *
 * The session poll is the only consumer, and it wants plain booleans rather
 * than React Query's own focus state: the *rule* then lives in
 * `lib/panel/poll.ts` as a function of two values, which is the part worth
 * testing. React Query applies its own background check on top
 * (`refetchIntervalInBackground` is false by default), so the two agree and the
 * explicit one is the one with a test.
 *
 * A repeated event with the same two values returns the previous object, so
 * `focus`/`blur` chatter does not re-render the rail.
 */
export function useWindowActivity(): WindowActivity {
  const [activity, setActivity] = useState<WindowActivity>(readWindowActivity);

  useEffect(() => {
    const update = () =>
      setActivity((prev) => {
        const next = readWindowActivity();
        return prev.hidden === next.hidden && prev.focused === next.focused
          ? prev
          : next;
      });
    // Corrected on the first event as well as by it: a window that mounts
    // hidden (restored minimised) would otherwise poll until it was focused
    // and blurred again.
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  return activity;
}

/**
 * The selected agent's sessions on the selected host.
 *
 * Fresh every time the rail appears (`refetchOnMount: "always"` — the rail
 * unmounts and remounts with the host, and "opening the rail refreshes it" is
 * the requirement), and every 30 seconds after that.
 *
 * The interval is the fallback, and it exists for what the push channel cannot
 * cover: a session another person starts on the remote, one a scheduled task
 * starts, and a helper that died without saying so. `sessionPollInterval`
 * pauses it when the window is hidden or unfocused, so an app left open
 * overnight does not ask 2,880 times.
 */
export function useSessions(
  alias: string | null,
  agent: AgentKind,
  os: "posix" | "windows",
  enabled: boolean,
) {
  const activity = useWindowActivity();
  return useQuery({
    queryKey: ["sessions", alias, agent, os],
    queryFn: () => ipc.listSessions(alias as string, agent, os),
    enabled: !!alias && enabled,
    refetchOnMount: "always",
    refetchInterval: sessionPollInterval(activity),
  });
}

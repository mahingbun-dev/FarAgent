/**
 * The shell's read model: which hosts exist, what the selected one looks like,
 * and which sessions it has.
 *
 * Every region of the shell asks for these through the same hooks so the query
 * keys cannot drift apart — the rail and the session launcher are two views of
 * one fetch, not two probes of the same host.
 */
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type { AgentKind } from "@/lib/ipc";

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

/** The selected agent's sessions on the selected host. */
export function useSessions(
  alias: string | null,
  agent: AgentKind,
  os: "posix" | "windows",
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["sessions", alias, agent, os],
    queryFn: () => ipc.listSessions(alias as string, agent, os),
    enabled: !!alias && enabled,
  });
}

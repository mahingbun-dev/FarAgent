export const AGENTS = ["claude", "codex", "grok", "pi"] as const;
export type AgentKind = (typeof AGENTS)[number];

export const AGENT_TITLES: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  pi: "Pi",
};

export function tmuxName(agent: AgentKind, sessionId: string): string {
  const alnum = sessionId.replace(/[^A-Za-z0-9]/g, "");
  const short =
    alnum.length === 0 ? "new" : alnum.length <= 12 ? alnum : alnum.slice(-12);
  return `faragent-${agent}-${short}`;
}

/**
 * The id a tmux name carries, or `null` for a name that is not this agent's —
 * `faragent_core::agents::tmux_id_from_name`, including its legacy prefix.
 *
 * This is the *short* suffix, not the session's uuid: the name keeps twelve
 * alphanumerics of it, so a name can never give the id back whole. That
 * asymmetry is why a `(live)` row the list inferred from a name and a file row
 * named by the uuid are two ids for one session unless the two join first.
 */
export function tmuxIdFromName(agent: AgentKind, name: string): string | null {
  for (const prefix of ["faragent", "farssh"]) {
    const head = `${prefix}-${agent}-`;
    if (name.startsWith(head) && name.length > head.length) {
      return name.slice(head.length);
    }
  }
  return null;
}

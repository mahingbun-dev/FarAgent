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

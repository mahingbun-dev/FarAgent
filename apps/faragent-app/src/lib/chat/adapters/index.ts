/**
 * The per-agent adapter registry.
 *
 * The renderer asks {@link adapterFor} for the adapter that gives an agent's
 * records meaning. **An agent with no adapter returns `null`**, and `null` is a
 * real answer, not a missing one: it means the tab has no chat view and keeps
 * showing the terminal. Every agent FarAgent can launch has one today; `null` is
 * for the agent someone adds next, before its records have been measured.
 *
 * All four are registered — Claude, Codex, Grok and Pi — and each was written
 * against real transcripts rather than against what its format is remembered to
 * be. Pi is the one exception: no `~/.pi` sample could be obtained, so its
 * adapter follows the CLI's own `docs/session-format.md` and marks every shape
 * it could not measure `unverified`. That distinction is the reason those
 * markers exist, and it is worth preserving rather than tidying away.
 *
 * An agent with no adapter is left returning `null` rather than stubbed, because
 * a stub that returns `[]` would render an empty chat pane where a working
 * terminal should be. Adding one is a single entry below — the shape is chosen
 * so that entry is all it takes.
 */
import type { AgentKind } from "../../agents.ts";
import type { ChatEvent } from "../events.ts";
import { adapt as adaptClaude } from "./claude.ts";
import { adapt as adaptCodex } from "./codex.ts";
import { adapt as adaptGrok } from "./grok.ts";
import { adapt as adaptPi } from "./pi.ts";

/**
 * Turns one agent's parsed transcript records into the unified event model.
 *
 * `firstIndex` is the index of `records[0]` within its tail window
 * (`TranscriptTail.firstIndex`), and it exists for the agents whose records
 * carry no id of their own: Grok's messages have none, so an event there is
 * named after its record, and that name has to survive the window growing
 * backwards when the reader scrolls up. It is stable, not a position — it can be
 * negative — and an adapter whose records *are* addressed (Claude's `uuid`,
 * Codex's `ordinal`) has no use for it.
 */
export type ChatAdapter = (records: unknown[], firstIndex: number) => ChatEvent[];

const ADAPTERS: Partial<Record<AgentKind, ChatAdapter>> = {
  claude: adaptClaude,
  codex: adaptCodex,
  grok: adaptGrok,
  pi: adaptPi,
};

/**
 * The adapter for `agent`, or `null` when it has no chat view yet.
 *
 * `null` is what tells the caller to fall back to the terminal.
 */
export function adapterFor(agent: AgentKind): ChatAdapter | null {
  return ADAPTERS[agent] ?? null;
}

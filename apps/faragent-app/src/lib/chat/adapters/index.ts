/**
 * The per-agent adapter registry.
 *
 * The renderer asks {@link adapterFor} for the adapter that gives an agent's
 * records meaning. **An agent with no adapter returns `null`**, and `null` is a
 * real answer, not a missing one: it means the tab has no chat view and keeps
 * showing the terminal. That is the honest state of Pi today (the S0 spike
 * found no `~/.pi` sample to build against) and of every agent this model has
 * not been taught yet.
 *
 * Only Claude is registered. The spike proved Codex and Grok are renderable
 * too, but their adapters are a later task; they are left returning `null`
 * rather than stubbed, because a stub that returns `[]` would render an empty
 * chat pane where a working terminal should be. Adding one is a single entry
 * below — the shape is chosen so that entry is all it takes.
 */
import type { AgentKind } from "../../agents.ts";
import type { ChatEvent } from "../events.ts";
import { adapt as adaptClaude } from "./claude.ts";

/** Turns one agent's parsed transcript records into the unified event model. */
export type ChatAdapter = (records: unknown[]) => ChatEvent[];

const ADAPTERS: Partial<Record<AgentKind, ChatAdapter>> = {
  claude: adaptClaude,
};

/**
 * The adapter for `agent`, or `null` when it has no chat view yet.
 *
 * `null` is what tells the caller to fall back to the terminal.
 */
export function adapterFor(agent: AgentKind): ChatAdapter | null {
  return ADAPTERS[agent] ?? null;
}

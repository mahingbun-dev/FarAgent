/**
 * The composer's pure logic: what a keypress means, what bytes a message
 * becomes, and which commands a half-typed slash word could be.
 *
 * None of this needs React or a DOM, so `node --test` drives it directly. The
 * component (`components/chat/composer.tsx`) is the shallow part on top: a
 * textarea, a send button, and the wiring of these three answers.
 *
 * ## The composer writes keystrokes, not a protocol
 *
 * The remote agent's TUI is still the receiver. The composer is a second way to
 * produce the bytes a keystroke would produce, and it invents nothing: a message
 * is its text with the message's own newlines left as LF and a single **CR**
 * appended, which is exactly what xterm sends for Enter. Whether the remote
 * treats an LF inside the input as a newline is the remote TUI's business —
 * everything the app knows about it is that Enter arrives as CR.
 *
 * The same reasoning sets the key rule: **Enter sends, Shift+Enter inserts a
 * newline**. That is the convention of every chat field on the web, and it is
 * also what the remote's own TUI does, so the two ways of talking to a session
 * do not disagree about what the Return key means.
 *
 * ## The command table is static, and that is a known lie
 *
 * `COMMANDS` is a hand-written list of the slash commands Claude Code is
 * documented to take. There is no protocol for asking the remote what it
 * supports — the helper channel is filesystem and git ops, and the attach is a
 * PTY — so the list cannot be discovered and will **drift** from whatever the
 * installed CLI actually accepts. It is a completion aid, never a gate: the
 * composer sends whatever is typed, including a command the table has never
 * heard of, and a command named here that the remote has since dropped is sent
 * and rejected there, which is the remote's business and the only place that
 * can answer it.
 *
 * Keeping it per-agent (rather than one list for the app) is what stops a Codex
 * tab from offering Claude's commands; the other three agents have no table at
 * all, because none of them has a chat view yet (`lib/chat/adapters/`).
 */
import { AGENTS, type AgentKind } from "../agents.ts";

/**
 * The slash commands a Claude Code session is documented to take.
 *
 * Deliberately short: this is a completion aid offered while typing, not a
 * reference page, and a long list of half-remembered entries is worse than a
 * short one of certain ones. Sorted so the menu's order is stable and testable.
 */
const CLAUDE_COMMANDS: readonly string[] = [
  "/agents",
  "/clear",
  "/compact",
  "/config",
  "/cost",
  "/doctor",
  "/export",
  "/help",
  "/hooks",
  "/init",
  "/login",
  "/logout",
  "/mcp",
  "/memory",
  "/model",
  "/permissions",
  "/resume",
  "/review",
  "/status",
];

/**
 * The completion vocabulary of each agent, by name.
 *
 * Every agent the app knows is listed — with `[]` where there is nothing to
 * complete — so that adding an agent is a compile error here rather than a
 * silent `undefined` reaching the menu.
 */
const COMMANDS: Record<AgentKind, readonly string[]> = {
  claude: CLAUDE_COMMANDS,
  codex: [],
  grok: [],
  pi: [],
};

/** The commands to offer for `agent`; empty when the agent has none. */
export function commandsFor(agent: AgentKind): readonly string[] {
  return COMMANDS[agent] ?? [];
}

/** The agents that have a completion table — a guard against the record drifting. */
export function agentsWithCommands(): AgentKind[] {
  return AGENTS.filter((agent) => commandsFor(agent).length > 0);
}

/**
 * The word being typed after a leading `/`, or `null` when the field is not in
 * a slash command at all.
 *
 * `null` covers the three ways a completion menu must stay shut: the field does
 * not start with `/`; the reader has typed past the command name (a space means
 * arguments, and no command has one); or the field is multi-line, which is a
 * message rather than a command.
 */
export function slashQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const rest = value.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

/**
 * The commands that complete `value`, in table order, capped at `limit`.
 *
 * `"/"` alone offers the whole table — that is the moment a reader most needs
 * to be told what exists. Matching is case-insensitive prefix on the name
 * without its slash, so `/CL` finds `/clear`.
 */
export function slashMatches(
  value: string,
  commands: readonly string[],
  limit = 8,
): string[] {
  const query = slashQuery(value);
  if (query === null) return [];
  const needle = query.toLowerCase();
  return commands
    .filter((command) => command.slice(1).toLowerCase().startsWith(needle))
    .slice(0, limit);
}

/** The subset of a `KeyboardEvent` this module needs. Structural, so a test can hand it a literal. */
export interface KeyEventLike {
  key: string;
  shiftKey: boolean;
  /** True while an IME composition is being confirmed — Chrome sets it mid-composition. */
  isComposing: boolean;
}

/**
 * What one keypress means to the composer.
 *
 * - `send` — submit the message.
 * - `newline` — let the field insert a line break (`preventDefault` must *not*
 *   be called, which is the whole reason this is a named outcome rather than a
 *   boolean: the caller has to be told to keep its hands off the event).
 * - `none` — not a key this module has an opinion about.
 *
 * An Enter that is confirming an IME candidate is `none`: for a reader typing
 * Chinese, the Return that commits 好 is not a message. Getting this wrong sends
 * a half-composed sentence, which is the bug every chat field that skipped the
 * check ships with.
 */
export function composerAction(event: KeyEventLike): "send" | "newline" | "none" {
  if (event.key !== "Enter") return "none";
  if (event.isComposing) return "none";
  return event.shiftKey ? "newline" : "send";
}

/**
 * The bytes a message becomes on the wire: its text, then Enter.
 *
 * CR and CRLF inside the text are normalised to LF first, so a message pasted
 * from Windows does not carry a stray CR that the remote would read as an extra
 * Return — a stray CR would submit the message early, mid-sentence. The final
 * CR is the one Enter, and it is the only one.
 */
export function encodeSend(text: string): string {
  return text.replace(/\r\n?/g, "\n") + "\r";
}

/**
 * The unified event model a conversation is rendered from.
 *
 * Every agent writes its transcript in its own JSON (the S0 spike measured
 * Claude, Codex and Grok and found three unrelated shapes). A renderer that
 * understood all of them would be a renderer per agent; instead each agent gets
 * an **adapter** (`chat/adapters/`) that turns its records into this one model,
 * and the renderer draws the model and nothing else.
 *
 * The model is deliberately thin. It carries the *material* of a turn — prose,
 * reasoning, a tool call and its result — and stops there. What a Markdown
 * string looks like, whether a diff is split, how a tool result is truncated:
 * all of that is how to **show** an event, and it belongs to the renderer, not
 * here. Nothing in this module imports React, a highlighter or a diff parser.
 *
 * Three event kinds are what the reference UI actually draws:
 *
 * - {@link MessageEvent} — a user or assistant turn's prose;
 * - {@link ThinkingEvent} — the model's reasoning, which the renderer collapses;
 * - {@link ToolEvent} — a tool call and, once it exists, its result.
 *
 * A tool call and its result are **one** event by construction. The result
 * arrives in a later record of its own, so the adapter pairs them and fills
 * {@link ToolEvent.result} in place; the renderer sees one row that gains its
 * result rather than two rows it has to reconcile.
 */

/** Any event the renderer draws. Discriminate on {@link ChatEvent.kind}. */
export type ChatEvent = MessageEvent | ThinkingEvent | ToolEvent;

/** What every event carries, whatever its kind. */
export interface EventBase {
  /**
   * Stable identity within one conversation, for a list key. Unique across
   * events of every kind, so a renderer may key a flat list on it.
   */
  id: string;
  /**
   * True when the record came from a **subagent** conversation rather than the
   * session's own (`isSidechain` on a Claude record). The renderer decides what
   * to do with it — nest it under the turn that spawned it, or hide it — but it
   * cannot decide that unless the flag survives the adapter, so it does.
   */
  sidechain: boolean;
  /** The record's `timestamp` (ISO-8601), or `null` when the record had none. */
  timestamp: string | null;
}

/** A user or assistant turn's prose, as Markdown. */
export interface MessageEvent extends EventBase {
  kind: "message";
  role: "user" | "assistant";
  /** The turn's text. Markdown, but only because the source is — never rendered here. */
  markdown: string;
}

/** The model's reasoning. The renderer shows this collapsed by default. */
export interface ThinkingEvent extends EventBase {
  kind: "thinking";
  /** The reasoning text. */
  markdown: string;
}

/** A tool call, and its result once that has arrived. */
export interface ToolEvent extends EventBase {
  kind: "tool";
  /** The tool's name, e.g. `Bash` or `Read`. */
  name: string;
  /**
   * The arguments the model supplied, verbatim (`tool_use.input`). Kept as the
   * adapter found it: its shape is the tool's, not the model's, and a renderer
   * that wants to describe a call (a `command`, a `file_path`) reads the key it
   * knows rather than a shape this model guessed at.
   */
  input: unknown;
  /**
   * The result, or `null` while there is none yet.
   *
   * `null` is the **normal live case**, not an error: the agent is still running
   * the tool and has not written its result record. A renderer draws the row
   * either way and shows the result when it lands.
   */
  result: ToolResult | null;
}

/** A tool call's result, as the transcript reported it. */
export interface ToolResult {
  /**
   * The result's text, flattened to a string. A result is a string in the
   * transcript's usual spelling but may be a block array; the adapter joins the
   * text of those blocks so the renderer does not have to.
   */
  content: string;
  /** True when the tool failed (`tool_result.is_error`). */
  isError: boolean;
}

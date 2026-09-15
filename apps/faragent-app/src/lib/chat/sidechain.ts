/**
 * Turning a flat event list into the rows the conversation draws.
 *
 * The adapter emits one array in file order, and the file is flat: a subagent's
 * turns sit in it exactly like the main thread's, distinguished only by
 * `EventBase.sidechain`. Rendering that array directly would splice a
 * subagent's reasoning into the middle of the conversation as though the main
 * agent had said it — the one outcome the brief rules out ("do not mix into the
 * main thread silently"). This module is the fold that stops that happening: it
 * splits the flat list into the main thread and its subagent blocks, and groups
 * each thread's consecutive tool calls into one row.
 *
 * ## Two groupings, one pass
 *
 * - **Sidechain.** A maximal run of events sharing the `sidechain` flag becomes
 *   either main-thread rows or one nested block. Maximal runs rather than
 *   "remember the last subagent" because the model has no subagent identity —
 *   there is a boolean and nothing else — so any claim that two separated runs
 *   were the same agent would be invented. They are drawn as two blocks.
 * - **Tool runs.** Consecutive tool calls inside one thread become one row,
 *   which is what lets twelve calls read as a sentence.
 *
 * Nothing here is recursive: a sidechain block's contents come from the same
 * two rules applied to a run whose events are all sidechain, so the inner rows
 * are messages, thinking and tool runs — there is no second level to nest, and
 * no way for the fold to fail to terminate.
 *
 * Pure: `node --test` drives it with hand-built events.
 */
import type { ChatEvent, MessageEvent, ThinkingEvent, ToolEvent } from "./events.ts";

/** One row of the conversation. */
export type ChatItem =
  | { kind: "event"; id: string; event: MessageEvent | ThinkingEvent }
  | { kind: "tools"; id: string; events: ToolEvent[] }
  | { kind: "sidechain"; id: string; items: ChatItem[] };

/**
 * Group the events of a single thread: consecutive tool calls collapse, and
 * everything else is a row of its own.
 *
 * The run's id is its **first** call's, so a row keeps its identity as more
 * calls arrive — a virtualised list keyed by position would otherwise remount
 * every row below a growing run.
 */
function groupThread(events: readonly ChatEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  let run: ToolEvent[] = [];

  const flush = () => {
    if (run.length === 0) return;
    items.push({ kind: "tools", id: `tools:${run[0].id}`, events: run });
    run = [];
  };

  for (const event of events) {
    if (event.kind === "tool") {
      run.push(event);
      continue;
    }
    flush();
    items.push({ kind: "event", id: event.id, event });
  }
  flush();
  return items;
}

/**
 * Fold a flat transcript into rows.
 *
 * Order is preserved exactly: the rows are the events, regrouped and nothing
 * else. A transcript with no sidechain events — every session that never used a
 * subagent — comes back as one thread with its tool calls collapsed and no
 * nesting, which is the whole of the behaviour for the common case.
 */
export function groupEvents(events: readonly ChatEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  let thread: ChatEvent[] = [];
  /** The flag the buffered run belongs to; `null` before the first event. */
  let sidechain: boolean | null = null;

  const flush = () => {
    if (thread.length === 0) return;
    if (sidechain === true) {
      items.push({
        kind: "sidechain",
        id: `side:${thread[0].id}`,
        items: groupThread(thread),
      });
    } else {
      items.push(...groupThread(thread));
    }
    thread = [];
  };

  for (const event of events) {
    const flag = event.sidechain === true;
    if (sidechain !== null && flag !== sidechain) flush();
    sidechain = flag;
    thread.push(event);
  }
  flush();
  return items;
}

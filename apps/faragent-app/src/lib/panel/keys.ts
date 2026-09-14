/**
 * The panel's query keys, spelled in one place.
 *
 * They used to be spelled inside `components/panel/queries.ts`, which was fine
 * while the hooks were the only thing that named them. Task 11 added a second
 * namer: `lib/panel/watch.ts` invalidates a *prefix* of these keys when the
 * remote pushes a change, and a prefix that drifts from the key it is meant to
 * match fails silently — the invalidation is a no-op and the panel simply never
 * refreshes, which is exactly the bug this task exists to fix. So the shape
 * lives here, in a module with no React and no imports, and both sides call it.
 *
 * The connection id is part of every key, not just the host: a channel that
 * closed and reopened is a different remote process, and a cache spanning the
 * two would show a tree that no longer exists.
 */

/** What may appear in a key part: the three shapes the hooks actually pass. */
export type KeyPart = string | number | boolean;

/** The namespace every panel query is under. Also the "everything" prefix. */
export const PANEL_ROOT = "panel";

/** One panel query key: `["panel", connectionId, name, ...rest]`. */
export function panelKey(
  connectionId: number,
  name: string,
  ...rest: KeyPart[]
): KeyPart[] {
  return [PANEL_ROOT, connectionId, name, ...rest];
}

/** The panel query names, as the hooks and the invalidation scope both use them. */
export const PANEL_QUERIES = [
  "list",
  "stat",
  "read",
  "discover",
  "status",
  "branches",
  "diff",
  "log",
] as const;

export type PanelQueryName = (typeof PANEL_QUERIES)[number];

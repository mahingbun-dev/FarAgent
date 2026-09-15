/**
 * How the rail turns a flat session list into workspaces.
 *
 * Pure, and deliberately separate from the components: the rail's data arrives
 * over SSH, so this is the half of it that can be verified without a host.
 */
import type { Session } from "@/lib/ipc";

/** Sessions the rail shows before it offers "show more". */
export const SESSION_PAGE = 20;

export interface WorkspaceGroup {
  /** The working directory the group shares; `null` for sessions that have none. */
  cwd: string | null;
  sessions: Session[];
}

/**
 * The last segment of a workspace path — what the rail's group header shows,
 * with the whole path kept for the hover title.
 *
 * Both dialects reach here: a session's `cwd` comes from the remote, and a
 * Windows remote reports `C:\Users\me\app`. This deliberately does *not* reuse
 * `@/lib/panel/paths.ts`'s `basename`, which normalises to a POSIX root before
 * splitting and would hand back a `/`-prefixed path the remote never named.
 *
 * A root is returned whole (`/`, `C:`): it has no last segment, and an empty
 * label would leave the group header blank.
 */
export function lastPathSegment(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed === "") return path;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1) || trimmed;
}

/**
 * True when the rail has groups and every one of them is collapsed — the state
 * the one-click control offers to reverse.
 *
 * An empty list is not "all collapsed": there is nothing to expand, so the
 * caller can use this to decide whether the control is worth rendering.
 */
export function allCollapsed(
  keys: string[],
  collapsed: Record<string, boolean>,
): boolean {
  return keys.length > 0 && keys.every((key) => collapsed[key] === true);
}

/**
 * The record that sets every key at once, for the one-click collapse/expand.
 *
 * Rebuilt rather than merged, so keys from a previous fetch or a different host
 * do not linger and silently decide a later toggle.
 */
export function setGroupsCollapsed(
  keys: string[],
  collapsed: boolean,
): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, collapsed]));
}

/** Newest first; `id` breaks ties so the rail's order is stable across fetches. */
function byRecency(a: Session, b: Session): number {
  return b.mtime - a.mtime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort(byRecency);
}

/**
 * Bucket sessions by working directory. Group order follows the newest session
 * in each group, so the rail surfaces the workspace you touched last.
 */
export function groupByWorkspace(sessions: Session[]): WorkspaceGroup[] {
  const buckets = new Map<string | null, Session[]>();
  for (const session of sortSessions(sessions)) {
    const cwd = session.cwd?.trim() || null;
    const bucket = buckets.get(cwd);
    if (bucket) bucket.push(session);
    else buckets.set(cwd, [session]);
  }
  return [...buckets].map(([cwd, list]) => ({ cwd, sessions: list }));
}

/**
 * Trim groups to `limit` sessions in total, dropping groups that empty out.
 * `hidden` is what the "show more" affordance is offering.
 */
export function budgetGroups(
  groups: WorkspaceGroup[],
  limit: number,
): { groups: WorkspaceGroup[]; hidden: number } {
  const total = groups.reduce((n, g) => n + g.sessions.length, 0);
  const visible: WorkspaceGroup[] = [];
  let left = Math.max(limit, 0);
  for (const group of groups) {
    if (left <= 0) break;
    const take = Math.min(left, group.sessions.length);
    visible.push({ cwd: group.cwd, sessions: group.sessions.slice(0, take) });
    left -= take;
  }
  const shown = visible.reduce((n, g) => n + g.sessions.length, 0);
  return { groups: visible, hidden: total - shown };
}

/**
 * The panel's reads, as TanStack Query hooks.
 *
 * Every key includes the connection's own id, not just the host: a channel that
 * closed and reopened is a different remote process, and a cache that spanned
 * the two would show a tree that no longer exists.
 *
 * They are all `retry: false` on purpose. The helper's failures are answers —
 * `not_found`, `not_a_dir`, `not_a_repo` — and retrying an answer three times
 * with backoff only delays the sentence the user needs to read.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { panelKey, type KeyPart } from "@/lib/panel/keys";
import type { HelperConnection } from "@/lib/helper";

/** How many commits one `git.log` page asks for. */
export const LOG_PAGE = 50;

/**
 * A hook's key, from the connection it reads.
 *
 * The shape itself lives in `lib/panel/keys.ts` rather than here, because
 * `lib/panel/watch.ts` invalidates prefixes of these keys from a push and the
 * two spellings must not be able to drift.
 */
function key(connection: HelperConnection | null, name: string, ...rest: KeyPart[]) {
  return panelKey(connection?.id ?? 0, name, ...rest);
}

export function usePanelList(connection: HelperConnection | null, path: string) {
  return useQuery({
    queryKey: key(connection, "list", path),
    queryFn: () => (connection as HelperConnection).listDir(path),
    enabled: connection !== null && path !== "",
    retry: false,
  });
}

export function usePanelStat(connection: HelperConnection | null, path: string) {
  return useQuery({
    queryKey: key(connection, "stat", path),
    queryFn: () => (connection as HelperConnection).stat(path),
    enabled: connection !== null && path !== "",
    retry: false,
  });
}

/**
 * A file's bytes, or the window of them the caller asked for.
 *
 * `limit` is part of the cache key: a 256 KiB read and a 1 MiB one are different
 * answers to the same path, and a key that ignored it would serve the fragment
 * to the second caller. Omitted, the helper applies its own 256 KiB default.
 */
export function usePanelRead(
  connection: HelperConnection | null,
  path: string,
  limit?: number,
) {
  return useQuery({
    queryKey: key(connection, "read", path, limit ?? 0),
    queryFn: () =>
      (connection as HelperConnection).readFile(
        path,
        limit === undefined ? {} : { limit },
      ),
    enabled: connection !== null && path !== "",
    retry: false,
  });
}

export function usePanelDiscover(connection: HelperConnection | null, root: string) {
  return useQuery({
    queryKey: key(connection, "discover", root),
    queryFn: () => (connection as HelperConnection).discoverGit(root),
    enabled: connection !== null && root !== "",
    retry: false,
  });
}

export function usePanelGitStatus(connection: HelperConnection | null, root: string) {
  return useQuery({
    queryKey: key(connection, "status", root),
    queryFn: () => (connection as HelperConnection).gitStatus(root),
    enabled: connection !== null && root !== "",
    retry: false,
  });
}

/**
 * The branch list.
 *
 * `enabled` is the caller's, because the bash fallback does not speak
 * `git.branches`: asking anyway costs a round trip whose only possible answer is
 * `unknown op`, and the panel already knows that before it asks
 * (`lib/panel/capabilities.ts`).
 */
export function usePanelGitBranches(
  connection: HelperConnection | null,
  root: string,
  enabled = true,
) {
  return useQuery({
    queryKey: key(connection, "branches", root),
    queryFn: () => (connection as HelperConnection).gitBranches(root),
    enabled: connection !== null && root !== "" && enabled,
    retry: false,
  });
}

/**
 * One file's patch. Always per file, never the whole repository: a repository
 * diff is the request the remote may answer with `files_only`, and the panel
 * would then have to ask again anyway.
 */
export function usePanelGitDiff(
  connection: HelperConnection | null,
  root: string,
  path: string,
  staged: boolean,
  enabled = true,
) {
  return useQuery({
    queryKey: key(connection, "diff", root, path, staged),
    queryFn: () =>
      (connection as HelperConnection).gitDiff(root, { path, staged }),
    enabled: connection !== null && root !== "" && path !== "" && enabled,
    retry: false,
  });
}

export function usePanelGitLog(connection: HelperConnection | null, root: string) {
  return useInfiniteQuery({
    queryKey: key(connection, "log", root),
    queryFn: ({ pageParam }) =>
      (connection as HelperConnection).gitLog(root, {
        limit: LOG_PAGE,
        skip: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.truncated ? pages.length * LOG_PAGE : undefined),
    enabled: connection !== null && root !== "",
    retry: false,
  });
}

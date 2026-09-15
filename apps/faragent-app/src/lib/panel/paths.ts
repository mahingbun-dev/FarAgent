/**
 * Path arithmetic for the panel.
 *
 * The panel works in POSIX paths on purpose: the helper channel speaks one
 * path dialect to every host (`faragent_helper::ops::fs` normalises on the
 * remote side the same way `src/lib/mock/helper.ts` does), and the two places
 * that must agree here — the tree's parent links and the git root that
 * `git.discover` walks up to — are both built from these functions. A Windows
 * remote is served by the helper's own `\\` handling on the far side; what the
 * panel receives is already the path the remote resolved.
 *
 * Pure: no DOM, no imports, so `node --test` runs it directly.
 */

/**
 * Collapse `.` and `..` segments and duplicate slashes; always rooted.
 *
 * `""` normalises to `/` rather than to a path-less string, because every
 * consumer here (the tree root, the git root) has to name *something*, and a
 * silently empty path is the shape that turns into an `undefined` request.
 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

/** The `..` of `path`. The root's parent is itself — there is no `..` above it. */
export function parentPath(path: string): string {
  const at = normalizePath(path);
  if (at === "/") return "/";
  const cut = at.lastIndexOf("/");
  return cut <= 0 ? "/" : at.slice(0, cut);
}

/**
 * Append a name to a directory. An absolute `name` wins outright: that is what
 * makes the caller's "type a new root" path the same code as the tree's.
 */
export function joinPath(base: string, name: string): string {
  if (name === "") return normalizePath(base);
  if (name.startsWith("/")) return normalizePath(name);
  const at = normalizePath(base);
  return normalizePath(at === "/" ? "/" + name : at + "/" + name);
}

/** The last segment; `/` for the root (it has none). */
export function basename(path: string): string {
  const at = normalizePath(path);
  if (at === "/") return "/";
  return at.slice(at.lastIndexOf("/") + 1);
}

/** True for the filesystem root. */
export function isRoot(path: string): boolean {
  return normalizePath(path) === "/";
}

/**
 * Every ancestor of `path`, outermost first and excluding `path` itself:
 * `/srv/app/x` → `["/", "/srv", "/srv/app"]`.
 *
 * Used to reveal a file's directory chain when the tree is told to jump
 * somewhere concrete rather than to the root.
 */
export function ancestors(path: string): string[] {
  const start = normalizePath(path);
  // The root has no ancestors; every other path's chain ends at the root.
  if (start === "/") return [];
  const out: string[] = [];
  let at = parentPath(start);
  for (;;) {
    out.unshift(at);
    if (at === "/") break;
    at = parentPath(at);
  }
  return out;
}

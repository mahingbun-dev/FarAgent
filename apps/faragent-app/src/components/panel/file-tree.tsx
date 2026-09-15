/**
 * The file tree: one directory's children at a time, fetched when it is
 * expanded and never before.
 *
 * Laziness is structural rather than a policy: `DirChildren` mounts, asks for
 * its own path, and mounts nothing below itself until a row is clicked. A tree
 * of the remote's `/` therefore costs one `fs.list` — there is no walk, no
 * prefetch and no background crawl, and the component has no code path that
 * could start one.
 *
 * Two limits are the remote's, not this file's, and both are shown rather than
 * swallowed: `fs.list` caps at 500 entries (`truncated`) and this renders 100
 * rows at a time behind a "show more" row. The full 620-directory fixture is
 * what that looks like in practice.
 *
 * Symlinks are listed as themselves and open in the preview rather than being
 * expanded: `fs.list` reports the link's own kind, and resolving where it points
 * would cost a round trip per row to answer a question the user did not ask.
 */
import { useState } from "react";
import { ChevronRight, File as FileIcon, Folder, FolderOpen } from "lucide-react";
import { Spinner } from "@/components/ui/empty";
import { usePanelList } from "@/components/panel/queries";
import { usePanelHelper } from "@/components/panel/helper-context";
import { decodeText, helperErrorText } from "@/lib/helper";
import { isRoot, joinPath, parentPath } from "@/lib/panel/paths";
import { cn } from "@/lib/utils";
import { useStore, useT } from "@/state";

/** Rows rendered per directory before a "show more" row. */
export const TREE_PAGE_SIZE = 100;

interface TreeProps {
  root: string;
  selected: string | null;
  onSelect: (path: string) => void;
  onRootChange: (path: string) => void;
}

export function FileTree({ root, selected, onSelect, onRootChange }: TreeProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {!isRoot(root) ? (
        <button
          type="button"
          onClick={() => onRootChange(parentPath(root))}
          title={parentPath(root)}
          className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs hover:bg-surface-hover"
        >
          <span className="w-3 shrink-0" />
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">..</span>
        </button>
      ) : null}
      <DirChildren
        path={root}
        depth={0}
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}

function DirChildren({
  path,
  depth,
  selected,
  onSelect,
}: {
  path: string;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const { connection } = usePanelHelper();
  const list = usePanelList(connection, path);
  const [shown, setShown] = useState(TREE_PAGE_SIZE);

  if (!connection || list.isLoading) return <Spinner label={t("file.loading")} />;

  if (list.error) {
    return (
      <p className="px-2 py-1 text-xs text-danger">
        {t("tree.error", { message: helperErrorText(list.error, lang) })}
      </p>
    );
  }

  const entries = list.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <p
        className="px-2 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {t("tree.empty")}
      </p>
    );
  }

  const visible = entries.slice(0, shown);

  return (
    <>
      {visible.map((entry) => {
        const name = decodeText(entry.name);
        const child = joinPath(path, name);
        return entry.kind === "dir" ? (
          <TreeDir
            key={child}
            path={child}
            name={name}
            depth={depth}
            selected={selected}
            onSelect={onSelect}
          />
        ) : (
          <button
            key={child}
            type="button"
            onClick={() => onSelect(child)}
            title={child}
            className={cn(
              "flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-xs hover:bg-surface-hover",
              selected === child && "bg-surface-selected",
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            <span className="w-3 shrink-0" />
            <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {entry.isSymlink ? (
              <span className="shrink-0 text-muted-foreground">@</span>
            ) : null}
          </button>
        );
      })}

      {entries.length > shown ? (
        <button
          type="button"
          onClick={() => setShown((n) => n + TREE_PAGE_SIZE)}
          className="w-full py-1 text-left text-xs text-link hover:bg-surface-hover"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {t("tree.showMore", { count: Math.min(TREE_PAGE_SIZE, entries.length - shown) })}
        </button>
      ) : null}

      {list.data?.truncated ? (
        <p
          className="px-2 py-1 text-xs text-warning"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {t("tree.truncated", { count: entries.length })}
        </p>
      ) : null}
    </>
  );
}

function TreeDir({
  path,
  name,
  depth,
  selected,
  onSelect,
}: {
  path: string;
  name: string;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // Plain `title`, not `Tooltip`: the tooltip primitive does not portal,
        // and a floating layer inside this scroll container would be clipped.
        title={path}
        aria-expanded={open}
        aria-label={open ? t("tree.collapse", { name }) : t("tree.open", { name })}
        className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-xs hover:bg-surface-hover"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {open ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-link" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      {open ? (
        <DirChildren
          path={path}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
        />
      ) : null}
    </>
  );
}

/**
 * One changed file, expandable to its own patch.
 *
 * Shared by the Changes tab (grouped by staged/unstaged) and the Git tab (the
 * repository's own file list) so the two cannot drift into showing different
 * things about the same file.
 *
 * The patch is fetched when the row is first opened and not before — the
 * `enabled` flag on `usePanelGitDiff` is the whole mechanism, and it is what
 * keeps a 600-file change set to one request until somebody asks for more.
 *
 * What comes back is capped twice before it is rendered: `sliceDiff` bounds the
 * rows one patch may mount, and past `HIGHLIGHT_MAX_CHARS` the rows are shown
 * without syntax colouring. Neither is silent — the truncation notice is
 * rendered under the rows, outside the horizontal scroller.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Spinner } from "@/components/ui/empty";
import { DiffFileView, FileStatusBadge } from "@/components/panel/diff-view";
import { usePanelGitDiff } from "@/components/panel/queries";
import { usePanelHelper } from "@/components/panel/helper-context";
import { decodeText, helperErrorText, type GitStatusFile } from "@/lib/helper";
import { parseUnifiedDiff, sliceDiff } from "@/lib/panel/diff";
import { HIGHLIGHT_MAX_CHARS } from "@/lib/panel/file";
import { languageForPath } from "@/lib/panel/highlight";
import { cn } from "@/lib/utils";
import { useStore, useT } from "@/state";

export function ChangeRow({ file, repo }: { file: GitStatusFile; repo: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const { connection } = usePanelHelper();
  const [open, setOpen] = useState(false);
  const path = decodeText(file.path);
  const patch = usePanelGitDiff(connection, repo, path, file.staged, open);

  const parsed = patch.data?.diff ? decodeText(patch.data.diff) : "";
  // Sliced before it is rendered, not after: one file's patch can hold six
  // figures of rows, and every row that reaches the DOM is a row the
  // highlighter scans and React mounts.
  const slice = sliceDiff(parseUnifiedDiff(parsed));
  // Above this the scanner is what would make the panel feel slow, so the rows
  // are shown as plain text — the file preview's own rule, applied to a patch.
  // The rows themselves are still shown.
  const highlight = parsed.length <= HIGHLIGHT_MAX_CHARS;

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? t("changes.hideDiff") : t("changes.showDiff")}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-surface-hover",
          open && "bg-surface-selected",
        )}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {file.origPath ? (
            <>
              <span className="text-muted-foreground">
                {decodeText(file.origPath)} →{" "}
              </span>
              {path}
            </>
          ) : (
            path
          )}
        </span>
        <span className="shrink-0 font-mono text-micro text-muted-foreground">
          {file.index}
          {file.worktree}
        </span>
        <FileStatusBadge status={file.status} />
      </button>

      {open ? (
        patch.isLoading ? (
          <Spinner label={t("file.loading")} />
        ) : patch.error ? (
          <p className="px-2 py-1 text-xs text-danger">
            {t("git.error", { message: helperErrorText(patch.error, lang) })}
          </p>
        ) : slice.files.length > 0 ? (
          <div className="pb-1">
            <div className="overflow-x-auto">
              <div className="min-w-fit">
                {slice.files.map((diffFile, i) => (
                  <DiffFileView
                    key={i}
                    file={diffFile}
                    language={
                      highlight ? languageForPath(diffFile.path || path) : "plain"
                    }
                  />
                ))}
              </div>
            </div>
            {/* Outside the scroller on purpose: a truncation notice that can be
                scrolled out of sight is a notice the reader may never see. */}
            {slice.truncated ? (
              <p className="border-t border-border px-2 py-1 text-xs text-warning">
                {t("changes.diffTruncated", {
                  lines: slice.shown,
                  total: slice.total,
                })}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            {patch.data?.binary ? t("changes.binaryDiff") : t("changes.noDiff")}
          </p>
        )
      ) : null}
    </div>
  );
}

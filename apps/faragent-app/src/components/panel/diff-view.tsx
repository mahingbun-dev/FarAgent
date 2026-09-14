/**
 * The diff view: one parsed `DiffFile` as rows.
 *
 * Read-only by construction — there is no input, no selection to act on and no
 * button anywhere near it. The only thing this renders that is not in the patch
 * is the colour.
 *
 * Line numbers come from the parse (`oldNo` / `newNo`), not from counting rows,
 * which is what makes a deletion and the line opposite it line up in the
 * gutter.
 */
import { Badge } from "@/components/ui/badge";
import { CodeText } from "@/components/panel/code";
import type { DiffFile, DiffFileStatus, DiffLine } from "@/lib/panel/diff";
import { cn } from "@/lib/utils";
import { useT } from "@/state";

/** The pill a status is shown as, in both the lists and a file header. */
export function FileStatusBadge({ status }: { status: DiffFileStatus }) {
  const t = useT();
  const variant =
    status === "added"
      ? "success"
      : status === "deleted" || status === "conflicted"
        ? "danger"
        : status === "renamed" || status === "copied" || status === "typechange"
          ? "warning"
          : status === "untracked"
            ? "outline"
            : "default";
  return (
    <Badge variant={variant} className="shrink-0">
      {t(`status.${status}`)}
    </Badge>
  );
}

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  add: "bg-success/10",
  del: "bg-danger/10",
  context: "",
  meta: "",
};

const MARKER: Record<DiffLine["kind"], string> = {
  add: "+",
  del: "-",
  context: " ",
  meta: "\\",
};

const MARKER_CLASS: Record<DiffLine["kind"], string> = {
  add: "text-success",
  del: "text-danger",
  context: "text-transparent",
  meta: "text-muted-foreground",
};

/** One changed line, with both gutters and the marker git itself would print. */
function Row({ line, language }: { line: DiffLine; language: string }) {
  return (
    <div className={cn("flex", LINE_CLASS[line.kind])}>
      <span className="w-9 shrink-0 select-none pr-1 text-right text-muted-foreground/50 tabular-nums">
        {line.oldNo ?? ""}
      </span>
      <span className="w-9 shrink-0 select-none pr-2 text-right text-muted-foreground/50 tabular-nums">
        {line.newNo ?? ""}
      </span>
      <span className={cn("w-3 shrink-0 select-none", MARKER_CLASS[line.kind])}>
        {MARKER[line.kind]}
      </span>
      <span
        className={cn(
          "whitespace-pre",
          line.kind === "meta" && "text-muted-foreground italic",
        )}
      >
        {line.kind === "meta" ? (
          line.text
        ) : (
          <CodeText text={line.text} language={language} />
        )}
      </span>
    </div>
  );
}

/**
 * One file's patch. `language` is the file's language for the highlighter (see
 * `languageForPath`); a `meta` line is printed as git wrote it rather than
 * scanned, because `\ No newline at end of file` is prose, not code.
 */
export function DiffFileView({
  file,
  language,
  note,
}: {
  file: DiffFile;
  language: string;
  /** Shown instead of a body when there is none; `binary` is already handled. */
  note?: string;
}) {
  const t = useT();
  const hasBody = !file.binary && file.hunks.length > 0;

  return (
    <div className="border-t border-border first:border-t-0">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {/* `oldPath` is git's *pre-image* path, which for a plain modification
              is the same name — an arrow there would read as a rename that did
              not happen. It is only worth showing when the name changed. */}
          {file.oldPath && file.oldPath !== file.path ? (
            <>
              <span className="text-muted-foreground">{file.oldPath} → </span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        {file.added > 0 ? (
          <span className="shrink-0 font-mono text-micro text-success">
            +{file.added}
          </span>
        ) : null}
        {file.removed > 0 ? (
          <span className="shrink-0 font-mono text-micro text-danger">
            -{file.removed}
          </span>
        ) : null}
      </div>

      {file.binary ? (
        <p className="px-2 pb-2 text-xs text-muted-foreground">
          {t("changes.binaryDiff")}
        </p>
      ) : hasBody ? (
        <div className="overflow-x-auto pb-1">
          <div className="min-w-fit font-mono text-xs leading-5">
            {file.hunks.map((hunk, hi) => (
              <div key={hi}>
                <div className="select-none bg-surface-raised px-2 py-0.5 text-muted-foreground">
                  {hunk.header}
                </div>
                {hunk.lines.map((line, li) => (
                  <Row key={li} line={line} language={language} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="px-2 pb-2 text-xs text-muted-foreground">
          {note ?? t("changes.noDiff")}
        </p>
      )}
    </div>
  );
}

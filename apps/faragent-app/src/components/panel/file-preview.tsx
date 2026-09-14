/**
 * The file preview: read-only, capped, and honest about what it did not show.
 *
 * Three rules, all from the brief, all enforced here rather than by convention:
 *
 * 1. **Nothing can write this file.** There is no textarea, no contenteditable,
 *    no save button and no key handler — the only thing rendered from the file's
 *    bytes is a `<span>` per token. There is no code path from this component to
 *    `fs.write`, because no such op exists in the protocol the panel speaks.
 * 2. **1 MiB is decided before the read, not after.** `fs.stat` gives the size,
 *    and a file over `PREVIEW_MAX_BYTES` renders its size and stops — the bytes
 *    are never requested, so a 200 MiB file costs one syscall on the remote
 *    instead of a channel full of base64.
 * 3. **Binary never reaches the DOM.** The helper refuses to send a file whose
 *    head carries a NUL (`binary`), and this checks the bytes it *did* get for
 *    the same thing, because a remote that sent them is exactly the remote whose
 *    refusal cannot be relied on. Either way the answer is a placeholder.
 */
import { FileWarning, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Empty, Spinner } from "@/components/ui/empty";
import { CodeBlock } from "@/components/panel/code";
import { usePanelRead, usePanelStat } from "@/components/panel/queries";
import { usePanelHelper } from "@/components/panel/helper-context";
import { decodeText, helperErrorText, HelperError } from "@/lib/helper";
import {
  HIGHLIGHT_MAX_CHARS,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_CHARS,
  PREVIEW_MAX_LINES,
  formatBytes,
  isPreviewTooLarge,
  looksBinary,
  slicePreview,
} from "@/lib/panel/file";
import { basename } from "@/lib/panel/paths";
import { languageForPath } from "@/lib/panel/highlight";
import { useStore, useT } from "@/state";

/** The "we did not render this" box, shared by all three of the caps. */
function Note({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <Empty>
      <FileWarning className="mx-auto mb-2 h-5 w-5" />
      <p className="text-foreground">{title}</p>
      <p className="mt-1 font-mono text-xs">{detail}</p>
    </Empty>
  );
}

export function FilePreview({ path }: { path: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const { connection } = usePanelHelper();

  const stat = usePanelStat(connection, path);
  const size = stat.data?.size ?? 0;
  const isFile = stat.data?.kind === "file";
  // Over the cap: the read is never issued. `""` is how the query hooks say
  // "not now" — every one of them requires a non-empty path.
  const blocked = stat.data !== undefined && (!isFile || isPreviewTooLarge(size));
  const read = usePanelRead(connection, blocked ? "" : path);

  const name = basename(path);

  const header = (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
        {name}
      </span>
      {stat.data ? (
        <span className="shrink-0 font-mono text-micro text-muted-foreground">
          {formatBytes(size)}
        </span>
      ) : null}
      <Badge variant="outline" className="shrink-0 gap-1">
        <Lock className="h-2.5 w-2.5" />
        {t("file.readOnly")}
      </Badge>
    </div>
  );

  if (stat.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="p-2">
          <Spinner label={t("file.loading")} />
        </div>
      </div>
    );
  }

  if (stat.error) {
    const error = HelperError.from(stat.error);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="p-2">
          <Empty>
            {t("file.error", { message: helperErrorText(error, lang) })}
          </Empty>
        </div>
      </div>
    );
  }

  if (blocked) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="p-2">
          {!isFile ? (
            <Note
              title={t("file.unsupported")}
              detail={stat.data?.kind ?? ""}
            />
          ) : (
            <Note
              title={t("file.tooLarge")}
              detail={t("file.tooLargeHint", {
                size: formatBytes(size),
                limit: formatBytes(PREVIEW_MAX_BYTES),
              })}
            />
          )}
        </div>
      </div>
    );
  }

  // The helper's own `binary` refusal wins; `looksBinary` is the same rule
  // applied to bytes that arrived anyway (an older remote, a reply that skipped
  // the sniff).
  const refusedBinary = read.error
    ? HelperError.from(read.error).errorCode === "binary"
    : false;
  const sniffed = read.data ? looksBinary(read.data.data) : false;

  if (refusedBinary || sniffed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="p-2">
          <Note
            title={t("file.binary")}
            detail={t("file.binaryHint", {
              size: formatBytes(read.data?.size ?? size),
            })}
          />
        </div>
      </div>
    );
  }

  if (read.error) {
    const error = HelperError.from(read.error);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="p-2">
          <Empty>
            {t("file.error", { message: helperErrorText(error, lang) })}
          </Empty>
        </div>
      </div>
    );
  }

  if (!read.data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="p-2">
          <Spinner label={t("file.loading")} />
        </div>
      </div>
    );
  }

  const text = decodeText(read.data.data);
  const slice = slicePreview(text, PREVIEW_MAX_LINES, PREVIEW_MAX_CHARS);
  // Above this the scanner is the thing that would make the panel feel slow, so
  // the file is shown as plain text. It is still shown.
  const language = text.length > HIGHLIGHT_MAX_CHARS ? "plain" : languageForPath(path);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {slice.truncated || text.length > HIGHLIGHT_MAX_CHARS ? (
        <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-warning">
          {slice.truncated
            ? t("file.truncated", {
                lines: slice.lines.length,
                total: slice.totalLines,
              })
            : t("file.plain")}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeBlock lines={slice.lines} language={language} />
      </div>
    </div>
  );
}

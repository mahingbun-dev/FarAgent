/**
 * A tool call, or a run of them, as one row.
 *
 * A conversation is mostly tool calls, and drawn at full size they bury the
 * prose. The row is therefore **one line by default** — the call's own label
 * when it stands alone ("Read /srv/app/src/lib/lease.ts"), the run's sentence
 * when several ran together ("Ran an agent, read 2 files, ran 2 commands ›") —
 * and opens to show the bytes for a reader who wants them.
 *
 * ## The four states a row is drawn in, and why each is explicit
 *
 * - **Settled and fine.** The ordinary case.
 * - **Pending** (`result === null`). This is the **normal live case**, not a
 *   fault: the agent is running the tool and has not written its result record
 *   yet. It gets a dashed edge and a "Running" pill rather than the error
 *   styling, because a row that looked broken every time a tool ran would make
 *   the error state mean nothing.
 * - **Failed** (`result.isError`). A red edge and a "Failed" pill on the row,
 *   and the result itself is tinted — a failed call has to be distinguishable
 *   from a successful one at a glance, not only after opening it.
 * - **A run.** Several calls to one row, with the worst state of the run on the
 *   collapsed line. Opening it lists each call with its own status.
 *
 * ## Diffs
 *
 * An edit or a write is rendered with the panel's own parser and styling
 * (`lib/panel/diff.ts`, `components/panel/diff-view.tsx`), fed by
 * `diffTextOf` (`lib/chat/tool-input.ts`), which either passes through a patch
 * the agent already sent or synthesises one from `old_string`/`new_string`.
 * That keeps one diff renderer in the app, and it means the reader's eye has
 * already learned this shape from the panel next door.
 */
import { useState, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  FilePen,
  FileSearch,
  FileText,
  Globe,
  ListChecks,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DiffFileView } from "@/components/panel/diff-view";
import { CONTENT_WIDTH } from "@/design";
import { diffTextOf, inputJson } from "@/lib/chat/tool-input";
import { toolKind, toolRunLine, type ToolKind } from "@/lib/chat/tool-call";
import type { ToolEvent } from "@/lib/chat/events";
import { parseUnifiedDiff, sliceDiff } from "@/lib/panel/diff";
import { languageForPath } from "@/lib/panel/highlight";
import { cn } from "@/lib/utils";
import { useT } from "@/state";

/**
 * How many lines of a tool result are drawn before the rest is elided.
 *
 * A `Read` result is a whole file and a `Bash` result is a build log; neither
 * belongs in the conversation at full length. Forty is roughly a screen-height
 * of monospace at `text-xs`, which is what a reader will actually read here —
 * the panel is where the whole file lives.
 */
const RESULT_LINES = 40;

const ICON: Record<ToolKind, typeof FileText> = {
  read: FileText,
  write: FilePen,
  edit: FilePen,
  bash: Terminal,
  search: Search,
  fetch: Globe,
  webSearch: FileSearch,
  agent: Bot,
  todo: ListChecks,
  other: Wrench,
};

const KINDS = new Set<ToolKind>(Object.keys(ICON) as ToolKind[]);

/** The row's icon, from the first call's kind. */
function iconFor(events: readonly ToolEvent[]) {
  const first = events[0];
  const kind = first ? toolKind(first.name) : "other";
  return KINDS.has(kind) ? ICON[kind] : ICON.other;
}

/** A monospace block, for an input or a result. */
function Block({
  children,
  tone = "plain",
}: {
  children: ReactNode;
  tone?: "plain" | "danger" | "muted";
}) {
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-md border px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap",
        tone === "danger"
          ? "border-danger/40 bg-danger/5 text-danger"
          : tone === "muted"
            ? "border-border bg-code-bg/40 text-muted-foreground"
            : "border-border bg-code-bg",
      )}
    >
      {children}
    </pre>
  );
}

/** A small section heading inside an opened row. */
function Label({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1 text-micro font-medium text-muted-foreground uppercase">
      {children}
    </p>
  );
}

/** One call, opened: its input (or its patch) and its result. */
function CallDetail({ event }: { event: ToolEvent }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const pending = event.result === null;
  const failed = event.result?.isError === true;

  // An edit or a write is shown as a patch rather than as its raw arguments:
  // `old_string`/`new_string` say the same thing, less readably, and the patch
  // is what the panel next door already taught the reader to read.
  const patch = diffTextOf(event.input);
  const json = inputJson(event.input);
  const lines = event.result === null ? [] : event.result.content.split("\n");
  const shown = lines.slice(0, RESULT_LINES);
  const hidden = lines.length - shown.length;

  return (
    <div
      className={cn(
        "rounded-md border",
        failed ? "border-danger/40" : "border-border",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{event.name}</span>
        {failed ? (
          <Badge variant="danger">{t("chat.failed")}</Badge>
        ) : pending ? (
          <Badge variant="idle">{t("chat.pending")}</Badge>
        ) : null}
      </button>

      {open ? (
        <div className="space-y-2 px-2 pb-2">
          <div>
            <Label>{t("chat.input")}</Label>
            {patch ? (
              <Patch text={patch.text} />
            ) : json === null ? (
              <p className="text-xs text-muted-foreground">{t("chat.noInput")}</p>
            ) : (
              <Block>{json}</Block>
            )}
          </div>

          <div>
            <Label>{t("chat.result")}</Label>
            {event.result === null ? (
              <p className="text-xs text-muted-foreground">{t("chat.noResult")}</p>
            ) : event.result.content.trim() === "" ? (
              <p className="text-xs text-muted-foreground">{t("chat.emptyResult")}</p>
            ) : (
              <>
                <Block tone={failed ? "danger" : "plain"}>
                  {shown.join("\n")}
                </Block>
                {hidden > 0 ? (
                  <p className="mt-1 text-micro text-muted-foreground">
                    {t("chat.elided", { count: hidden })}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A patch, through the panel's parser, its row budget and its renderer. */
function Patch({ text }: { text: string }) {
  const t = useT();
  const slice = sliceDiff(parseUnifiedDiff(text));

  if (slice.files.length === 0) {
    // The parser found no file: a patch this model cannot read is shown as the
    // text it is rather than as an empty box.
    return <Block tone="muted">{text}</Block>;
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      {slice.files.map((file) => (
        <DiffFileView key={file.path} file={file} language={languageForPath(file.path)} />
      ))}
      {slice.truncated ? (
        <p className="border-t border-border px-2 py-1 text-micro text-muted-foreground">
          {t("chat.diffTruncated", { count: slice.shown })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A run of consecutive tool calls as one row.
 *
 * `events` is never empty: the fold in `lib/chat/sidechain.ts` only makes a run
 * of one or more.
 */
export function ToolRow({ events }: { events: readonly ToolEvent[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const Icon = iconFor(events);
  const pending = events.some((event) => event.result === null);
  const failed = events.some((event) => event.result?.isError === true);
  const line = toolRunLine(events, t);

  return (
    <div style={{ maxWidth: CONTENT_WIDTH.content }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cn(
          "flex w-full max-w-prose items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
          failed
            ? "border-danger/40 bg-danger/5 hover:bg-danger/10"
            : "border-border bg-surface-raised/40 hover:bg-surface-hover",
          pending && !failed && "border-dashed",
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{line}</span>
        {failed ? (
          <Badge variant="danger">{t("chat.failed")}</Badge>
        ) : pending ? (
          <Badge variant="idle">{t("chat.pending")}</Badge>
        ) : null}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open ? (
        /*
          What opens is allowed the **content** width, not the prose width the
          collapsed line keeps (`CONTENT_WIDTH`, the same pair `message-list.tsx`
          sizes the list with). A patch is not prose: it is monospace, it is laid
          out in columns, and a line of it does not wrap — so at the reading
          width a real diff clipped a dozen characters off the right edge, and
          the overflow is scrolled by a scrollbar macOS never draws. The caveat
          below is the one that survives this: a line wider than the content
          column can still only be reached by scrolling.
        */
        <div className="mt-1 space-y-1.5" style={{ maxWidth: CONTENT_WIDTH.content }}>
          {events.map((event) => (
            <CallDetail key={event.id} event={event} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

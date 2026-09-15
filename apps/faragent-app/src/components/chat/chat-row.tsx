/**
 * One row of the conversation, and the nested block a subagent's turn lives in.
 *
 * `ChatRow` is the only place a `ChatItem` (`lib/chat/sidechain.ts`) becomes
 * elements, so the fold's three kinds are drawn in exactly one way each:
 *
 * - **`event`** — prose through `Markdown`, or reasoning through `ThinkingRow`.
 *   A user turn and an assistant turn differ by alignment and weight, because a
 *   conversation where both sides look the same is unreadable at a glance.
 * - **`tools`** — a run of calls as one collapsed line (`ToolRow`).
 * - **`sidechain`** — a subagent's turn as a nested block, collapsed by default.
 *   This is the brief's "do not mix into the main thread silently": the events
 *   carry a boolean and no identity, so a run of them is shown as *a* subagent's
 *   output, boxed and indented, rather than as the main agent's own words.
 *
 * `SidechainBlock` lives in this file rather than beside `ToolRow` because it
 * has to render `ChatRow` for its contents, and two modules importing each other
 * for that is a cycle worth not having.
 */
import { useState } from "react";
import { Brain, ChevronRight, CornerDownRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/chat/markdown";
import { ToolRow } from "@/components/chat/tool-row";
import { CONTENT_WIDTH } from "@/design";
import { firstLine } from "@/lib/chat/tool-input";
import type { ChatItem } from "@/lib/chat/sidechain";
import type { MessageEvent, ThinkingEvent } from "@/lib/chat/events";
import { cn } from "@/lib/utils";
import { useT } from "@/state";

/**
 * A turn's prose.
 *
 * A user turn is drawn in a raised card so it is findable when scrolling back
 * through a page of assistant text and tool rows; the assistant's own prose sits
 * on the canvas, which is where the reference UI puts it.
 *
 * The assistant's box is the **content** width rather than the reading width,
 * with the reading cap applied to the prose inside it (`markdown.tsx`): prose
 * stays 65ch, and a fenced block — which does not wrap and does not want to be
 * scrolled inside a 65ch column — is allowed the room it needs. The user's card
 * keeps the narrow width, because a card is a shape rather than a column and a
 * wide one around narrow text reads as an empty box.
 */
function Message({ event }: { event: MessageEvent }) {
  if (event.role === "user") {
    return (
      <div className="max-w-prose rounded-lg border border-border bg-surface-raised px-3 py-2">
        <Markdown text={event.markdown} />
      </div>
    );
  }
  return (
    <div style={{ maxWidth: CONTENT_WIDTH.content }}>
      <Markdown text={event.markdown} />
    </div>
  );
}

/**
 * The model's reasoning: collapsed, and unlike the prose around it.
 *
 * "Visually distinct" is doing real work here — reasoning and an answer are
 * different things and a reader who cannot tell them apart cannot trust either.
 * So this is a dashed box, an italic muted label, and a body on a tinted
 * background with a rule down its left edge, none of which any prose row has.
 *
 * The widths are `ToolRow`'s, and for the same reason: the collapsed label is a
 * control and keeps the reading width, while the body it opens can contain a
 * fenced block, and a fence is not prose — it does not wrap, and at 65ch a real
 * one loses its right edge to an overflow macOS scrolls with a scrollbar it never
 * draws. Reasoning is where a model writes a command or a patch out in full, so
 * this is not a hypothetical: it is the shape most likely to hit the cap.
 */
function ThinkingRow({ event }: { event: ThinkingEvent }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const preview = firstLine(event.markdown);

  return (
    <div style={{ maxWidth: CONTENT_WIDTH.content }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full max-w-prose items-center gap-2 rounded-md border border-dashed border-border px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-surface-hover"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0 text-micro italic">{t("chat.thinking")}</span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate text-micro opacity-70">{preview}</span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open ? (
        <div
          className="mt-1 border-l-2 border-border bg-surface-raised/40 px-3 py-2 text-muted-foreground italic"
          style={{ maxWidth: CONTENT_WIDTH.content }}
        >
          <Markdown text={event.markdown} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A run of subagent events, boxed and indented.
 *
 * Collapsed by default and labelled with how much is inside, so the reader can
 * see that a subagent ran and how much it did without being walked through it.
 * The nested rows obey the same fold as the main thread — a run of the
 * subagent's tool calls is one line here too.
 *
 * ## Why this box is the content width even while it is collapsed
 *
 * A subagent's turn is the same rows the main thread draws, and those rows can
 * carry a patch — which does not wrap, and which a 65ch parent clips into an
 * overflow macOS scrolls with a scrollbar it never draws. A `max-width` on a
 * child cannot widen a narrow parent, so the room has to be granted here, at the
 * box. The alternative — widening the box only when it opens — would make it jump
 * under the reader's cursor on the click that opened it.
 *
 * What that costs is a sparse collapsed header (the label, then the gap, then the
 * badge at the right edge). The assistant's own turn takes the same trade: a
 * container that can hold a fence is the content width, and the prose inside it is
 * capped at the reading width instead. The collapsed *tool* row is the case that
 * differs, and deliberately: it is a line, not a container.
 */
export function SidechainBlock({
  item,
}: {
  item: Extract<ChatItem, { kind: "sidechain" }>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div
      className="rounded-lg border border-border bg-surface-raised/30"
      style={{ maxWidth: CONTENT_WIDTH.content }}
    >
      <button
        type="button"
        aria-expanded={open}
        // The count is what the reader is deciding on, so it is the label; the
        // tooltip carries the shorter word for what this block is.
        title={t("chat.subagent")}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
      >
        <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">
          {t("chat.subagentItems", { count: item.items.length })}
        </span>
        <Badge variant="outline">{t("chat.subagent")}</Badge>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-2 pl-4">
          {item.items.map((child) => (
            <ChatRow key={child.id} item={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One row of the conversation. */
export function ChatRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "tools":
      return <ToolRow events={item.events} />;
    case "sidechain":
      return <SidechainBlock item={item} />;
    case "event":
      return item.event.kind === "thinking" ? (
        <ThinkingRow event={item.event} />
      ) : (
        <Message event={item.event} />
      );
  }
}

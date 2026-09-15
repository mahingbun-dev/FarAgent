/**
 * The conversation view: one session's transcript, rendered.
 *
 * This is the sibling `TerminalView` never had. It reads the same remote over
 * the same helper channel and draws what the agent wrote, instead of the escape
 * sequences the agent's TUI paints.
 *
 * ## It joins the panel's connection; it does not open one
 *
 * The remote helper protocol allows **one `helper_open` per host** — a second
 * replaces the first (`helper.rs::adopt`). So this does not call `openHelper`
 * itself: it mounts a `HelperProvider`, and that provider goes through the same
 * module-level lease the panel's does (`components/panel/helper-context.tsx`),
 * keyed by host. Two holders, one ssh session. A chat view that dialled its own
 * would hang up the panel, and the panel would hang up the chat.
 *
 * ## The states this draws, and why each one is deliberate
 *
 * - **No transcript path** (`tab.transcript === null`). Says *that*, and not
 *   "this session has no conversation": the path is unknown, which is a
 *   different fact and the true one for a row the rail inferred from tmux or a
 *   process scan, and for a login or install tab (no session, so no
 *   conversation). Telling a reader with a 500-turn session that it "has no
 *   conversation yet" would be a lie about the one thing this pane exists to
 *   show.
 * - **No adapter** (`adapterFor(tab.agent) === null`). Codex, Grok and Pi have no
 *   event model yet, and S6's fallback is the terminal. If a tab somehow reaches
 *   this view anyway, it says which agent cannot be shown rather than rendering
 *   an empty pane that looks like an empty conversation.
 * - **Zero records.** A session that has been opened but has not been spoken to
 *   yet. This is the state a new session spends its first seconds in, so it is
 *   the one most likely to be mistaken for a bug: it gets a sentence, not
 *   whitespace.
 * - **A read that failed.** The rejection's message, and a retry, because the
 *   remote helper can die and be replaced.
 * - **Read-only.** The one thing the reader must know: this pane cannot answer a
 *   permission prompt or a slash command, only the terminal can.
 */
import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Spinner } from "@/components/ui/empty";
import { MessageList } from "@/components/chat/message-list";
import { HelperProvider, useHelper } from "@/components/panel/helper-context";
import { useTranscript } from "@/components/chat/use-transcript";
import { adapterFor } from "@/lib/chat/adapters";
import { groupEvents } from "@/lib/chat/sidechain";
import { helperErrorText } from "@/lib/helper";
import type { Lang } from "@/lib/ipc";
import { useStore, useT, type Tab } from "@/state";

/**
 * A byte count a person reads: `512 B`, `1.4 MiB`, `9.9 MiB`.
 *
 * Local rather than shared because it is the only place in the app that names a
 * number of *unloaded bytes*, and `lib/bytes.ts` is base64, not formatting.
 * Binary units, because that is what a file size on a disk is.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The panel's error sentence for whatever the helper threw. */
function errorMessage(error: unknown, lang: Lang): string {
  return helperErrorText(error, lang);
}

/** The list with a failed read's message, and the way back. */
function ReadError({
  message,
  action,
  children,
}: {
  message: string;
  action: () => void;
  children: ReactNode;
}) {
  return (
    <Centred>
      <Empty>
        <p>{message}</p>
        <Button size="sm" className="mt-3" onClick={action}>
          {children}
        </Button>
      </Empty>
    </Centred>
  );
}

/**
 * The conversation for `tab`.
 *
 * The provider wraps the body rather than being passed a connection, because the
 * connection lives in React state and this component's whole job is to wait for
 * it. The body is a separate component so the hook order is unconditional —
 * `useTranscript` is called whether or not there is a helper yet.
 */
export function ChatView({ tab }: { tab: Tab }) {
  return (
    <HelperProvider host={tab.host}>
      <ChatBody tab={tab} />
    </HelperProvider>
  );
}

function ChatBody({ tab }: { tab: Tab }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const helper = useHelper();
  const transcript = useTranscript(helper.connection, tab.host, tab.transcript);

  const adapter = adapterFor(tab.agent);

  /**
   * The records, folded.
   *
   * Memoised on the record array's identity because the tail hands out a fresh
   * one on every change: without this, a re-render caused by anything else (a
   * resize, a scroll) would re-run the adapter and the fold over the whole
   * conversation.
   */
  const items = useMemo(
    () => (adapter ? groupEvents(adapter(transcript.records.slice())) : []),
    [adapter, transcript.records],
  );

  if (tab.transcript === null) {
    return (
      <Centred>
        <Empty>
          <p>{t("chat.noTranscript")}</p>
          <p className="mt-1 text-xs">{t("chat.noTranscriptHint")}</p>
        </Empty>
      </Centred>
    );
  }

  if (adapter === null) {
    return (
      <Centred>
        <Empty>{t("chat.unavailable")}</Empty>
      </Centred>
    );
  }

  if (helper.status === "connecting") {
    return (
      <Centred>
        <Spinner label={t("chat.loading")} />
      </Centred>
    );
  }

  if (helper.status === "error" || helper.status === "closed") {
    return (
      <ReadError
        message={t("chat.error", { message: errorMessage(helper.error, lang) })}
        action={helper.retry}
      >
        {t("chat.retry")}
      </ReadError>
    );
  }

  if (transcript.status === "error") {
    return (
      <ReadError
        message={t("chat.error", { message: errorMessage(transcript.error, lang) })}
        action={transcript.retry}
      >
        {t("chat.retry")}
      </ReadError>
    );
  }

  if (transcript.status === "connecting") {
    return (
      <Centred>
        <Spinner label={t("chat.loading")} />
      </Centred>
    );
  }

  if (items.length === 0) {
    return (
      <Centred>
        <Empty>
          <p>{t("chat.empty")}</p>
          <p className="mt-1 text-xs">{t("chat.emptyHint")}</p>
        </Empty>
      </Centred>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        Read-only, said once and quietly. It is not a warning — nothing here is
        broken — but a reader who replies into this pane and sees nothing happen
        would think the app was.
      */}
      <p className="shrink-0 border-b border-border px-2 py-1 text-micro text-muted-foreground">
        {t("chat.readOnly")}
      </p>

      {/*
        The strip sits *above* the scroller rather than in it: the virtual
        window's arithmetic takes `scrollTop` as a number, and a strip inside the
        scrolling content would make that number mean something different at the
        top than everywhere else.
      */}
      {transcript.hasEarlier ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
          <span className="text-micro text-muted-foreground">
            {t("chat.earlier", { size: formatBytes(transcript.unloadedBefore) })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6"
            disabled={transcript.loadingEarlier}
            onClick={transcript.loadEarlier}
          >
            {transcript.loadingEarlier ? t("chat.reading") : t("chat.loadEarlier")}
          </Button>
        </div>
      ) : null}

      <MessageList items={items} />
    </div>
  );
}

/** The centred single-message layout the non-list states share. */
function Centred({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-gutter">
      <div className="w-full max-w-prose">{children}</div>
    </div>
  );
}

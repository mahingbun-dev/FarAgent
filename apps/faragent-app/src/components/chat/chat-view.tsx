/**
 * The conversation view: one session's transcript, rendered — and, since Phase
 * 3, a place to reply from.
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
 * ## The attach is the tab's, not this view's
 *
 * The composer writes to the remote through the **same attach the terminal
 * reads**, and that attach is leased once per tab by whatever renders both views
 * (`lib/tab-attach.ts` explains why twice would make the terminal go deaf). It
 * arrives here as a prop, and this file uses exactly one thing from it —
 * `write` — plus nothing else: the terminal half is the sink, because only it
 * can draw the bytes and only it knows the size.
 *
 * ## Sending: what happens, in order
 *
 * 1. The composer hands up the text; this file writes it to the attach, as the
 *    keystrokes the remote's TUI already understands (`lib/chat/composer.ts`).
 * 2. It also appends the message to its own list as an **echo**, because the
 *    transcript is written by the *agent* once it has taken the input — a beat
 *    later, and sometimes much later. Without the echo, pressing Enter shows
 *    nothing and reads as a broken button.
 * 3. When the transcript's own record of that message arrives, the echo is
 *    dropped. `lib/chat/echo.ts` is the reconciliation and the argument that the
 *    two can never be on screen together.
 *
 * ## The states this draws, and why each one is deliberate
 *
 * - **No transcript path** (`tab.transcript === null`). Says *that*, and not
 *   "this session has no conversation": the path is unknown, which is a
 *   different fact and the true one for a row the rail inferred from tmux or a
 *   process scan, and for a login or install tab (no session, so no
 *   conversation). Telling a reader with a 500-turn session that it "has no
 *   conversation yet" would be a lie about the one thing this pane exists to
 *   show. No composer here either: with the path unknown there is no
 *   conversation this pane can claim to be writing into, and the terminal is
 *   one click away.
 * - **No adapter** (`adapterFor(tab.agent) === null`). Codex, Grok and Pi have no
 *   event model yet, and S6's fallback is the terminal. If a tab somehow reaches
 *   this view anyway, it says which agent cannot be shown rather than rendering
 *   an empty pane that looks like an empty conversation.
 * - **Zero records.** A session that has been opened but has not been spoken to
 *   yet. This is the state a new session spends its first seconds in, so it is
 *   the one most likely to be mistaken for a bug: it gets a sentence, not
 *   whitespace — and the composer, because this is precisely the state a reader
 *   wants to type in.
 * - **A read that failed.** The rejection's message, and a retry, because the
 *   remote helper can die and be replaced. The composer is deliberately absent:
 *   a transcript that cannot be read is a conversation this pane cannot show the
 *   result of, and a send button whose effect you cannot see is worse than none.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Spinner } from "@/components/ui/empty";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { HelperProvider, useHelper } from "@/components/panel/helper-context";
import { useTranscript } from "@/components/chat/use-transcript";
import { adapterFor } from "@/lib/chat/adapters";
import { encodeSend } from "@/lib/chat/composer";
import { absorb, echoItems, seenFor, type PendingEcho } from "@/lib/chat/echo";
import { groupEvents } from "@/lib/chat/sidechain";
import { helperErrorText } from "@/lib/helper";
import type { Lang } from "@/lib/ipc";
import type { TabAttach } from "@/lib/tab-attach";
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
 * The conversation for `tab`, writing through the tab's `attach`.
 *
 * The provider wraps the body rather than being passed a connection, because the
 * connection lives in React state and this component's whole job is to wait for
 * it. The body is a separate component so the hook order is unconditional —
 * `useTranscript` is called whether or not there is a helper yet.
 */
export function ChatView({ tab, attach }: { tab: Tab; attach: TabAttach }) {
  return (
    <HelperProvider host={tab.host}>
      <ChatBody tab={tab} attach={attach} />
    </HelperProvider>
  );
}

function ChatBody({ tab, attach }: { tab: Tab; attach: TabAttach }) {
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

  /**
   * Messages sent from here that the transcript has not accounted for yet.
   *
   * Kept as everything sent, and *narrowed* for drawing rather than pruned on
   * send, so the reconciliation is a pure function of the two lists and does not
   * depend on an effect having run.
   */
  const [sent, setSent] = useState<readonly PendingEcho[]>([]);
  const echoSeq = useRef(0);

  const pending = useMemo(() => absorb(sent, items), [sent, items]);
  const rows = useMemo(() => [...items, ...echoItems(pending)], [items, pending]);

  /**
   * Forget echoes the transcript has caught up with, so the list does not grow
   * for the life of the tab. Same list identity when nothing was absorbed, which
   * is the case for every render in which nothing arrived.
   */
  useEffect(() => {
    setSent((previous) => {
      const next = absorb(previous, items);
      return next.length === previous.length ? previous : next;
    });
  }, [items]);

  const send = useCallback(
    (text: string) => {
      // The bytes go out first. The echo is bookkeeping about a message that has
      // already been said; if writing threw, there would be nothing to echo.
      attach.write(encodeSend(text));
      echoSeq.current += 1;
      const id = `echo:${echoSeq.current}`;
      setSent((previous) => [
        ...previous,
        // `seen` inside the updater, from the previous list: two sends that
        // land in one batch then get different baselines, which is what stops
        // the second from being absorbed by the first's record.
        { id, text, seen: seenFor(previous, items, text) },
      ]);
    },
    [attach, items],
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

  const composer = <Composer agent={tab.agent} onSend={send} />;

  // Empty *and* nothing sent: a session that has not been spoken to. A message
  // sent a moment ago is not "empty" — it is the first turn of a conversation,
  // and it goes through the list below like every other row.
  const empty = items.length === 0 && pending.length === 0;

  /*
    Both states render the *same two children in the same order* — the body,
    then the composer. That is not cosmetic: if the empty state's body and the
    list's body sat at different indices (or behind a `null`, which sends React's
    reconciler down its slow path), the composer would be a different element at
    a different position as soon as the first message was sent, React would
    recreate its fiber, and the field the reader was typing in would be gone —
    focus to `<body>`, the next keystroke nowhere. Confirmed in a browser before
    and after: see the S5 fix report.
  */
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {empty ? (
        <Centred>
          <Empty>
            <p>{t("chat.empty")}</p>
            <p className="mt-1 text-xs">{t("chat.emptyHint")}</p>
          </Empty>
        </Centred>
      ) : (
        <>
          {/*
            "Read earlier" sits *above* the scroller rather than in it: the virtual
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

          <MessageList items={rows} />
        </>
      )}
      {composer}
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

/**
 * The workspace: the open tabs, their session views, and the right-hand panel slot.
 *
 * Every tab's terminal stays mounted for as long as the tab is open — switching
 * tabs only changes which one is visible, so a running agent is never rebuilt
 * (and never re-attaches) just because you looked at another one.
 *
 * ## Two views of one session
 *
 * A session tab can be looked at two ways, and `Tab.view` says which
 * (`state.ts`): the agent's own terminal, or its conversation rendered
 * (`components/chat/`). They are siblings, not alternatives to each other:
 *
 * - **The terminal is never unmounted and never reconfigured.** It is the only
 *   surface that can answer a permission prompt or take a slash command, so
 *   hiding it must cost nothing and lose nothing. It keeps its box (`invisible`,
 *   not `hidden`) for the reason this file always gave: xterm's fit addon does
 *   not have to re-measure on every switch.
 * - **The conversation is mounted the first time it is asked for, and kept.**
 *   `mountedChat` is why a session you never read from costs no transcript tail
 *   and no second `fs.read` on the remote — but once you have read it, switching
 *   back to the terminal and returning does not re-read 256 KiB or lose your
 *   scroll position.
 *
 * The switch itself lives in the tab's own chrome rather than in a global
 * setting, because it is a property of what you are looking at, not of the app.
 */
import { useLayoutEffect, useState } from "react";
import { MessageSquare, PanelRight, Plus, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TerminalView } from "@/components/TerminalView";
import { ChatView } from "@/components/chat/chat-view";
import { DiagnosisDialog } from "@/components/dialogs";
import { RightPanel } from "@/components/panel/right-panel";
import { RowAction } from "@/components/shell/row-action";
import { useSessionLauncher } from "@/components/shell/session-launcher";
import { cn } from "@/lib/utils";
import type { Diagnosis } from "@/lib/ipc";
import { tabHasChatView, useStore, useT, type Tab, type TabView } from "@/state";

/**
 * Whether this tab is a session at all.
 *
 * A login shell and an install run are terminals that happen to live in the same
 * strip: neither has a session behind it, so neither has a conversation, so
 * neither gets the switch.
 */
function isSession(tab: Tab): boolean {
  return tab.spec.kind === "tmux" || tab.spec.kind === "win_agent";
}

export function WorkspaceTabs() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const selectTab = useStore((s) => s.selectTab);
  const closeTab = useStore((s) => s.closeTab);
  const setPanel = useStore((s) => s.setPanel);
  const setTabView = useStore((s) => s.setTabView);
  const { requestNew, canStart } = useSessionLauncher();
  const [diag, setDiag] = useState<Diagnosis | null>(null);

  /**
   * The tabs whose conversation has ever been shown.
   *
   * Seeded from the tabs that are already on their chat view, so the first paint
   * of a restored session does not flash an empty pane before the effect below
   * catches up; the effect then adds a tab the first time it is switched to
   * chat. Pruned on close so the set does not outlive the tabs it names.
   */
  const [mountedChat, setMountedChat] = useState<ReadonlySet<string>>(
    () => new Set(tabs.filter((tab) => tab.view === "chat").map((tab) => tab.id)),
  );
  useLayoutEffect(() => {
    setMountedChat((previous) => {
      const next = new Set(
        tabs.filter((tab) => previous.has(tab.id)).map((tab) => tab.id),
      );
      for (const tab of tabs) {
        if (tab.view === "chat") next.add(tab.id);
      }
      // Identity is what tells React nothing changed; the store re-renders this
      // component on every tab edit (a title, a panel width) and a fresh set
      // every time would re-render every conversation with it.
      if (next.size === previous.size && [...next].every((id) => previous.has(id))) {
        return previous;
      }
      return next;
    });
  }, [tabs]);

  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;

  if (tabs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-gutter">
        <div className="max-w-prose text-center">
          <p className="font-display text-lg">{t("tabs.empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("tabs.emptyHint")}</p>
          <Button
            size="sm"
            className="mt-4"
            disabled={!canStart}
            onClick={() => requestNew()}
          >
            <Plus />
            {t("sessions.new")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Tabs
        value={activeTabId ?? ""}
        onValueChange={selectTab}
        list="underline"
        className="min-h-0 flex-1"
      >
        <div className="flex shrink-0 items-center border-b border-border px-2">
          <TabsList className="min-w-0 flex-1 gap-0 overflow-x-auto border-b-0">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                // Without this the close action's name joins the tab's own.
                aria-label={tab.title}
                className="max-w-56 shrink-0 gap-2 pr-1"
              >
                <span className="min-w-0 truncate">{tab.title}</span>
                {isSession(tab) ? (
                  <ViewToggle
                    tab={tab}
                    onToggle={(view) => setTabView(tab.id, view)}
                  />
                ) : null}
                <RowAction
                  title={t("term.detach")}
                  className="px-1 hover:bg-surface-selected"
                  onActivate={() => closeTab(tab.id)}
                >
                  <X className="h-3 w-3" />
                </RowAction>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 flex-1">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                aria-hidden={tab.id !== activeTabId}
                className={cn(
                  "absolute inset-0",
                  tab.id !== activeTabId && "invisible",
                )}
              >
                <div
                  className={cn(
                    "absolute inset-0",
                    tab.view !== "terminal" && "invisible",
                  )}
                >
                  <TerminalView
                    host={tab.host}
                    spec={tab.spec}
                    onDiagnosis={setDiag}
                    onExit={() => {}}
                  />
                </div>

                {mountedChat.has(tab.id) ? (
                  <div
                    className={cn(
                      "absolute inset-0 flex flex-col",
                      tab.view !== "chat" && "invisible",
                    )}
                  >
                    <ChatView tab={tab} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {active ? (
            <PanelSlot
              tab={active}
              onToggle={(open) => setPanel(active.id, { open })}
            />
          ) : null}
        </div>
      </Tabs>

      {diag ? (
        <DiagnosisDialog
          diagnosis={diag}
          lang={lang}
          onClose={() => setDiag(null)}
          onRetry={() => setDiag(null)}
        />
      ) : null}
    </>
  );
}

/**
 * The chat↔terminal switch.
 *
 * Shown on every session tab, **disabled** on a session whose agent has no
 * adapter. Disabled rather than absent on purpose: Codex, Grok and Pi sessions
 * are renderable in principle and are not yet (see `lib/chat/adapters/`), and a
 * control that is simply missing from those tabs reads as "this app cannot show
 * conversations" — while a disabled one with the reason in its tooltip says
 * which agent is waiting for one.
 *
 * The icon is what you are switching **to**, not what you are looking at: the
 * control is the destination, the way a tab is.
 */
function ViewToggle({
  tab,
  onToggle,
}: {
  tab: Tab;
  onToggle: (view: TabView) => void;
}) {
  const t = useT();
  const onChat = tab.view === "chat";
  const offered = tabHasChatView(tab);

  return (
    <RowAction
      title={
        !offered
          ? t("chat.unavailable")
          : onChat
            ? t("chat.toggleTerminal")
            : t("chat.toggleChat")
      }
      disabled={!offered}
      className="px-1 hover:bg-surface-selected"
      onActivate={() => onToggle(onChat ? "terminal" : "chat")}
    >
      {onChat ? <Terminal className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
    </RowAction>
  );
}

/**
 * The right-hand slot. It owns the collapse state (a collapsed panel still has
 * to leave a visible way back in) and nothing else: the width, the tabs and the
 * three views all live in `RightPanel`.
 *
 * `key={tab.id}` is load-bearing. The panel holds the tree root and the selected
 * file in its own state, and without a per-tab key React would carry one
 * session's root over to the next tab.
 */
function PanelSlot({ tab, onToggle }: { tab: Tab; onToggle: (open: boolean) => void }) {
  const t = useT();

  if (!tab.panel.open) {
    return (
      <div className="flex w-8 shrink-0 flex-col items-center border-l border-sidebar-border pb-2">
        <Button
          variant="ghost"
          size="icon"
          title={t("panel.toggle")}
          aria-label={t("panel.toggle")}
          aria-expanded={false}
          className="mt-auto"
          onClick={() => onToggle(true)}
        >
          <PanelRight />
        </Button>
      </div>
    );
  }

  return <RightPanel key={tab.id} tab={tab} onClose={() => onToggle(false)} />;
}

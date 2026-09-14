/**
 * The workspace: the open tabs, their terminals, and the right-hand panel slot.
 *
 * Every tab's terminal stays mounted for as long as the tab is open — switching
 * tabs only changes which one is visible, so a running agent is never rebuilt
 * (and never re-attaches) just because you looked at another one.
 */
import { useState } from "react";
import { PanelRight, PanelRightClose, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TerminalView } from "@/components/TerminalView";
import { DiagnosisDialog } from "@/components/dialogs";
import { RowAction } from "@/components/shell/row-action";
import { useSessionLauncher } from "@/components/shell/session-launcher";
import { cn } from "@/lib/utils";
import type { Diagnosis } from "@/lib/ipc";
import { useStore, useT, type Tab } from "@/state";

export function WorkspaceTabs() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const selectTab = useStore((s) => s.selectTab);
  const closeTab = useStore((s) => s.closeTab);
  const setPanel = useStore((s) => s.setPanel);
  const { requestNew, canStart } = useSessionLauncher();
  const [diag, setDiag] = useState<Diagnosis | null>(null);

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
                // `invisible`, not `hidden`: the terminal keeps its box, so
                // xterm's fit addon does not have to re-measure on every switch.
                className={cn(
                  "absolute inset-0",
                  tab.id !== activeTabId && "invisible",
                )}
              >
                <TerminalView
                  host={tab.host}
                  spec={tab.spec}
                  onDiagnosis={setDiag}
                  onExit={() => {}}
                />
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
 * The right-hand slot. Task 9 renders the file tree, the changes list and the
 * git panel into the empty body; all this step owns is the per-tab state, the
 * width and the toggle.
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

  return (
    <aside
      style={{ width: tab.panel.width }}
      className="flex shrink-0 flex-col border-l border-sidebar-border bg-background"
    >
      <div className="flex h-8 shrink-0 items-center justify-end px-1">
        <Button
          variant="ghost"
          size="icon"
          title={t("panel.toggle")}
          aria-label={t("panel.toggle")}
          aria-expanded
          className="h-6 w-6"
          onClick={() => onToggle(false)}
        >
          <PanelRightClose />
        </Button>
      </div>
      <div className="min-h-0 flex-1" />
    </aside>
  );
}

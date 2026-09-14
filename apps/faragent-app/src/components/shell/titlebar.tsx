/**
 * The window's top bar: who you are talking to (host, agent), and the two
 * things you can start from anywhere (a new session, settings).
 *
 * This is where the old host → agent → session pages went: two switchers
 * instead of two full-page stops, with the same abilities behind them.
 */
import { Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { AgentSwitcher } from "@/components/shell/agent-switcher";
import { HostSwitcher } from "@/components/shell/host-switcher";
import { useSessionLauncher } from "@/components/shell/session-launcher";
import { useStore, useT } from "@/state";

export function Titlebar() {
  const t = useT();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const { requestNew, canStart } = useSessionLauncher();

  return (
    <header className="flex h-titlebar shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
      <span className="px-1.5 font-display text-sm tracking-tight">FarAgent</span>
      <Separator orientation="vertical" className="mr-1 h-4" />
      <HostSwitcher />
      <AgentSwitcher />

      <div className="min-w-0 flex-1" />

      <Button
        variant="ghost"
        size="sm"
        disabled={!canStart}
        onClick={() => requestNew()}
      >
        <Plus />
        {t("sessions.new")}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title={t("nav.settings")}
        aria-label={t("nav.settings")}
        aria-pressed={view === "settings"}
        className={view === "settings" ? "bg-surface-selected" : undefined}
        onClick={() => setView(view === "settings" ? "workspace" : "settings")}
      >
        <Settings />
      </Button>
    </header>
  );
}

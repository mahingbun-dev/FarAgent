/**
 * The application frame: a full-width titlebar over a two-column body.
 *
 * The rail carries the sessions of one host; the workspace carries the tabs.
 * The two are different surfaces (`--sidebar` against `--background`), which is
 * what makes the boundary readable without a heavy line.
 */
import { Sidebar } from "@/components/shell/sidebar";
import { SettingsView } from "@/components/shell/settings-view";
import { SessionLauncherProvider } from "@/components/shell/session-launcher";
import { Titlebar } from "@/components/shell/titlebar";
import { WorkspaceTabs } from "@/components/shell/workspace-tabs";
import { useStore } from "@/state";

export function AppShell() {
  const view = useStore((s) => s.view);

  return (
    <SessionLauncherProvider>
      <div className="flex h-full flex-col bg-background">
        <Titlebar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="flex min-w-0 flex-1 flex-col bg-background">
            {view === "settings" ? <SettingsView /> : <WorkspaceTabs />}
          </main>
        </div>
      </div>
    </SessionLauncherProvider>
  );
}

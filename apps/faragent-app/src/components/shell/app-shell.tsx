/**
 * The application frame: a full-width titlebar over a two-column body.
 *
 * The rail carries the sessions of one host; the workspace carries the tabs.
 * The two are different surfaces (`--sidebar` against `--background`), which is
 * what makes the boundary readable without a heavy line.
 */
import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { SettingsView } from "@/components/shell/settings-view";
import { SessionLauncherProvider } from "@/components/shell/session-launcher";
import { Titlebar } from "@/components/shell/titlebar";
import { WorkspaceTabs } from "@/components/shell/workspace-tabs";
import { cn } from "@/lib/utils";
import { useStore } from "@/state";

export function AppShell() {
  const view = useStore((s) => s.view);

  return (
    <SessionLauncherProvider>
      <div className="flex h-full flex-col bg-background">
        <Titlebar />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="relative flex min-w-0 flex-1 flex-col bg-background">
            {/*
             * Both views stay mounted; `view` only decides which one is
             * visible.
             *
             * Rendering one *or* the other rebuilt the whole workspace on a
             * trip to Settings: every xterm disposed, every attach hung up and
             * re-opened (scrollback lost, the remote window size renegotiated),
             * and one more lease entered per open tab. That is the same
             * reasoning `workspace-tabs.tsx` applies to inactive tabs, for the
             * same reason — and the settings view is a view of the workspace,
             * not a place the workspace stops existing.
             *
             * `invisible`, not `hidden`: a terminal that keeps its box keeps its
             * measurements, so the fit addon has nothing to re-measure and no
             * resize to send. `hidden` would collapse it to zero and resize the
             * remote PTY on the way back.
             */}
            <View active={view !== "settings"}>
              <WorkspaceTabs />
            </View>
            <View active={view === "settings"}>
              <SettingsView />
            </View>
          </main>
        </div>
      </div>
    </SessionLauncherProvider>
  );
}

/**
 * One of the workspace's two views, on or off screen.
 *
 * The inactive one is absolutely positioned so it does not take a share of the
 * column the way a second `flex-1` sibling would, and hidden with `visibility`
 * so its contents keep their box (see the note above about the terminals).
 *
 * `inert` goes with it, and it is the attribute doing the work here. A terminal
 * keeps the keyboard focus in its hidden helper textarea — measured, and
 * `inert` does not take it away: after the wrapper became inert,
 * `document.activeElement` was still the textarea. Chrome then refuses the
 * `aria-hidden` outright ("Blocked aria-hidden on an element because its
 * descendant retained focus", in the console), which on its own would leave the
 * whole workspace — terminal buffer and all — exposed to a screen reader from
 * inside Settings. `inert` excludes the subtree from the accessibility tree and
 * from the tab order regardless, so the two are not redundant: `aria-hidden` is
 * the one that holds on a runtime too old for `inert`, and `inert` is the one
 * that holds when focus is inside.
 */
function View({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!active}
      inert={!active}
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
    >
      {children}
    </div>
  );
}

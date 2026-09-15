/**
 * The left rail: this host's sessions, and the theme control under them.
 *
 * The rail itself does not scroll — `SessionList` owns the only scroll
 * container, which keeps the titlebar's popovers out of the rail's clipping
 * context.
 */
import { SessionList } from "@/components/shell/session-list";
import { useHosts } from "@/components/shell/use-shell-data";
import { ThemePicker } from "@/components/shell/theme-picker";
import { errorMessage } from "@/lib/ipc";
import { useStore, useT } from "@/state";

export function Sidebar() {
  const t = useT();
  const host = useStore((s) => s.host);
  // Same query the switcher runs: with no host selected, the rail says why.
  const hosts = useHosts();

  return (
    <aside className="flex w-sidebar shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      {host ? (
        <SessionList />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 text-xs text-muted-foreground">
          {hosts.error && !hosts.data ? errorMessage(hosts.error) : t("hosts.empty")}
        </div>
      )}

      <div className="flex h-11 shrink-0 items-center justify-between border-t border-sidebar-border px-2">
        <ThemePicker />
      </div>
    </aside>
  );
}

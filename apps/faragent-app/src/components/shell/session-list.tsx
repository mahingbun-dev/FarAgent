/**
 * The rail: this host's sessions, grouped by the working directory they share.
 *
 * Groups collapse, the list is budgeted so a host with 200 rollouts does not
 * drown the rail, and a row's dot carries the live/running/idle state the TUI
 * prints as a word.
 */
import { useMemo, useState } from "react";
import { ChevronRight, Loader2, Plus, RefreshCw } from "lucide-react";
import { Empty, Spinner } from "@/components/ui/empty";
import { ProblemInline } from "@/components/shell/problem";
import { useSessionLauncher } from "@/components/shell/session-launcher";
import { useProbe, useSessions } from "@/components/shell/use-shell-data";
import { cn } from "@/lib/utils";
import type { Session } from "@/lib/ipc";
import { AGENT_TITLES } from "@/lib/agents";
import {
  SESSION_PAGE,
  budgetGroups,
  groupByWorkspace,
  type WorkspaceGroup,
} from "@/lib/session-groups";
import { sessionTabKey } from "@/lib/tab-keys";
import { useStore, useT } from "@/state";

type Mark = "live" | "running" | "scheduled" | "idle";

/**
 * The word the TUI prints for each mark, as an i18n key rather than a literal.
 *
 * This is the dot's accessible name, so it is user-facing text and it is in both
 * tables. `live` and `running` are different facts — a `live` tmux session
 * versus an agent process that is running — and the words say which.
 */
const MARK_LABEL: Record<Mark, string> = {
  live: "session.mark.live",
  running: "session.mark.running",
  scheduled: "session.mark.scheduled",
  idle: "session.mark.idle",
};

/**
 * Filled = something is happening; hollow = idle, as in the reference.
 *
 * ## Why this is not `aria-hidden`
 *
 * It was, with the raw mark ("live", "idle") in `title` — so the *only* way to
 * read a session's state was a hover tooltip, and a screen reader got nothing at
 * all. The dot is the whole carrier of that state in the rail, so it is now a
 * labelled `role="img"`: its name joins the row's own, and the button above it
 * announces "&lt;title&gt;, live session". `title` keeps the tooltip working for a
 * mouse, and is the same translated word, so the two cannot disagree.
 */
function StatusDot({ mark }: { mark: Mark }) {
  const t = useT();
  const label = t(MARK_LABEL[mark]);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        mark === "idle" && "border border-mark-idle",
        mark === "live" && "bg-mark-live",
        mark === "running" && "bg-mark-running",
        mark === "scheduled" && "bg-mark-idle",
      )}
    />
  );
}

function markOf(session: Session): Mark {
  if (session.live) return "live";
  if (session.running) return "running";
  if (session.scheduled) return "scheduled";
  return "idle";
}

function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  onNew,
  toggleTitle,
  newTitle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onNew: () => void;
  toggleTitle: string;
  newTitle: string;
}) {
  return (
    <div className="group/group flex items-center gap-0.5 px-1 pt-2 pb-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={toggleTitle}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-micro font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-base",
            !collapsed && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums opacity-60">{count}</span>
      </button>
      <button
        type="button"
        onClick={onNew}
        title={newTitle}
        aria-label={newTitle}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity",
          "hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100",
          "opacity-0 group-hover/group:opacity-100",
        )}
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

export function SessionList() {
  const t = useT();
  const host = useStore((s) => s.host);
  const agent = useStore((s) => s.agent);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openTab = useStore((s) => s.openTab);
  const { open, requestNew } = useSessionLauncher();

  const probe = useProbe(host?.alias ?? null);
  const os = probe.data?.os ?? "posix";
  const sessions = useSessions(host?.alias ?? null, agent, os, !!probe.data);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [limit, setLimit] = useState(SESSION_PAGE);

  const activeKey = tabs.find((tab) => tab.id === activeTabId)?.key ?? null;
  const alias = host?.alias ?? null;

  const rows = sessions.data ?? [];
  const model = useMemo(() => {
    const interactive = rows.filter((s) => !s.scheduled);
    const scheduled = rows.filter((s) => s.scheduled);
    const { groups, hidden } = budgetGroups(groupByWorkspace(interactive), limit);
    return { groups, hidden, scheduled };
  }, [rows, limit]);

  if (!host || !alias) return null;

  const groupKey = (group: WorkspaceGroup) => group.cwd ?? "\0none";
  const labelOf = (group: WorkspaceGroup) => group.cwd ?? t("sidebar.noWorkspace");

  const sessionRow = (session: Session) => {
    const active = activeKey === sessionTabKey(alias, agent, session.id);
    return (
      <button
        key={`${host.alias}:${session.id}`}
        type="button"
        onClick={() => open(session)}
        title={session.title ?? session.id}
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-3 text-left text-sm transition-colors",
          active
            ? "bg-surface-selected text-foreground"
            : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        )}
      >
        <StatusDot mark={markOf(session)} />
        <span className="min-w-0 flex-1 truncate">{session.title ?? session.id}</span>
      </button>
    );
  };

  const showScheduled = model.scheduled.length > 0 || agent === "codex";
  const nothing =
    model.groups.length === 0 &&
    model.scheduled.length === 0 &&
    !sessions.isLoading &&
    !sessions.error &&
    !!probe.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1 px-3">
        <span className="min-w-0 flex-1 truncate text-micro font-medium tracking-wide text-muted-foreground uppercase">
          {AGENT_TITLES[agent]}
        </span>
        {sessions.isFetching ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        <button
          type="button"
          onClick={() => void sessions.refetch()}
          title={t("hosts.refresh")}
          aria-label={t("hosts.refresh")}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* The only scroll container in the rail — the switchers live in the
          titlebar above it, so their popovers have nothing to be clipped by. */}
      <nav
        aria-label={t("sidebar.workspaces")}
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-2"
      >
        {probe.isLoading || (probe.isFetching && !probe.data) ? (
          <Spinner label={t("hosts.probing", { host: alias })} />
        ) : null}
        {probe.error && !probe.data ? (
          <div className="p-1">
            <ProblemInline host={alias} error={probe.error} onOpen={openTab} />
          </div>
        ) : null}
        {sessions.isLoading || (sessions.isFetching && !sessions.data) ? (
          <Spinner label={t("sessions.listing")} />
        ) : null}
        {sessions.error && !sessions.data ? (
          <div className="p-1">
            <ProblemInline host={alias} error={sessions.error} onOpen={openTab} />
          </div>
        ) : null}

        {model.groups.map((group) => {
          const key = groupKey(group);
          const isCollapsed = !!collapsed[key];
          return (
            <div key={key}>
              <GroupHeader
                label={labelOf(group)}
                count={group.sessions.length}
                collapsed={isCollapsed}
                onToggle={() =>
                  setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
                }
                onNew={() => requestNew(group.cwd ?? undefined)}
                toggleTitle={t("sidebar.toggleGroup")}
                newTitle={t("sidebar.newIn")}
              />
              {isCollapsed ? null : (
                <ul className="space-y-px">{group.sessions.map(sessionRow)}</ul>
              )}
            </div>
          );
        })}

        {model.hidden > 0 ? (
          <button
            type="button"
            onClick={() => setLimit((prev) => prev + SESSION_PAGE)}
            className="mt-1 w-full rounded-md px-3 py-1.5 text-left text-xs font-medium text-link transition-colors hover:bg-surface-hover"
          >
            {t("sidebar.showMore", { count: Math.min(model.hidden, SESSION_PAGE) })}
          </button>
        ) : null}

        {showScheduled ? (
          <>
            <GroupHeader
              label={t("sessions.scheduled")}
              count={model.scheduled.length}
              collapsed={!!collapsed["\0scheduled"]}
              onToggle={() =>
                setCollapsed((prev) => ({
                  ...prev,
                  "\0scheduled": !prev["\0scheduled"],
                }))
              }
              onNew={() => requestNew()}
              toggleTitle={t("sidebar.toggleGroup")}
              newTitle={t("sidebar.newIn")}
            />
            {collapsed["\0scheduled"] ? null : model.scheduled.length === 0 ? (
              <p className="px-3 py-1 text-micro text-muted-foreground">
                {t("sessions.scheduledEmpty")}
              </p>
            ) : (
              <ul className="space-y-px">{model.scheduled.map(sessionRow)}</ul>
            )}
          </>
        ) : null}

        {nothing ? (
          <div className="p-1">
            <Empty>{t("sessions.empty")}</Empty>
          </div>
        ) : null}
      </nav>
    </div>
  );
}

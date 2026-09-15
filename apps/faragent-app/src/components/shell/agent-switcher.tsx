/**
 * The agent switcher: the old AgentsPage, collapsed into the titlebar.
 *
 * Picking an agent only changes what the rail lists; installing, upgrading and
 * uninstalling all run through the same plan → confirm → install-tab flow the
 * page used.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InstallDialog } from "@/components/dialogs";
import { RowAction } from "@/components/shell/row-action";
import { useProbe } from "@/components/shell/use-shell-data";
import { cn } from "@/lib/utils";
import { errorMessage, ipc, pick } from "@/lib/ipc";
import type { Action, AgentKind, Plan } from "@/lib/ipc";
import { AGENTS, AGENT_TITLES } from "@/lib/agents";
import { installTabKey } from "@/lib/tab-keys";
import { useStore, useT } from "@/state";

/** Fetch the plan, then show the confirm dialog (mirrors the TUI's S6). */
function PlanFlow({
  host,
  agent,
  action,
  lang,
  onClose,
  onRun,
}: {
  host: string;
  agent: AgentKind;
  action: Action;
  lang: "zh" | "en";
  onClose: () => void;
  onRun: (plan: Plan) => void;
}) {
  const plan = useQuery({
    queryKey: ["plan", host, agent, action],
    queryFn: () => ipc.installPlan(host, agent, action),
  });
  return (
    <InstallDialog
      plan={plan.data ?? null}
      lang={lang}
      onCancel={onClose}
      onRun={() => plan.data && onRun(plan.data)}
    />
  );
}

export function AgentSwitcher() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const host = useStore((s) => s.host);
  const agent = useStore((s) => s.agent);
  const setAgent = useStore((s) => s.setAgent);
  const openTab = useStore((s) => s.openTab);

  const probe = useProbe(host?.alias ?? null);
  const p = probe.data;
  const sessionsSupported = !!p && (p.os === "windows" || !!p.tmux?.found);
  const [install, setInstall] = useState<{ action: Action; agent: AgentKind } | null>(
    null,
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          title={t("switch.agent")}
          className="h-7 max-w-56 justify-start border border-border px-2 hover:bg-surface-hover"
        >
          <span className="min-w-0 truncate">{AGENT_TITLES[agent]}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-88">
          <DropdownMenuLabel>{t("switch.agent")}</DropdownMenuLabel>
          {!host ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("switch.noHost")}
            </p>
          ) : null}
          {host && (probe.isLoading || (probe.isFetching && !p)) ? (
            <div className="px-2 py-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          {probe.error && !p ? (
            <p className="px-2 py-1.5 text-xs text-danger">
              {errorMessage(probe.error)}
            </p>
          ) : null}
          {AGENTS.map((kind) => {
            const a = p?.agents.find((x) => x.id === kind);
            const found = a?.found ?? false;
            const authOk = a?.authHint === "ok";
            const disabled = !host || !p;
            return (
              <DropdownMenuItem
                key={kind}
                disabled={disabled}
                onSelect={() => {
                  setAgent(kind);
                  if (!found || !sessionsSupported) {
                    setInstall({ action: "install", agent: kind });
                  }
                }}
                className={cn("items-start gap-2.5", agent === kind && "bg-surface-selected")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {AGENT_TITLES[kind]}
                  </span>
                  <span className="mt-0.5 block truncate text-micro text-muted-foreground">
                    {found ? (
                      <>
                        {a?.version ?? t("agents.versionUnknown")}
                        {" · "}
                        {authOk ? t("agents.authOk") : t("agents.authUnknown")}
                      </>
                    ) : sessionsSupported ? (
                      t("agents.notInstalled")
                    ) : (
                      t("agents.sessionsUnsupported")
                    )}
                  </span>
                </span>
                {agent === kind ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                ) : null}
                <span className="flex shrink-0 gap-0.5">
                  <RowAction
                    disabled={!found}
                    onActivate={() => setInstall({ action: "upgrade", agent: kind })}
                  >
                    {t("agents.upgrade")}
                  </RowAction>
                  <RowAction
                    disabled={!found}
                    onActivate={() => setInstall({ action: "uninstall", agent: kind })}
                  >
                    {t("agents.uninstall")}
                  </RowAction>
                </span>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void probe.refetch()}>
            <RefreshCw />
            {t("hosts.refresh")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {install && p && host ? (
        <PlanFlow
          host={host.alias}
          agent={install.agent}
          action={install.action}
          lang={lang}
          onClose={() => setInstall(null)}
          onRun={(plan) => {
            setInstall(null);
            openTab({
              key: installTabKey(host.alias, install.agent, install.action),
              title: `${AGENT_TITLES[install.agent]} · ${pick(plan.title, lang)}`,
              subtitle: host.alias,
              host: host.alias,
              // An install run is not a session: no cwd to root a tree at.
              cwd: null,
              agent: install.agent,
              // And no conversation either — an install script writes no
              // transcript, so this tab has only its terminal.
              transcript: null,
              spec: { kind: "install", script: plan.script, os: p.os },
            });
          }}
        />
      ) : null}
    </>
  );
}

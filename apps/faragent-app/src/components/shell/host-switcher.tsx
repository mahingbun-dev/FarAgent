/**
 * The host switcher: the old HostsPage, collapsed into the titlebar.
 *
 * Everything that page could do lives here — probe a host, read its health,
 * cycle its login method, sync GitHub, and report a failure with the full
 * diagnosis plus a way into an interactive login.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, GitBranch, Loader2, RefreshCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GithubSyncDialog, PasswordDialog } from "@/components/dialogs";
import { RowAction } from "@/components/shell/row-action";
import { ProblemDialog, type ProblemState } from "@/components/shell/problem";
import { useHosts, useProbe } from "@/components/shell/use-shell-data";
import { cn } from "@/lib/utils";
import { asDiagnosis, errorMessage, ipc, pick } from "@/lib/ipc";
import type { AuthMode, Host } from "@/lib/ipc";
import { loginTabKey } from "@/lib/tab-keys";
import { useStore, useT } from "@/state";

type Health = { state: "ok" | "down" | "unknown"; detail: string };

const DOT_CLASS = {
  ok: "bg-mark-live",
  down: "bg-danger",
  unknown: "bg-transparent ring-1 ring-mark-idle",
} as const;

function HealthDot({ state }: { state: Health["state"] }) {
  return (
    <span
      aria-hidden
      className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASS[state])}
    />
  );
}

/** auto → key → password → auto, matching the TUI's cycle. */
function nextAuth(mode: AuthMode): AuthMode {
  return mode === "auto" ? "key" : mode === "key" ? "password" : "auto";
}

export function HostSwitcher() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const host = useStore((s) => s.host);
  const agent = useStore((s) => s.agent);
  const selectHost = useStore((s) => s.selectHost);
  const openTab = useStore((s) => s.openTab);
  const qc = useQueryClient();

  const hostsQuery = useHosts();
  // The rail probes the selected host for its os/home too; sharing the query
  // key means the switcher reports that probe rather than a second opinion.
  const selectedProbe = useProbe(host?.alias ?? null);
  const hosts = hostsQuery.data;
  const first = hosts?.[0];

  const [health, setHealth] = useState<Record<string, Health>>({});
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemState | null>(null);
  const [githubFor, setGithubFor] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubReport, setGithubReport] = useState<
    Awaited<ReturnType<typeof ipc.githubSync>> | null
  >(null);

  // Land on a host: the rail has nothing to show without one, and the old
  // hosts page was a stop the user had to walk through before anything worked.
  useEffect(() => {
    if (!host && first) selectHost(first);
  }, [host, first, selectHost]);

  const probe = useMutation({
    mutationFn: (h: Host) => ipc.probeHost(h.alias),
    onSuccess: (p, h) => {
      qc.setQueryData(["probe", h.alias], p);
      setHealth((prev) => ({
        ...prev,
        [h.alias]: { state: "ok", detail: "" },
      }));
      selectHost(h);
    },
    onError: async (e, h) => {
      const diag = asDiagnosis(e);
      setHealth((prev) => ({
        ...prev,
        [h.alias]: {
          state: "down",
          detail: diag ? pick(diag.summary, lang) : errorMessage(e),
        },
      }));
      if (
        diag &&
        (diag.problem === "needs_password" || diag.problem === "password_denied")
      ) {
        const mux = await ipc.muxCapable();
        if (!mux && !(await ipc.askpassActive(h.alias))) {
          setPasswordFor(h.alias);
          return;
        }
      }
      setProblem({ host: h.alias, diagnosis: diag, message: diag ? null : errorMessage(e) });
    },
  });

  const cycleAuth = useMutation({
    mutationFn: ({ target, mode }: { target: Host; mode: AuthMode }) =>
      ipc.setHostAuth(target.alias, mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hosts"] }),
  });

  const healthOf = (alias: string): Health => {
    // The selected host is probed continuously by the rail, so its health is
    // whatever the shared query last saw — not just what this switcher asked.
    if (alias === host?.alias) {
      if (selectedProbe.data) return { state: "ok", detail: "" };
      if (selectedProbe.error) {
        const diag = asDiagnosis(selectedProbe.error);
        return {
          state: "down",
          detail: diag ? pick(diag.summary, lang) : errorMessage(selectedProbe.error),
        };
      }
    }
    return health[alias] ?? { state: "unknown", detail: "" };
  };

  const selected = host ? healthOf(host.alias) : { state: "unknown" as const, detail: "" };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          title={t("switch.host")}
          className="h-7 max-w-56 justify-start border border-border px-2 hover:bg-surface-hover"
        >
          <HealthDot state={selected.state} />
          <span className="min-w-0 truncate">
            {host ? host.label : t("switch.host")}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel>{t("switch.host")}</DropdownMenuLabel>
          <div className="max-h-80 overflow-y-auto">
            {hostsQuery.isLoading ? (
              <div className="px-2 py-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              </div>
            ) : null}
            {hostsQuery.error ? (
              <p className="px-2 py-1.5 text-xs text-danger">
                {errorMessage(hostsQuery.error)}
              </p>
            ) : null}
            {hosts?.length === 0 && !hostsQuery.isLoading ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {t("hosts.empty")}
              </p>
            ) : null}
            {hosts?.map((h) => {
              const state = healthOf(h.alias);
              const probing = probe.isPending && probe.variables?.alias === h.alias;
              return (
                <DropdownMenuItem
                  key={h.alias}
                  onSelect={() => probe.mutate(h)}
                  className={cn(
                    "items-start gap-2.5",
                    host?.alias === h.alias && "bg-surface-selected",
                  )}
                >
                  <HealthDot state={probing ? "unknown" : state.state} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {h.label}
                      </span>
                      {/* `auth_tag()` is the tag-or-nothing API: auto mode
                          returns an empty string, and the old hosts page
                          rendered no tag at all in that case. Render the pill
                          only when the backend actually has something to say —
                          otherwise it is an empty grey box whose only meaning
                          is in its tooltip. */}
                      {pick(h.authTag, lang).trim() ? (
                        <RowAction
                          title={t("hosts.hint")}
                          disabled={cycleAuth.isPending}
                          onActivate={() =>
                            cycleAuth.mutate({ target: h, mode: nextAuth(h.auth) })
                          }
                          className="bg-secondary font-mono text-secondary-foreground"
                        >
                          {pick(h.authTag, lang).trim()}
                        </RowAction>
                      ) : null}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-micro text-muted-foreground">
                      {probing ? (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      ) : null}
                      <span className="min-w-0 truncate">
                        {probing
                          ? t("hosts.probing", { host: h.alias })
                          : state.state === "ok"
                            ? t("switch.healthOk")
                            : state.state === "down"
                              ? state.detail || t("switch.healthDown")
                              : t("switch.healthUnknown")}
                      </span>
                    </span>
                  </span>
                  <RowAction
                    title={t("hosts.githubSync")}
                    onActivate={() => {
                      setGithubError(null);
                      setGithubReport(null);
                      setGithubFor(h.alias);
                    }}
                  >
                    <GitBranch className="h-3 w-3" />
                    {t("hosts.githubSync")}
                  </RowAction>
                </DropdownMenuItem>
              );
            })}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void hostsQuery.refetch()}>
            <RefreshCw />
            {t("hosts.refresh")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {githubFor ? (
        <GithubSyncDialog
          host={githubFor}
          lang={lang}
          busy={githubBusy}
          error={githubError}
          report={githubReport}
          onCancel={() => {
            setGithubFor(null);
            setGithubError(null);
            setGithubReport(null);
          }}
          onConfirm={async () => {
            const target = githubFor;
            setGithubBusy(true);
            setGithubError(null);
            try {
              const report = await ipc.githubSync(target);
              setGithubReport(report);
            } catch (e) {
              const diag = asDiagnosis(e);
              if (diag) {
                setGithubFor(null);
                setProblem({ host: target, diagnosis: diag, message: null });
              } else {
                setGithubError(errorMessage(e));
              }
            } finally {
              setGithubBusy(false);
            }
          }}
        />
      ) : null}

      {passwordFor ? (
        <PasswordDialog
          host={passwordFor}
          lang={lang}
          onCancel={() => setPasswordFor(null)}
          onSubmit={async (password) => {
            const target = passwordFor;
            setPasswordFor(null);
            await ipc.askpassInstall(target, password);
            const h = hosts?.find((x) => x.alias === target);
            if (h) probe.mutate(h);
          }}
        />
      ) : null}

      {problem ? (
        <ProblemDialog
          problem={problem}
          onClose={() => setProblem(null)}
          onRetry={() => {
            const h = hosts?.find((x) => x.alias === problem.host);
            setProblem(null);
            if (h) probe.mutate(h);
          }}
          onLogin={() => {
            setProblem(null);
            openTab({
              key: loginTabKey(problem.host),
              title: t("diag.login"),
              subtitle: problem.host,
              host: problem.host,
              // A login shell is not a session: there is no cwd to root a tree at.
              cwd: null,
              // Nor is it one agent's. The rail's current agent is carried onto
              // the tab so the field is never absent; it decides nothing here,
              // because `transcript: null` already means "terminal only".
              agent,
              transcript: null,
              spec: { kind: "login" },
            });
          }}
        />
      ) : null}
    </>
  );
}

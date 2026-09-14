/** The host → agent → session flow, the app's home. */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DiagnosisDialog,
  DirMissingDialog,
  GithubSyncDialog,
  InstallDialog,
  NewSessionDialog,
  PasswordDialog,
  RunningConfirmDialog,
} from "@/components/dialogs";
import { cn } from "@/lib/utils";
import {
  asDiagnosis,
  errorMessage,
  ipc,
  pick,
} from "@/lib/ipc";
import type {
  Action,
  AgentKind,
  AuthMode,
  Diagnosis,
  Host,
  Plan,
  Probe,
  Session,
} from "@/lib/ipc";
import { AGENTS, AGENT_TITLES, tmuxName } from "@/lib/agents";
import { translate } from "@/lib/i18n";
import { useStore } from "@/state";

function useT() {
  const lang = useStore((s) => s.lang);
  return (k: string, p?: Record<string, string | number>) =>
    translate(lang, k, p);
}

/** A connection problem to open as a full-report dialog. */
interface ProblemState {
  host: string;
  diagnosis: Diagnosis | null;
  message: string | null;
}

// ------------------------------------------------------------------ hosts

export function HostsPage() {
  const t = useT();
  const qc = useQueryClient();
  const { selectHost, openTab } = useStore();
  const [problem, setProblem] = useState<ProblemState | null>(null);
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [githubFor, setGithubFor] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubReport, setGithubReport] = useState<
    Awaited<ReturnType<typeof ipc.githubSync>> | null
  >(null);

  const hosts = useQuery({ queryKey: ["hosts"], queryFn: ipc.listHosts });

  const probe = useMutation({
    mutationFn: (host: Host) => ipc.probeHost(host.alias),
    onSuccess: (p, host) => {
      qc.setQueryData(["probe", host.alias], p);
      selectHost(host);
    },
    onError: async (e, host) => {
      const diag = asDiagnosis(e);
      if (
        diag &&
        (diag.problem === "needs_password" || diag.problem === "password_denied")
      ) {
        const mux = await ipc.muxCapable();
        if (!mux && !(await ipc.askpassActive(host.alias))) {
          setPasswordFor(host.alias);
          return;
        }
      }
      setProblem({
        host: host.alias,
        diagnosis: diag,
        message: diag ? null : errorMessage(e),
      });
    },
  });

  const cycleAuth = useMutation({
    mutationFn: ({ host, mode }: { host: Host; mode: AuthMode }) =>
      ipc.setHostAuth(host.alias, mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["hosts"] }),
  });

  const nextAuth = (mode: AuthMode): AuthMode =>
    mode === "auto" ? "key" : mode === "key" ? "password" : "auto";

  return (
    <Page
      title={t("hosts.title")}
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => qc.invalidateQueries({ queryKey: ["hosts"] })}
          >
            <RefreshCw /> {t("hosts.refresh")}
          </Button>
        </>
      }
      hint={t("hosts.hint")}
    >
      {hosts.isLoading ? <Spinner /> : null}
      {hosts.data?.length === 0 ? (
        <Empty>{t("hosts.empty")}</Empty>
      ) : null}
      <ul className="space-y-1">
        {hosts.data?.map((h) => (
          <li key={h.alias}>
            <button
              onClick={() => probe.mutate(h)}
              disabled={probe.isPending}
              className={cn(
                "group flex w-full items-center justify-between rounded-md border border-transparent px-3 py-2.5 text-left transition-colors",
                "hover:border-border hover:bg-card",
              )}
            >
              <span className="flex items-baseline gap-2">
                <span className="text-sm font-medium">{h.label}</span>
                {pick(h.authTag, useStore.getState().lang) ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      cycleAuth.mutate({ host: h, mode: nextAuth(h.auth) });
                    }}
                    className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground hover:bg-border"
                    title={t("hosts.hint")}
                  >
                    {pick(h.authTag, useStore.getState().lang).trim()}
                  </button>
                ) : null}
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setGithubError(null);
                    setGithubReport(null);
                    setGithubFor(h.alias);
                  }}
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
                >
                  {t("hosts.githubSync")}
                </button>
                {probe.isPending && probe.variables?.alias === h.alias ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("hosts.probing", { host: h.alias })}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {githubFor ? (
        <GithubSyncDialog
          host={githubFor}
          lang={useStore.getState().lang}
          busy={githubBusy}
          error={githubError}
          report={githubReport}
          onCancel={() => {
            setGithubFor(null);
            setGithubError(null);
            setGithubReport(null);
          }}
          onConfirm={async () => {
            const host = githubFor;
            setGithubBusy(true);
            setGithubError(null);
            try {
              const report = await ipc.githubSync(host);
              setGithubReport(report);
            } catch (e) {
              const diag = asDiagnosis(e);
              if (diag) {
                setGithubFor(null);
                setProblem({
                  host,
                  diagnosis: diag,
                  message: null,
                });
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
          lang={useStore.getState().lang}
          onCancel={() => setPasswordFor(null)}
          onSubmit={async (password) => {
            const host = passwordFor;
            setPasswordFor(null);
            await ipc.askpassInstall(host, password);
            const h = hosts.data?.find((x) => x.alias === host);
            if (h) probe.mutate(h);
          }}
        />
      ) : null}

      {problem ? (
        <ProblemDialog
          problem={problem}
          onClose={() => setProblem(null)}
          onRetry={() => {
            const h = hosts.data?.find((x) => x.alias === problem.host);
            setProblem(null);
            if (h) probe.mutate(h);
          }}
          onLogin={() => {
            setProblem(null);
            openTab({
              title: translate(useStore.getState().lang, "diag.login"),
              subtitle: problem.host,
              host: problem.host,
              spec: { kind: "login" },
            });
          }}
        />
      ) : null}
    </Page>
  );
}

// ----------------------------------------------------------------- agents

export function AgentsPage() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const { host, setAgent, setView, openTab } = useStore();
  const [install, setInstall] = useState<{ action: Action; agent: AgentKind } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const probe = useQuery({
    queryKey: ["probe", host?.alias],
    queryFn: () => ipc.probeHost(host!.alias),
    enabled: !!host,
  });

  if (!host) {
    return (
      <Page title={t("agents.title")} back={() => setView("hosts")}>
        <Empty>{t("hosts.empty")}</Empty>
      </Page>
    );
  }
  const p: Probe | undefined = probe.data;
  const sessionsSupported = !!p && (p.os === "windows" || !!p.tmux?.found);

  return (
    <Page
      title={`${t("agents.title")} · ${host.alias}`}
      back={() => setView("hosts")}
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => probe.refetch()}
        >
          <RefreshCw />
        </Button>
      }
      hint={t("hosts.hint")}
    >
      {probe.isLoading || (probe.isFetching && !p) ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("hosts.probing", { host: host.alias })}
        </div>
      ) : null}
      {probe.error && !p ? (
        <ProblemInline
          host={host.alias}
          error={probe.error}
          onOpen={openTab}
        />
      ) : null}
      <ul className="space-y-1">
        {AGENTS.map((kind) => {
          const a = p?.agents.find((x) => x.id === kind);
          const found = a?.found ?? false;
          const version = a?.version ?? null;
          const authOk = a?.authHint === "ok";
          return (
            <li
              key={kind}
              className="flex items-center justify-between rounded-md border border-transparent px-3 py-2.5 hover:border-border hover:bg-card"
            >
              <button
                className="flex flex-1 items-baseline gap-3 text-left"
                onClick={() => {
                  setAgent(kind);
                  setRowError(null);
                  if (!found || !sessionsSupported) {
                    setInstall({ action: "install", agent: kind });
                  } else {
                    setView("sessions");
                  }
                }}
              >
                <span className="w-28 text-sm font-medium">
                  {AGENT_TITLES[kind]}
                </span>
                {found ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {version ?? t("agents.versionUnknown")}
                    {" · "}
                    {authOk ? t("agents.authOk") : t("agents.authUnknown")}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {sessionsSupported
                      ? t("agents.notInstalled")
                      : t("agents.sessionsUnsupported")}
                  </span>
                )}
              </button>
              <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 [li:hover_&]:opacity-100">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!found}
                  onClick={() => setInstall({ action: "upgrade", agent: kind })}
                >
                  {t("agents.upgrade")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!found}
                  onClick={() => setInstall({ action: "uninstall", agent: kind })}
                >
                  {t("agents.uninstall")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {rowError ? (
        <p className="mt-3 text-xs text-danger">{rowError}</p>
      ) : null}

      {install && p ? (
        <PlanFlow
          host={host.alias}
          agent={install.agent}
          action={install.action}
          os={p.os}
          lang={lang}
          onClose={() => setInstall(null)}
          onRun={(plan) => {
            setInstall(null);
            openTab({
              title: `${AGENT_TITLES[install.agent]} · ${pick(plan.title, lang)}`,
              subtitle: host.alias,
              host: host.alias,
              spec: { kind: "install", script: plan.script, os: p.os },
            });
          }}
        />
      ) : null}
    </Page>
  );
}

/** Fetch the plan, then show the confirm dialog (mirrors the TUI's S6). */
function PlanFlow({
  host,
  agent,
  action,
  os,
  lang,
  onClose,
  onRun,
}: {
  host: string;
  agent: AgentKind;
  action: Action;
  os: "posix" | "windows";
  lang: "zh" | "en";
  onClose: () => void;
  onRun: (plan: Plan) => void;
}) {
  const plan = useQuery({
    queryKey: ["plan", host, agent, action],
    queryFn: () => ipc.installPlan(host, agent, action),
  });
  void os;
  return (
    <InstallDialog
      plan={plan.data ?? null}
      lang={lang}
      onCancel={onClose}
      onRun={() => plan.data && onRun(plan.data)}
    />
  );
}

// --------------------------------------------------------------- sessions

export function SessionsPage() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const qc = useQueryClient();
  const { host, agent, setView, openTab } = useStore();
  const [newSession, setNewSession] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const [pendingDir, setPendingDir] = useState<{
    dir: string;
    resume: Session | null;
  } | null>(null);
  const [runningFor, setRunningFor] = useState<Session | null>(null);
  const [problem, setProblem] = useState<ProblemState | null>(null);
  const [busy, setBusy] = useState(false);

  const probe = useQuery({
    queryKey: ["probe", host?.alias],
    queryFn: () => ipc.probeHost(host!.alias),
    enabled: !!host,
  });
  const os = probe.data?.os ?? "posix";

  const sessions = useQuery({
    queryKey: ["sessions", host?.alias, agent, os],
    queryFn: () => ipc.listSessions(host!.alias, agent, os),
    enabled: !!host && !!probe.data,
  });

  const defaultCwd = useMemo(
    () =>
      sessions.data?.find((s) => s.cwd)?.cwd ??
      probe.data?.home ??
      "",
    [sessions.data, probe.data],
  );

  if (!host) {
    return (
      <Page title={t("sessions.title")} back={() => setView("hosts")}>
        <Empty>{t("hosts.empty")}</Empty>
      </Page>
    );
  }
  if (!probe.data) {
    return (
      <Page
        title={`${t("sessions.title")} · ${host.alias} · ${AGENT_TITLES[agent]}`}
        back={() => setView("agents")}
      >
        {probe.isLoading || probe.isFetching ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("hosts.probing", { host: host.alias })}
          </div>
        ) : probe.error ? (
          <ProblemInline
            host={host.alias}
            error={probe.error}
            onOpen={openTab}
          />
        ) : (
          <Empty>{t("sessions.empty")}</Empty>
        )}
      </Page>
    );
  }
  const hostAlias = host.alias;

  /**
   * Open the session in a terminal tab. POSIX remotes attach tmux; Windows
   * remotes have no tmux, so the agent runs in the foreground (resume vs new
   * is the backend's call — it owns the argv tables).
   */
  const attachSession = (sess: Session | null, name: string, cwd: string) => {
    openTab({
      title: `${AGENT_TITLES[agent]} · ${sess?.title ?? sess?.id ?? name}`,
      subtitle: hostAlias,
      host: hostAlias,
      spec:
        os === "windows"
          ? {
              kind: "win_agent",
              agent,
              cwd,
              session_id: sess?.id ?? null,
            }
          : { kind: "tmux", tmux_name: name },
    });
  };

  /** Ensure (or resume) the session, handling the missing-directory question. */
  const ensure = async (
    resume: Session | null,
    cwd: string,
    createCwd: boolean,
  ) => {
    setBusy(true);
    try {
      const name = await ipc.ensureSession(
        hostAlias,
        agent,
        cwd,
        resume?.id ?? null,
        createCwd,
      );
      setPendingDir(null);
      attachSession(resume, name, cwd);
      void qc.invalidateQueries({
        queryKey: ["sessions", hostAlias, agent, os],
      });
    } catch (e) {
      if (
        e &&
        typeof e === "object" &&
        "kind" in e &&
        (e as { kind: string }).kind === "cwd_missing"
      ) {
        const dir = (e as { dir?: string }).dir ?? cwd;
        setPendingDir({ dir, resume });
        return;
      }
      const diag = asDiagnosis(e);
      if (diag) {
        setProblem({ host: hostAlias, diagnosis: diag, message: null });
      } else {
        setProblem({
          host: hostAlias,
          diagnosis: null,
          message: errorMessage(e),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const open = (sess: Session) => {
    // `live` only exists on POSIX (tmux); Windows rows are idle/running.
    if (sess.live) {
      attachSession(
        sess,
        sess.tmux ?? tmuxName(agent, sess.id),
        sess.cwd ?? probe.data!.home,
      );
      return;
    }
    if (sess.running) {
      setRunningFor(sess);
      return;
    }
    void ensure(sess, sess.cwd ?? probe.data!.home, false);
  };

  return (
    <Page
      title={`${t("sessions.title")} · ${hostAlias} · ${AGENT_TITLES[agent]}`}
      back={() => setView("agents")}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => sessions.refetch()}>
            <RefreshCw />
          </Button>
          <Button size="sm" onClick={() => setNewSession(true)}>
            <Plus /> {t("sessions.new")}
          </Button>
        </>
      }
      hint={t("hosts.hint")}
    >
      {sessions.isLoading || (sessions.isFetching && !sessions.data) ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("sessions.listing")}
        </div>
      ) : null}
      {sessions.error && !sessions.data ? (
        <ProblemInline
          host={hostAlias}
          error={sessions.error}
          onOpen={openTab}
        />
      ) : null}
      {(() => {
        const rows = sessions.data ?? [];
        const interactive = rows.filter((s) => !s.scheduled);
        const scheduled = rows.filter((s) => s.scheduled);
        const showScheduled = scheduled.length > 0 || agent === "codex";
        const renderRow = (s: Session) => {
          const mark = s.live
            ? "live"
            : s.running
              ? "running"
              : s.scheduled
                ? "sched"
                : "idle";
          return (
            <li key={`${s.agent}-${s.id}`}>
              <button
                onClick={() => open(s)}
                className="flex w-full items-baseline gap-3 rounded-md border border-transparent px-3 py-2.5 text-left hover:border-border hover:bg-card"
              >
                <span
                  className={cn(
                    "w-16 font-mono text-[11px] uppercase tracking-wide",
                    mark === "live" && "text-mark-live",
                    mark === "running" && "text-mark-running",
                    (mark === "idle" || mark === "sched") && "text-mark-idle",
                  )}
                >
                  {mark}
                </span>
                <span className="flex-1 truncate text-sm">
                  {s.title ?? s.id}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {s.cwd ?? "?"}
                </span>
              </button>
            </li>
          );
        };
        if (
          interactive.length === 0 &&
          scheduled.length === 0 &&
          !sessions.isLoading &&
          !sessions.error
        ) {
          return <Empty>{t("sessions.empty")}</Empty>;
        }
        return (
          <>
            {showScheduled ? (
              <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("sessions.interactive")}
              </h2>
            ) : null}
            {interactive.length === 0 && showScheduled ? (
              <Empty>{t("sessions.empty")}</Empty>
            ) : (
              <ul className="space-y-1">{interactive.map(renderRow)}</ul>
            )}
            {showScheduled ? (
              <>
                <h2 className="mb-1 mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("sessions.scheduled")}
                </h2>
                {scheduled.length === 0 ? (
                  <p className="py-2 text-xs text-muted-foreground">
                    {t("sessions.scheduledEmpty")}
                  </p>
                ) : (
                  <ul className="space-y-1">{scheduled.map(renderRow)}</ul>
                )}
              </>
            ) : null}
          </>
        );
      })()}

      {newSession ? (
        <NewSessionDialog
          lang={lang}
          host={hostAlias}
          home={probe.data.home}
          os={os}
          defaultCwd={defaultCwd}
          recents={Array.from(
            new Set(
              (sessions.data ?? [])
                .map((s) => s.cwd?.trim())
                .filter((c): c is string => !!c),
            ),
          )}
          busy={busy}
          error={newError}
          onCancel={() => {
            setNewSession(false);
            setNewError(null);
          }}
          onStart={(cwd) => {
            if (!cwd) {
              setNewError(t("cwd.required"));
              return;
            }
            setNewSession(false);
            setNewError(null);
            void ensure(null, cwd, false);
          }}
        />
      ) : null}

      {runningFor ? (
        <RunningConfirmDialog
          lang={lang}
          onCancel={() => setRunningFor(null)}
          onConfirm={() => {
            const sess = runningFor;
            setRunningFor(null);
            void ensure(sess, sess.cwd ?? probe.data!.home, false);
          }}
        />
      ) : null}

      {pendingDir ? (
        <DirMissingDialog
          dir={pendingDir.dir}
          os={os}
          lang={lang}
          busy={busy}
          onCancel={() => setPendingDir(null)}
          onConfirm={() => {
            void ensure(pendingDir.resume, pendingDir.dir, true);
          }}
        />
      ) : null}

      {problem ? (
        <ProblemDialog
          problem={problem}
          onClose={() => setProblem(null)}
          onRetry={() => {
            setProblem(null);
            void sessions.refetch();
          }}
        />
      ) : null}
    </Page>
  );
}

// ------------------------------------------------------------------ shared

function Page({
  title,
  hint,
  actions,
  back,
  children,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  back?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-8 pt-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {back ? (
            <Button variant="ghost" size="icon" onClick={back}>
              <ChevronLeft />
            </Button>
          ) : null}
          <h1 className="font-display text-xl tracking-tight">{title}</h1>
        </div>
        <div className="flex items-center gap-1">{actions}</div>
      </div>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
      <div className="mt-5 min-h-0 flex-1 overflow-y-auto pb-8">{children}</div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function ProblemDialog({
  problem,
  onClose,
  onRetry,
  onLogin,
}: {
  problem: ProblemState;
  onClose: () => void;
  onRetry: () => void;
  onLogin?: () => void;
}) {
  const lang = useStore((s) => s.lang);
  if (problem.diagnosis) {
    return (
      <DiagnosisDialog
        diagnosis={problem.diagnosis}
        lang={lang}
        onClose={onClose}
        onRetry={onRetry}
        onLogin={onLogin}
      />
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
        <p className="text-sm text-danger">{problem.message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {translate(lang, "common.close")}
          </Button>
          <Button onClick={onRetry}>{translate(lang, "common.retry")}</Button>
        </div>
      </div>
    </div>
  );
}

function ProblemInline({
  host,
  error,
  onOpen,
}: {
  host: string;
  error: unknown;
  onOpen: (tab: {
    title: string;
    subtitle: string;
    host: string;
    spec: { kind: "login" };
  }) => void;
}) {
  const lang = useStore((s) => s.lang);
  const diag = asDiagnosis(error);
  if (!diag) {
    return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  }
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <p className="text-sm text-warning">{pick(diag.summary, lang)}</p>
      <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/60 p-2 font-mono text-xs text-danger">
        {diag.raw.trim()}
      </pre>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            onOpen({
              title: translate(lang, "diag.login"),
              subtitle: host,
              host,
              spec: { kind: "login" },
            })
          }
        >
          {translate(lang, "diag.login")}
        </Button>
      </div>
    </div>
  );
}

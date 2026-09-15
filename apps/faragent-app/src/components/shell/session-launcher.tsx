/**
 * Opening a session, and everything that can go wrong on the way there.
 *
 * The rail lists sessions and the titlebar starts new ones, so this lives in a
 * provider both can reach instead of being threaded through the layout. It owns
 * the three questions the old sessions page asked (where to run, create the
 * missing directory, the session may already be running) and the ensure →
 * attach call that follows.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DirMissingDialog,
  NewSessionDialog,
  RunningConfirmDialog,
} from "@/components/dialogs";
import { ProblemDialog, type ProblemState } from "@/components/shell/problem";
import { useProbe, useSessions } from "@/components/shell/use-shell-data";
import { asDiagnosis, errorMessage, ipc } from "@/lib/ipc";
import type { AgentKind, Session } from "@/lib/ipc";
import { AGENT_TITLES, tmuxName } from "@/lib/agents";
import { sessionTabKey } from "@/lib/tab-keys";
import { useStore, useT } from "@/state";

interface SessionLauncherValue {
  /** Attach if it is live, confirm if it may be running, else ensure and attach. */
  open: (session: Session) => void;
  /** Ask for a working directory, then start a fresh session there. */
  requestNew: (cwd?: string) => void;
  /**
   * Whether a new session can be started at all: the picker needs the host's
   * home and os, so it stays unavailable until the probe has landed. Callers
   * disable their "new session" affordance on this rather than opening nothing.
   */
  canStart: boolean;
}

const SessionLauncherContext = createContext<SessionLauncherValue | null>(null);

export function useSessionLauncher(): SessionLauncherValue {
  const value = useContext(SessionLauncherContext);
  if (!value) {
    throw new Error("useSessionLauncher must be used inside <SessionLauncherProvider>");
  }
  return value;
}

export function SessionLauncherProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const host = useStore((s) => s.host);
  const agent = useStore((s) => s.agent);
  const openTab = useStore((s) => s.openTab);
  const qc = useQueryClient();

  const probe = useProbe(host?.alias ?? null);
  const os = probe.data?.os ?? "posix";
  const sessions = useSessions(host?.alias ?? null, agent, os, !!probe.data);

  const hostAlias = host?.alias ?? null;
  const home = probe.data?.home ?? "";

  const [newFor, setNewFor] = useState<{ cwd: string } | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [pendingDir, setPendingDir] = useState<{
    dir: string;
    resume: Session | null;
  } | null>(null);
  const [runningFor, setRunningFor] = useState<Session | null>(null);
  const [problem, setProblem] = useState<ProblemState | null>(null);
  const [busy, setBusy] = useState(false);

  /** Where the new-session picker starts when nothing more specific is asked. */
  const defaultCwd = useMemo(
    () => sessions.data?.find((s) => s.cwd)?.cwd ?? home,
    [sessions.data, home],
  );

  const recents = useMemo(
    () =>
      Array.from(
        new Set(
          (sessions.data ?? [])
            .map((s) => s.cwd?.trim())
            .filter((c): c is string => !!c),
        ),
      ),
    [sessions.data],
  );

  /**
   * Open the session in a terminal tab. POSIX remotes attach tmux; Windows
   * remotes have no tmux, so the agent runs in the foreground (resume vs new
   * is the backend's call — it owns the argv tables).
   */
  const attach = useCallback(
    (target: string, forAgent: AgentKind, sess: Session | null, name: string, cwd: string) => {
      openTab({
        key: sessionTabKey(target, forAgent, sess?.id ?? name),
        title: `${AGENT_TITLES[forAgent]} · ${sess?.title ?? sess?.id ?? name}`,
        subtitle: target,
        host: target,
        cwd: cwd || null,
        agent: forAgent,
        // The file the conversation view tails. `null` for a row the list
        // inferred from tmux or a process scan — the session exists but has no
        // transcript yet, which is the chat view's "nothing here yet" state
        // rather than a reason to refuse the view.
        transcript: sess?.transcript ?? null,
        spec:
          os === "windows"
            ? { kind: "win_agent", agent: forAgent, cwd, session_id: sess?.id ?? null }
            : { kind: "tmux", tmux_name: name },
      });
    },
    [openTab, os],
  );

  /** Ensure (or resume) the session, handling the missing-directory question. */
  const ensure = useCallback(
    async (resume: Session | null, cwd: string, createCwd: boolean) => {
      if (!hostAlias) return;
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
        attach(hostAlias, agent, resume, name, cwd);
        void qc.invalidateQueries({ queryKey: ["sessions", hostAlias, agent, os] });
      } catch (e) {
        if (
          e &&
          typeof e === "object" &&
          "kind" in e &&
          (e as { kind: string }).kind === "cwd_missing"
        ) {
          setPendingDir({ dir: (e as { dir?: string }).dir ?? cwd, resume });
          return;
        }
        const diag = asDiagnosis(e);
        setProblem(
          diag
            ? { host: hostAlias, diagnosis: diag, message: null }
            : { host: hostAlias, diagnosis: null, message: errorMessage(e) },
        );
      } finally {
        setBusy(false);
      }
    },
    [agent, attach, hostAlias, os, qc],
  );

  const open = useCallback(
    (session: Session) => {
      if (!hostAlias) return;
      const cwd = session.cwd ?? home;
      // `live` only exists on POSIX (tmux); Windows rows are idle/running.
      if (session.live) {
        attach(
          hostAlias,
          agent,
          session,
          session.tmux ?? tmuxName(agent, session.id),
          cwd,
        );
        return;
      }
      if (session.running) {
        setRunningFor(session);
        return;
      }
      void ensure(session, cwd, false);
    },
    [agent, attach, ensure, home, hostAlias],
  );

  const requestNew = useCallback(
    (cwd?: string) => {
      setNewError(null);
      setNewFor({ cwd: cwd ?? defaultCwd });
    },
    [defaultCwd],
  );

  const value = useMemo(
    () => ({ open, requestNew, canStart: !!probe.data && !!hostAlias }),
    [open, requestNew, probe.data, hostAlias],
  );

  return (
    <SessionLauncherContext.Provider value={value}>
      {children}

      {newFor && hostAlias && value.canStart ? (
        <NewSessionDialog
          lang={lang}
          host={hostAlias}
          home={home}
          os={os}
          defaultCwd={newFor.cwd}
          recents={recents}
          busy={busy}
          error={newError}
          onCancel={() => {
            setNewFor(null);
            setNewError(null);
          }}
          onStart={(cwd) => {
            if (!cwd) {
              setNewError(t("cwd.required"));
              return;
            }
            setNewFor(null);
            setNewError(null);
            void ensure(null, cwd, false);
          }}
        />
      ) : null}

      {runningFor && hostAlias ? (
        <RunningConfirmDialog
          lang={lang}
          onCancel={() => setRunningFor(null)}
          onConfirm={() => {
            const session = runningFor;
            setRunningFor(null);
            void ensure(session, session.cwd ?? home, false);
          }}
        />
      ) : null}

      {pendingDir && hostAlias ? (
        <DirMissingDialog
          dir={pendingDir.dir}
          os={os}
          lang={lang}
          busy={busy}
          onCancel={() => setPendingDir(null)}
          onConfirm={() => void ensure(pendingDir.resume, pendingDir.dir, true)}
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
    </SessionLauncherContext.Provider>
  );
}

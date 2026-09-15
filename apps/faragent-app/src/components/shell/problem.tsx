/**
 * Connection problems, in the two shapes the rail needs.
 *
 * `ProblemInline` is existing product behaviour and has to survive the rewrite
 * intact: the verbatim SSH output plus a one-click path into an interactive
 * login tab. `ProblemDialog` is the same report as a modal, for the places
 * where there is no room inline (the host switcher).
 */
import { Button } from "@/components/ui/button";
import { asDiagnosis, errorMessage, pick } from "@/lib/ipc";
import type { Diagnosis } from "@/lib/ipc";
import type { TabInput } from "@/state";
import { useStore } from "@/state";
import { translate } from "@/lib/i18n";
import { loginTabKey } from "@/lib/tab-keys";
import { DiagnosisDialog } from "@/components/dialogs";

/** A connection problem to open as a full-report dialog. */
export interface ProblemState {
  host: string;
  diagnosis: Diagnosis | null;
  message: string | null;
}

export function ProblemDialog({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6">
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

export function ProblemInline({
  host,
  error,
  onOpen,
}: {
  host: string;
  error: unknown;
  onOpen: (tab: TabInput) => void;
}) {
  const lang = useStore((s) => s.lang);
  const agent = useStore((s) => s.agent);
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
              key: loginTabKey(host),
              title: translate(lang, "diag.login"),
              subtitle: host,
              host,
              // A login shell is not a session: there is no cwd to root at.
              cwd: null,
              // Nor is it any one agent's. The rail's current agent is carried
              // onto the tab so the field is never absent; it decides nothing
              // here, because `transcript: null` already means "terminal only".
              agent,
              transcript: null,
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

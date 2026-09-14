/** Modal dialogs mirroring the TUI's confirmation screens. */
import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ipc, pick, pickLines } from "@/lib/ipc";
import type { Diagnosis, DirListing, GitHubSync, Lang, Plan } from "@/lib/ipc";
import { translate } from "@/lib/i18n";

function Modal({
  title,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6 backdrop-blur-[2px]">
      <div
        className={cn(
          "flex max-h-[85vh] w-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl",
          wide ? "max-w-2xl" : "max-w-md",
        )}
      >
        <div className="border-b border-border px-4 py-3 font-display text-base">
          {title}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {children}
        </div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- diagnosis

export function DiagnosisDialog({
  diagnosis,
  lang,
  busy,
  onRetry,
  onLogin,
  onClose,
}: {
  diagnosis: Diagnosis;
  lang: Lang;
  busy?: boolean;
  onRetry: () => void;
  onLogin?: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const t = (k: string) => translate(lang, k);
  const plain = lang === "zh" ? diagnosis.plainZh : diagnosis.plainEn;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plain);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the report is selectable below anyway */
    }
  };

  return (
    <Modal
      wide
      title={
        <span className="flex items-baseline gap-2">
          {pick(diagnosis.title, lang)}
          <span className="font-mono text-xs text-muted-foreground">
            [{diagnosis.problem}]
          </span>
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? t("diag.copied") : t("diag.copy")}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t("diag.close")}
          </Button>
          {onLogin ? (
            <Button variant="secondary" onClick={onLogin} disabled={busy}>
              {t("diag.login")}
            </Button>
          ) : null}
          <Button onClick={onRetry} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("diag.retry")}
          </Button>
        </>
      }
    >
      <p className="text-sm font-medium text-warning">
        {pick(diagnosis.summary, lang)}
      </p>
      {diagnosis.needsAuth ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {t("diag.needsAuth")}
        </p>
      ) : null}
      {diagnosis.timedOut ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {t("diag.timeout")}
        </p>
      ) : null}

      {diagnosis.raw.trim() ? (
        <>
          <div className="mt-4 text-xs font-semibold">
            {pick(diagnosis.labels.raw, lang)}
          </div>
          <pre className="mt-1 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs leading-5 text-danger">
            {diagnosis.raw.trim()}
          </pre>
        </>
      ) : null}

      {diagnosis.command ? (
        <div className="mt-3 font-mono text-xs text-muted-foreground">
          {pick(diagnosis.labels.command, lang)}: {diagnosis.command}
        </div>
      ) : null}

      <div className="mt-4 text-xs font-semibold">
        {pick(diagnosis.labels.fixes, lang)}
      </div>
      <ol className="mt-1 space-y-1 text-sm leading-6">
        {pickLines(diagnosis.steps, lang).map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-muted-foreground">{i + 1}.</span>
            <span className="font-mono text-xs leading-6">{step}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 text-xs text-muted-foreground">
        {pick(diagnosis.labels.docs, lang)}: {pick(diagnosis.labels.sshDoc, lang)}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- password

export function PasswordDialog({
  host,
  lang,
  onSubmit,
  onCancel,
}: {
  host: string;
  lang: Lang;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const t = (k: string, p?: Record<string, string>) => translate(lang, k, p);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    if (!value) {
      setError(t("password.required"));
      return;
    }
    onSubmit(value);
  };

  return (
    <Modal
      title={t("password.title", { host })}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t("password.cancel")}
          </Button>
          <Button onClick={submit}>{t("password.confirm")}</Button>
        </>
      }
    >
      <p className="text-xs leading-5 text-muted-foreground">
        {t("password.body")}
      </p>
      <input
        autoFocus
        type="password"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError("");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
      />
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </Modal>
  );
}

// ------------------------------------------------------------ new session

export function NewSessionDialog({
  lang,
  host,
  home,
  os,
  defaultCwd,
  recents,
  busy,
  error,
  onStart,
  onCancel,
}: {
  lang: Lang;
  host: string;
  home: string;
  os: "posix" | "windows";
  defaultCwd: string;
  recents: string[];
  busy?: boolean;
  error?: string | null;
  onStart: (cwd: string) => void;
  onCancel: () => void;
}) {
  const t = (k: string) => translate(lang, k);
  const [cwd, setCwd] = useState(defaultCwd);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [fullPerms, setFullPerms] = useState(true);

  useEffect(() => {
    ipc.getFullPermissions().then(setFullPerms).catch(() => {});
  }, []);

  const start = () => {
    const typed = cwd.trim();
    if (!typed) {
      onStart(typed);
      return;
    }
    void ipc.expandHome(typed, home, os).then(onStart);
  };

  useEffect(() => {
    const path = cwd.trim();
    if (!path) {
      setListing(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      ipc
        .expandHome(path, home, os)
        .then((expanded) => ipc.listDirs(host, expanded))
        .then((l) => {
          if (cancelled) return;
          setListing(l);
          setListError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setListing(null);
          setListError(errorMessageFrom(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [host, home, os, cwd]);

  const go = (next: string) => {
    setCwd(next);
    setListError(null);
  };

  return (
    <Modal
      title={t("cwd.title")}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t("cwd.cancel")}
          </Button>
          <Button onClick={start} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("cwd.start")}
          </Button>
        </>
      }
    >
      <p className="text-xs leading-5 text-muted-foreground">{t("cwd.body")}</p>
      <input
        autoFocus
        value={cwd}
        placeholder={t("cwd.placeholder")}
        onChange={(e) => setCwd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") start();
          if (e.key === "Escape") onCancel();
        }}
        className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring/40"
      />
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={fullPerms}
          onChange={(e) => {
            const on = e.target.checked;
            setFullPerms(on);
            ipc.setFullPermissions(on).catch(() => {});
          }}
        />
        {t("cwd.fullPermissions")}
      </label>
      <ul className="mt-3 max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border p-1 font-mono text-xs">
        {recents.map((p) => (
          <li key={`r-${p}`}>
            <button
              type="button"
              onClick={() => go(p)}
              className="w-full rounded px-2 py-1 text-left hover:bg-secondary"
            >
              {t("cwd.recent")}  {p}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={() => go(listing?.parent || cwd)}
            className="w-full rounded px-2 py-1 text-left hover:bg-secondary"
          >
            {t("cwd.parent")}
          </button>
        </li>
        {listing?.dirs.map((name) => (
          <li key={name}>
            <button
              type="button"
              onClick={() =>
                go(
                  listing.cwd.endsWith("/") || listing.cwd.endsWith("\\")
                    ? `${listing.cwd}${name}`
                    : listing.cwd.includes("\\")
                      ? `${listing.cwd}\\${name}`
                      : `${listing.cwd}/${name}`,
                )
              }
              className="w-full rounded px-2 py-1 text-left hover:bg-secondary"
            >
              {name}
            </button>
          </li>
        ))}
      </ul>
      {listError ? (
        <p className="mt-2 text-xs text-muted-foreground">{listError}</p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </Modal>
  );
}

function errorMessageFrom(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function GithubSyncDialog({
  host,
  lang,
  busy,
  error,
  report,
  onConfirm,
  onCancel,
}: {
  host: string;
  lang: Lang;
  busy?: boolean;
  error?: string | null;
  report?: GitHubSync | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = (k: string) => translate(lang, k);
  return (
    <Modal
      title={t("hosts.githubSyncTitle")}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t("hosts.githubSyncCancel")}
          </Button>
          {!report ? (
            <Button onClick={onConfirm} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {busy ? t("hosts.githubSyncing") : t("hosts.githubSyncRun")}
            </Button>
          ) : (
            <Button onClick={onCancel}>{t("common.close")}</Button>
          )}
        </>
      }
    >
      {report ? (
        <pre className="whitespace-pre-wrap font-mono text-xs leading-5">
          {pickLines(report.lines, lang).join("\n")}
        </pre>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          {t("hosts.githubSyncBody")}
          <span className="mt-2 block font-mono text-xs">{host}</span>
        </p>
      )}
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </Modal>
  );
}

// ------------------------------------------------------------ missing dir

export function DirMissingDialog({
  dir,
  os,
  lang,
  busy,
  onConfirm,
  onCancel,
}: {
  dir: string;
  os: "posix" | "windows";
  lang: Lang;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = (k: string, p?: Record<string, string>) => translate(lang, k, p);
  const command =
    os === "posix"
      ? `mkdir -p ${dir}`
      : `New-Item -ItemType Directory -Force -LiteralPath '${dir}'`;

  return (
    <Modal
      title={t("dir.title", { dir })}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t("dir.cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("dir.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-muted-foreground">{t("dir.body")}</p>
      <div className="mt-3 text-xs text-muted-foreground">
        {t("dir.command")}:
      </div>
      <pre className="mt-1 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-primary">
        {command}
      </pre>
    </Modal>
  );
}

// ------------------------------------------------------- running confirm

export function RunningConfirmDialog({
  lang,
  onConfirm,
  onCancel,
}: {
  lang: Lang;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = (k: string) => translate(lang, k);
  return (
    <Modal
      title={t("running.title")}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t("running.cancel")}
          </Button>
          <Button onClick={onConfirm}>{t("running.confirm")}</Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-muted-foreground">
        {t("running.body")}
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------- install

export function InstallDialog({
  plan,
  lang,
  onRun,
  onCancel,
}: {
  plan: Plan | null;
  lang: Lang;
  onRun: () => void;
  onCancel: () => void;
}) {
  const t = (k: string) => translate(lang, k);
  return (
    <Modal
      wide
      title={plan ? pick(plan.title, lang) : t("install.running")}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t("install.cancel")}
          </Button>
          <Button onClick={onRun} disabled={!plan?.canRun}>
            {t("install.run")}
          </Button>
        </>
      }
    >
      {plan ? (
        <>
          <div className="text-xs text-muted-foreground">
            {pick(plan.listTitle, lang)}
          </div>
          {plan.blockedText ? (
            <p className="mt-2 text-sm font-medium text-danger">
              {pick(plan.blockedText, lang)}
            </p>
          ) : null}
          {plan.warningTexts.map((w, i) => (
            <p key={i} className="mt-2 text-sm text-warning">
              {pick(w, lang)}
            </p>
          ))}
          <ol className="mt-4 space-y-3">
            {plan.steps.map((step, i) => (
              <li key={i}>
                <div className="text-sm font-medium">
                  {i + 1}. {step.title}
                  {step.sudo ? (
                    <span className="ml-2 text-xs font-normal text-warning">
                      ({pick(plan.stepSudo, lang)})
                    </span>
                  ) : null}
                </div>
                <pre className="mt-1 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-primary">
                  {step.command}
                </pre>
              </li>
            ))}
          </ol>
          {plan.suggested.length > 0 ? (
            <>
              <div className="mt-4 text-xs font-medium text-warning">
                {pick(plan.suggestedTitle, lang)}
              </div>
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs leading-5">
                {plan.suggested.join("\n")}
              </pre>
            </>
          ) : null}
        </>
      ) : (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("install.running")}
        </div>
      )}
    </Modal>
  );
}

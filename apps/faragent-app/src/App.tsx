import { useEffect, useState } from "react";
import { Monitor, Moon, Server, Settings, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TerminalView } from "@/components/TerminalView";
import { DiagnosisDialog } from "@/components/dialogs";
import { AgentsPage, HostsPage, SessionsPage } from "@/pages";
import { cn } from "@/lib/utils";
import { ipc } from "@/lib/ipc";
import type { Diagnosis } from "@/lib/ipc";
import { initTheme, preferredTheme, setTheme, type Theme } from "@/lib/theme";
import { translate } from "@/lib/i18n";
import { useStore } from "@/state";

const THEMES: { value: Theme; icon: typeof Sun; labelKey: string }[] = [
  { value: "light", icon: Sun, labelKey: "settings.theme.light" },
  { value: "dark", icon: Moon, labelKey: "settings.theme.dark" },
  { value: "system", icon: Monitor, labelKey: "settings.theme.system" },
];

export default function App() {
  const { lang, setLang, view, setView, tab, closeTab } = useStore();
  const t = (k: string) => translate(lang, k);
  const [theme, setThemeState] = useState<Theme>(() => {
    initTheme();
    return preferredTheme();
  });
  const [diag, setDiag] = useState<Diagnosis | null>(null);

  // The UI language is the same setting the TUI writes to config.json.
  useEffect(() => {
    ipc
      .getLanguage()
      .then(setLang)
      .catch(() => {});
  }, [setLang]);

  return (
    <div className="flex h-full">
      <aside className="flex w-56 flex-col border-r border-border bg-muted/40">
        <div className="px-4 pt-5 pb-4">
          <div className="font-display text-lg leading-none tracking-tight">
            FarAgent
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {lang === "zh" ? "远程编程助手" : "remote coding agents"}
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          <NavItem
            icon={Server}
            label={t("nav.hosts")}
            active={view !== "settings"}
            onClick={() => setView("hosts")}
          />
          <NavItem
            icon={Settings}
            label={t("nav.settings")}
            active={view === "settings"}
            onClick={() => setView("settings")}
          />
        </nav>
        <div className="flex items-center gap-1 border-t border-border p-2">
          {THEMES.map(({ value, icon: Icon, labelKey }) => (
            <button
              key={value}
              title={t(labelKey)}
              onClick={() => {
                setTheme(value);
                setThemeState(value);
              }}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
                "hover:bg-secondary hover:text-secondary-foreground",
                theme === value && "bg-secondary text-secondary-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {tab ? (
          <>
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-2">
              <div className="flex min-w-0 items-baseline gap-2 px-2 py-1.5">
                <span className="truncate text-sm font-medium">
                  {tab.title}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {tab.subtitle}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={closeTab}>
                <X /> {t("term.detach")}
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <TerminalView
                host={tab.host}
                spec={tab.spec}
                onDiagnosis={setDiag}
                onExit={() => {}}
              />
            </div>
          </>
        ) : view === "settings" ? (
          <SettingsPage />
        ) : view === "agents" ? (
          <AgentsPage />
        ) : view === "sessions" ? (
          <SessionsPage />
        ) : (
          <HostsPage />
        )}
      </main>

      {diag ? (
        <DiagnosisDialog
          diagnosis={diag}
          lang={lang}
          onClose={() => setDiag(null)}
          onRetry={() => setDiag(null)}
        />
      ) : null}
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Sun;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-secondary font-medium text-secondary-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-secondary-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function SettingsPage() {
  const { lang, setLang } = useStore();
  const t = (k: string) => translate(lang, k);
  return (
    <div className="mx-auto w-full max-w-2xl px-8 pt-8">
      <h1 className="font-display text-xl tracking-tight">
        {t("settings.title")}
      </h1>

      <section className="mt-6">
        <div className="text-xs font-medium text-muted-foreground">
          {t("settings.language")}
        </div>
        <div className="mt-2 flex gap-2">
          {(["zh", "en"] as const).map((l) => (
            <Button
              key={l}
              variant={lang === l ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setLang(l);
                ipc.setLanguage(l).catch(() => {});
              }}
            >
              {l === "zh" ? "中文" : "English"}
            </Button>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <div className="text-xs font-medium text-muted-foreground">
          {t("settings.about")}
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t("settings.about.text")}
        </p>
      </section>
    </div>
  );
}

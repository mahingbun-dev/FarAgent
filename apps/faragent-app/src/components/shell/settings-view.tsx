/**
 * Settings, as a view of the workspace rather than a separate page: the rail
 * keeps the sessions in reach while you change the language or the theme.
 */
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemePicker } from "@/components/shell/theme-picker";
import { ipc } from "@/lib/ipc";
import { useStore, useT } from "@/state";

export function SettingsView() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const setView = useStore((s) => s.setView);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-content p-gutter">
        <div className="flex items-center justify-between gap-2">
          <h1 className="font-display text-2xl tracking-tight">
            {t("settings.title")}
          </h1>
          <Button variant="ghost" size="sm" onClick={() => setView("workspace")}>
            <X />
            {t("common.close")}
          </Button>
        </div>

        <section className="mt-8">
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

        <section className="mt-8">
          <div className="text-xs font-medium text-muted-foreground">
            {t("settings.theme")}
          </div>
          <ThemePicker className="mt-2" />
        </section>

        <section className="mt-8 max-w-prose">
          <div className="text-xs font-medium text-muted-foreground">
            {t("settings.about")}
          </div>
          <p className="mt-2 text-sm leading-prose text-muted-foreground">
            {t("settings.about.text")}
          </p>
        </section>
      </div>
    </div>
  );
}

/**
 * Settings, as a view of the workspace rather than a separate page: the rail
 * keeps the sessions in reach while you change the language or the theme.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemePicker } from "@/components/shell/theme-picker";
import { ipc } from "@/lib/ipc";
import { APP_CACHE_DIR, panelCache } from "@/lib/panel/cache";
import { formatBytes } from "@/lib/panel/file";
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

        <CacheSection />

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

/** How long the "cleared" acknowledgement stays on screen. */
const CLEARED_MS = 3_000;

/**
 * The disk cache: the switch, the size, the one-click clear, and the path.
 *
 * The path is not decoration. What the switch leaves on the user's own machine
 * is a copy of code from a *remote* machine, and the plan's requirement is that
 * the location be stated where the switch is — a user who cannot find it cannot
 * delete it by hand either. The same reason the note beside it says plainly
 * where the bytes actually are today, rather than naming a directory the app
 * does not yet write to.
 */
function CacheSection() {
  const t = useT();
  const enabled = useStore((s) => s.appCacheEnabled);
  const setEnabled = useStore((s) => s.setAppCacheEnabled);
  const [size, setSize] = useState(() => panelCache().size());
  const [cleared, setCleared] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A timer that outlives the view would set state on a gone component; the
  // settings page is a view, so it can be left at any moment.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const clear = () => {
    panelCache().clear();
    setSize(0);
    setCleared(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCleared(false), CLEARED_MS);
  };

  return (
    <section className="mt-8 max-w-prose">
      <div className="text-xs font-medium text-muted-foreground">
        {t("settings.cache")}
      </div>

      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            // The store clears the bucket on any change, so the size on screen
            // has to follow it.
            setSize(panelCache().size());
            setCleared(false);
          }}
          className="mt-0.5 size-3.5 shrink-0 accent-link"
        />
        <span className="min-w-0">
          <span className="block text-sm">{t("settings.cacheEnable")}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {enabled ? t("settings.cacheOn") : t("settings.cacheOff")}
          </span>
        </span>
      </label>

      {/* The designated directory, always shown, whether or not the switch is
          on — "where does this go" must be answerable before it is enabled. */}
      <p className="mt-3 break-all font-mono text-xs text-foreground">
        {t("settings.cacheDir", { path: APP_CACHE_DIR })}
      </p>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          {size === 0
            ? t("settings.cacheEmpty")
            : t("settings.cacheSize", { size: formatBytes(size) })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={size === 0}
          onClick={clear}
        >
          {cleared ? t("settings.cacheCleared") : t("settings.cacheClear")}
        </Button>
      </div>

      <p className="mt-2 text-xs leading-prose text-muted-foreground">
        {t("settings.cacheNote", { path: APP_CACHE_DIR })}
      </p>
    </section>
  );
}

/**
 * The three-state theme control (light / dark / follow the system).
 *
 * Shared by the rail footer and the settings view so both offer exactly the
 * same states and the same active marking — a second copy would be a second
 * thing to keep in sync.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";
import { useStore, useT } from "@/state";

const THEMES: { value: Theme; icon: typeof Sun; labelKey: string }[] = [
  { value: "light", icon: Sun, labelKey: "settings.theme.light" },
  { value: "dark", icon: Moon, labelKey: "settings.theme.dark" },
  { value: "system", icon: Monitor, labelKey: "settings.theme.system" },
];

export function ThemePicker({ className }: { className?: string }) {
  const t = useT();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  return (
    <div
      role="group"
      aria-label={t("settings.theme")}
      className={cn("flex items-center gap-1", className)}
    >
      {THEMES.map(({ value, icon: Icon, labelKey }) => (
        <button
          key={value}
          type="button"
          title={t(labelKey)}
          aria-label={t(labelKey)}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-surface-hover hover:text-foreground",
            theme === value && "bg-surface-selected text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

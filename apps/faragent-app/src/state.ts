/**
 * App-wide UI state. Data fetching stays in TanStack Query per shell region.
 *
 * The shell has one job for this store: keep the rail (host, agent), the
 * workspace (tabs) and the settings view consistent with each other.
 */
import { useCallback } from "react";
import { create } from "zustand";
import { PANEL } from "@/design";
import { translate } from "@/lib/i18n";
import { initTheme, preferredTheme, setTheme, type Theme } from "@/lib/theme";
import type { AgentKind, AttachSpec, Host, Lang } from "@/lib/ipc";

/** What the workspace shows. Sessions live in tabs; settings is a plain view. */
export type View = "workspace" | "settings";

/**
 * The right-hand panel's state, per tab.
 *
 * Task 9 renders it; it is modelled here (rather than inside the panel) because
 * a panel that only one tab's data could express would force a refactor of this
 * file the moment tabs become individually configurable.
 */
export interface PanelState {
  open: boolean;
  width: number;
  tab: "files" | "changes" | "git";
}

export const DEFAULT_PANEL: PanelState = {
  open: false,
  width: PANEL.defaultWidth,
  tab: "files",
};

/** One terminal tab. Its terminal stays mounted until the tab is closed. */
export interface Tab {
  /** Unique; the workspace keys its panel elements by it. */
  id: string;
  /** What the tab shows (see lib/tab-keys.ts). Re-opening it focuses this tab. */
  key: string;
  title: string;
  subtitle: string;
  host: string;
  spec: AttachSpec;
  /**
   * The session's working directory on the host, or `null` for a tab that has
   * none (the login and install tabs are not sessions).
   *
   * The right panel roots its file tree here: what a session's panel should
   * show is the code that session is working in, not the remote's `/`. A
   * `null` cwd makes the panel fall back to the host's home directory.
   */
  cwd: string | null;
  panel: PanelState;
}

export type TabInput = Omit<Tab, "id" | "panel"> & { panel?: Partial<PanelState> };

/**
 * Two tabs are the same tab if they show the same thing. The key says that
 * directly; the spec check catches the one case it cannot — a session started
 * from the new-session dialog is keyed by its tmux name, and only later does
 * the rail learn the session id for the same terminal.
 */
function sameTarget(tab: Tab, input: TabInput): boolean {
  return (
    tab.key === input.key ||
    (tab.host === input.host &&
      JSON.stringify(tab.spec) === JSON.stringify(input.spec))
  );
}

interface Store {
  lang: Lang;
  setLang: (lang: Lang) => void;

  theme: Theme;
  setTheme: (theme: Theme) => void;

  view: View;
  setView: (view: View) => void;

  host: Host | null;
  selectHost: (host: Host) => void;

  agent: AgentKind;
  setAgent: (agent: AgentKind) => void;

  tabs: Tab[];
  activeTabId: string | null;
  openTab: (tab: TabInput) => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  setPanel: (id: string, patch: Partial<PanelState>) => void;
}

// Apply the stored theme before the first paint (the store owns the
// preference, so this is the earliest a module can read it).
initTheme();

let nextTabId = 0;

export const useStore = create<Store>((set) => ({
  lang: "zh",
  setLang: (lang) => set({ lang }),

  theme: preferredTheme(),
  setTheme: (theme) => {
    setTheme(theme);
    set({ theme });
  },

  view: "workspace",
  setView: (view) => set({ view }),

  host: null,
  // Switching host deliberately leaves open tabs alone: they are per-host
  // terminals and closing them would throw away a running agent.
  selectHost: (host) => set({ host }),

  agent: "claude",
  setAgent: (agent) => set({ agent }),

  tabs: [],
  activeTabId: null,
  openTab: (input) =>
    set((state) => {
      const existing = state.tabs.find((tab) => sameTarget(tab, input));
      if (existing) {
        return {
          view: "workspace",
          activeTabId: existing.id,
          // Titles drift (a session gets renamed); keep the tab honest. The cwd
          // is kept when the re-open does not name one, so a session opened
          // again from a surface that does not know it does not lose its root.
          tabs: state.tabs.map((tab) =>
            tab.id === existing.id
              ? {
                  ...tab,
                  title: input.title,
                  subtitle: input.subtitle,
                  spec: input.spec,
                  cwd: input.cwd ?? tab.cwd,
                }
              : tab,
          ),
        };
      }
      const tab: Tab = {
        ...input,
        id: `tab-${(nextTabId += 1)}`,
        panel: { ...DEFAULT_PANEL, ...input.panel },
      };
      return { view: "workspace", tabs: [...state.tabs, tab], activeTabId: tab.id };
    }),
  selectTab: (id) => set({ activeTabId: id, view: "workspace" }),
  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      // Fall back to the neighbour on the right, then the one on the left.
      const next = tabs[index] ?? tabs[index - 1] ?? null;
      return {
        tabs,
        activeTabId: state.activeTabId === id ? next?.id ?? null : state.activeTabId,
      };
    }),
  setPanel: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id ? { ...tab, panel: { ...tab.panel, ...patch } } : tab,
      ),
    })),
}));

/**
 * `translate` bound to the current language — the shell's shorthand for the
 * `lang` prop the dialogs take.
 */
export function useT() {
  const lang = useStore((s) => s.lang);
  return useCallback(
    (key: string, params?: Record<string, string | number>) =>
      translate(lang, key, params),
    [lang],
  );
}

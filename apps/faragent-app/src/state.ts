/**
 * App-wide UI state. Data fetching stays in TanStack Query per shell region.
 *
 * The shell has one job for this store: keep the rail (host, agent), the
 * workspace (tabs) and the settings view consistent with each other.
 */
import { useCallback } from "react";
import { create } from "zustand";
import { PANEL } from "@/design";
import { adapterFor } from "@/lib/chat/adapters";
import { translate } from "@/lib/i18n";
import {
  appCacheEnabled as readAppCacheEnabled,
  panelCache,
  setAppCacheEnabled as writeAppCacheEnabled,
} from "@/lib/panel/cache";
import { initTheme, preferredTheme, setTheme, type Theme } from "@/lib/theme";
import type { AgentKind, AttachSpec, Host, Lang } from "@/lib/ipc";

/** What the workspace shows. Sessions live in tabs; settings is a plain view. */
export type View = "workspace" | "settings";

/**
 * Which way a session tab is looking at its session.
 *
 * A tab has two views of one session, and they are not interchangeable:
 *
 * - `terminal` is the agent's own TUI, and it is the **only** surface that can
 *   answer a permission prompt or take a slash command. It stays mounted
 *   whichever view is showing.
 * - `chat` is the session's transcript, rendered (`components/chat/`). It is
 *   read-only by construction — nothing here writes to the PTY.
 *
 * `chat` is only offered to an agent that has an adapter (see
 * `lib/chat/adapters/index.ts`); a tab whose agent has none starts and stays on
 * the terminal, which is the designed fallback rather than a degraded state.
 */
export type TabView = "chat" | "terminal";

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
  /**
   * The agent this tab belongs to.
   *
   * It is here rather than read back off the rail because a tab outlives the
   * rail's selection: switching the agent switcher to Codex must not change what
   * an open Claude tab is showing. It is also what decides whether the tab has a
   * chat view at all — only an agent with an adapter does.
   *
   * A login or install tab names the agent it is about (`spec.kind` carries it
   * for an install run); neither has a session behind it, so neither reaches the
   * chat whatever this says.
   */
  agent: AgentKind;
  /**
   * The remote path of this session's conversation file, or `null` when there is
   * none to read.
   *
   * `null` is the ordinary case for a row the rail inferred from tmux or a
   * process scan, and for a login or install tab. The chat view says so rather
   * than showing an empty pane.
   */
  transcript: string | null;
  /** Which view is showing. See {@link TabView}. */
  view: TabView;
  panel: PanelState;
}

export type TabInput = Omit<Tab, "id" | "panel" | "view"> & {
  panel?: Partial<PanelState>;
  /**
   * Which view to open on. Omit to take {@link defaultTabView}, which is what
   * every caller does — an explicit value is for a caller that has a reason.
   * Re-opening an existing tab never changes its view: the reader's choice
   * stands. (The one exception is not a choice at all — see the `view` field in
   * `openTab`, where a re-open that could no longer offer the view showing falls
   * back to the terminal rather than stranding the tab.)
   */
  view?: TabView;
};

/** Whether this tab's agent has a conversation view at all. */
export function tabHasChatView(tab: Tab): boolean {
  return adapterFor(tab.agent) !== null;
}

/**
 * The view a freshly opened tab starts on.
 *
 * Chat when there is something to render — the agent has an adapter and the
 * session list named a transcript — and the terminal otherwise. An agent with no
 * adapter has no chat view to open, and a tab with no transcript has no file to
 * read, so both open on the terminal rather than on a pane that would say
 * nothing.
 */
function defaultTabView(tab: Pick<TabInput, "agent" | "transcript">): TabView {
  return tab.transcript !== null && adapterFor(tab.agent) !== null ? "chat" : "terminal";
}

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
  /**
   * Switch a tab between its terminal and its conversation.
   *
   * Not `setView`, which is already the shell's own workspace↔settings switch —
   * two different things called a view in one store is a name that would be
   * misread at every call site. This sits beside `setPanel` because it is the
   * same shape: one tab, one field of it.
   */
  setTabView: (id: string, view: TabView) => void;

  /**
   * Whether the panel keeps a copy of what it reads on this machine.
   *
   * Off by default, and read from storage at startup so the choice survives a
   * restart. The copy can contain code from a remote machine, which is why the
   * setting is off and why the settings page names the directory — see
   * `lib/panel/cache.ts`.
   */
  appCacheEnabled: boolean;
  setAppCacheEnabled: (enabled: boolean) => void;
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
                  // The transcript path is learned from the session list, which
                  // is the surface that has it; a re-open from one that does not
                  // know it keeps the path the tab already had, exactly as it
                  // keeps the cwd.
                  agent: input.agent,
                  transcript: input.transcript ?? tab.transcript,
                  // Which way the reader is looking is theirs, not the opener's —
                  // but only while it is still a view this tab has. A re-open can
                  // change the agent (`sameTarget`'s tmux branch compares specs
                  // that carry no agent), and a tab left on `chat` with an agent
                  // that has no adapter is a dead end: the conversation pane says
                  // there is none, and the toggle back is *disabled*. So the view
                  // is kept unless the tab could no longer offer it, in which case
                  // it falls back to the terminal on the terms `defaultTabView`
                  // already defines.
                  view:
                    defaultTabView({
                      agent: input.agent,
                      transcript: input.transcript ?? tab.transcript,
                    }) === "terminal"
                      ? "terminal"
                      : tab.view,
                }
              : tab,
          ),
        };
      }
      const tab: Tab = {
        ...input,
        id: `tab-${(nextTabId += 1)}`,
        view: input.view ?? defaultTabView(input),
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
  setTabView: (id, view) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, view } : tab)),
    })),

  appCacheEnabled: readAppCacheEnabled(),
  setAppCacheEnabled: (enabled) => {
    writeAppCacheEnabled(enabled);
    // Whatever is on disk was written under the old setting, so changing it
    // clears the cache: turning it off must not leave a copy of the user's
    // remote code behind, and turning it on must not restore rows the user
    // never agreed to. The setting starts each state with an empty cache.
    panelCache().clear();
    set({ appCacheEnabled: enabled });
  },
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

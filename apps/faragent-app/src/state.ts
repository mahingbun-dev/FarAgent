/** App-wide UI state. Data fetching stays in TanStack Query per page. */
import { create } from "zustand";
import type { AgentKind, AttachSpec, Host, Lang } from "@/lib/ipc";

export type View = "hosts" | "agents" | "sessions" | "settings";

/** One live terminal tab (v1: at most one; the manager is multi-tab ready). */
export interface Tab {
  title: string;
  subtitle: string;
  host: string;
  spec: AttachSpec;
}

interface Store {
  lang: Lang;
  setLang: (lang: Lang) => void;

  view: View;
  setView: (view: View) => void;

  host: Host | null;
  selectHost: (host: Host) => void;

  agent: AgentKind;
  setAgent: (agent: AgentKind) => void;

  tab: Tab | null;
  openTab: (tab: Tab) => void;
  closeTab: () => void;
}

export const useStore = create<Store>((set) => ({
  lang: "zh",
  setLang: (lang) => set({ lang }),

  view: "hosts",
  setView: (view) => set({ view }),

  host: null,
  selectHost: (host) => set({ host, view: "agents" }),

  agent: "claude",
  setAgent: (agent) => set({ agent }),

  tab: null,
  openTab: (tab) => set({ tab }),
  closeTab: () => set({ tab: null }),
}));

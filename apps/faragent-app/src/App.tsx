import { useEffect } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ipc } from "@/lib/ipc";
import { useStore } from "@/state";

/**
 * The shell owns everything from here down (see components/shell/). What is
 * left at the top is the one thing that has to happen before it renders: the
 * UI language is the same setting the TUI writes to config.json, so it is read
 * from the backend rather than guessed.
 */
export default function App() {
  const setLang = useStore((s) => s.setLang);

  useEffect(() => {
    ipc
      .getLanguage()
      .then(setLang)
      .catch(() => {});
  }, [setLang]);

  return <AppShell />;
}

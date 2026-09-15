/**
 * `installMocks()` — the mock layer's dev/test entry point.
 *
 * Call it once, before the first render, and the shell's `invoke()` calls land
 * on `handlers.ts` instead of a backend that does not exist. See `fixtures.ts`
 * for the data and `handlers.ts` for the per-command wiring.
 *
 * Two guards make this safe to call unconditionally from `src/main.tsx`:
 *
 * 1. `src/main.tsx` reaches this module only behind `import.meta.env.DEV`, so a
 *    production build never even loads it (the dynamic import is dead code and
 *    is dropped from the bundle — Task 3's acceptance greps `dist/` for proof).
 * 2. It refuses to install over a live Tauri runtime. `tauri dev` serves the
 *    same Vite build the browser does, so without this check the mock would
 *    clobber the real `__TAURI_INTERNALS__.invoke` and `tauri dev` would
 *    silently talk to fixtures. That would be a very bad afternoon.
 */
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { dispatch } from "./handlers.ts";
import { pokeGitChanged, pokeWatch } from "./helper.ts";

/**
 * Re-exported so browser verification can drive a push on demand.
 *
 * `installMocks` also hangs them off `globalThis.__faragentMock`, which is the
 * handle the browser harness actually uses: it does not have to resolve a
 * module specifier or care how Vite has rewritten it.
 */
export { pokeGitChanged, pokeWatch };

export interface InstallMocksOptions {
  /** Install even when it would not install on its own (the Node test runner). */
  force?: boolean;
}

let installed = false;

type TauriWindow = {
  __TAURI_INTERNALS__?: { invoke?: unknown };
};

function currentWindow(): TauriWindow | undefined {
  return (globalThis as { window?: TauriWindow }).window;
}

/** True when something already answers `invoke` — i.e. a real Tauri backend. */
function hasRealRuntime(): boolean {
  return typeof currentWindow()?.__TAURI_INTERNALS__?.invoke === "function";
}

/**
 * Install the mock IPC backend. Idempotent; returns whether this call did the
 * installing, which the tests assert on.
 */
export function installMocks(options: InstallMocksOptions = {}): boolean {
  if (installed) return false;
  if (!currentWindow()) return false;
  if (!options.force && hasRealRuntime()) return false;

  // `metadata` is what `@tauri-apps/api/window` reads to answer "which window am
  // I?"; it costs nothing and keeps a later task from tripping over its absence.
  mockWindows("main");
  mockIPC((cmd, payload) => dispatch(cmd, payload));
  // The push channel has no filesystem behind it to change by itself, so a
  // verification of "the panel refreshes when the remote pushes" needs a way to
  // send the push. Dev-only, because this whole module is.
  (globalThis as { __faragentMock?: unknown }).__faragentMock = {
    pokeWatch,
    pokeGitChanged,
  };
  installed = true;
  return true;
}

/** Undo `installMocks` (tests only — nothing in the app needs to un-mock). */
export function uninstallMocks(): void {
  if (!installed) return;
  clearMocks();
  installed = false;
}

/** Whether the mock backend is currently answering `invoke`. */
export function mocksInstalled(): boolean {
  return installed;
}

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

/**
 * Boot the shell, with a backend if there is one.
 *
 * A Tauri app in a plain browser has no `invoke()` target, so every region of
 * the shell falls back to its error state. `src/lib/mock` fills that hole for
 * browser development and UI verification. It is reached through a dynamic
 * import behind `import.meta.env.DEV`, which Vite replaces with `false` in a
 * production build — so the branch, and the mock chunk it pulls in, are dropped
 * from `dist/` entirely (Task 3's acceptance greps for proof).
 *
 * `installMocks()` also refuses to install over a live Tauri runtime, which is
 * what keeps `tauri dev` — the same Vite server — on the real backend.
 */
async function bootstrap() {
  if (import.meta.env.DEV) {
    const { installMocks } = await import("@/lib/mock");
    installMocks();
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void bootstrap();

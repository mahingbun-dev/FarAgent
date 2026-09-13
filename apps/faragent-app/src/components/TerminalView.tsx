/**
 * The terminal: one xterm.js instance per open tab, wired to a PTY session
 * in the Rust core over a Tauri channel. Every byte that reaches the remote
 * agent (and every byte it renders) passes through here unchanged — same
 * passthrough contract as the TUI.
 */
import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { asDiagnosis, errorMessage, ipc } from "@/lib/ipc";
import type { AttachEvent, AttachSpec, Diagnosis } from "@/lib/ipc";
import { b64ToBytes, bytesToB64 } from "@/lib/bytes";

/** Read a CSS custom property so the terminal shares the app's palette. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

export function TerminalView({
  host,
  spec,
  onDiagnosis,
  onExit,
}: {
  host: string;
  spec: AttachSpec;
  onDiagnosis: (d: Diagnosis) => void;
  onExit: (code: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const specKey = JSON.stringify(spec);

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const background = cssVar("--background", "#faf9f5");
    const foreground = cssVar("--foreground", "#2d2a26");
    const accent = cssVar("--primary", "#c96442");
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: cssVar("--font-mono", "ui-monospace, Menlo, monospace"),
      scrollback: 20_000,
      allowProposedApi: true,
      theme: {
        background,
        foreground,
        cursor: accent,
        cursorAccent: background,
        selectionBackground: accent + "40",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    // Let layout settle before the first fit (fonts/metrics).
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* layout not ready; the observer will catch up */
      }
    });

    let sessionId: number | null = null;
    let disposed = false;

    const channel = new Channel<AttachEvent>();
    channel.onmessage = (event) => {
      if (event.kind === "data") {
        term.write(b64ToBytes(event.b64));
      } else if (event.kind === "exit") {
        term.write(
          `\r\n\x1b[2m── faragent: exit ${event.code} ──\x1b[0m\r\n`,
        );
        onExit(event.code);
      } else {
        term.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
      }
    };

    (async () => {
      try {
        const id = await ipc.attachOpen({
          host,
          spec: JSON.parse(specKey) as AttachSpec,
          cols: term.cols,
          rows: term.rows,
          onEvent: channel,
        });
        if (disposed) {
          await ipc.attachClose(id).catch(() => {});
          return;
        }
        sessionId = id;
        term.focus();
        term.onData((data) => {
          const id = sessionId;
          if (id === null) return;
          ipc
            .attachWrite(id, bytesToB64(new TextEncoder().encode(data)))
            .catch(() => {});
        });
      } catch (e) {
        const d = asDiagnosis(e);
        if (d) onDiagnosis(d);
        else term.write(`\r\n\x1b[31m${errorMessage(e)}\x1b[0m\r\n`);
      }
    })();

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (sessionId !== null) {
        ipc.attachResize(sessionId, term.cols, term.rows).catch(() => {});
      }
    });
    observer.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      if (sessionId !== null) {
        ipc.attachClose(sessionId).catch(() => {});
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, specKey]);

  return <div ref={container} className="h-full w-full px-2 py-1.5" />;
}

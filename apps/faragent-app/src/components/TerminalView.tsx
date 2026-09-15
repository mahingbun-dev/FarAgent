/**
 * The terminal: one xterm.js instance per open tab, rendered from the bytes of
 * a PTY session in the Rust core over a Tauri channel. Every byte that reaches
 * the remote agent (and every byte it renders) passes through here unchanged —
 * same passthrough contract as the TUI.
 *
 * This component is now only the *rendering* half. The attach itself — the
 * lease, the channel, the pending-write queue, resize — lives in `useAttach`,
 * so the same connection can back a chat view that renders no xterm (Phase 3).
 * What is left here is the xterm instance, its fit, and the two callbacks that
 * turn an attach event into terminal output.
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { AttachSpec, Diagnosis } from "@/lib/ipc";
import { b64ToBytes } from "@/lib/bytes";
import { useAttach } from "@/lib/use-attach";

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
  const term = useRef<Terminal | null>(null);

  // Input, output and size all flow through the terminal's ref, so the attach
  // never holds a stale terminal across a remount.
  const attach = useAttach({
    host,
    spec,
    // `0×0` while the xterm below does not exist yet (this runs before the
    // effect that creates it); the hook floors that to its 80×24 default, which
    // is also what an un-fitted xterm reports. The ResizeObserver re-sizes to
    // the real fit the moment the terminal is on screen.
    size: () =>
      term.current
        ? { cols: term.current.cols, rows: term.current.rows }
        : { cols: 0, rows: 0 },
    onEvent: (event) => {
      const t = term.current;
      if (!t) return;
      if (event.kind === "data") {
        t.write(b64ToBytes(event.b64));
      } else if (event.kind === "exit") {
        t.write(`\r\n\x1b[2m── faragent: exit ${event.code} ──\x1b[0m\r\n`);
        onExit(event.code);
      } else {
        t.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
      }
    },
    onDiagnosis,
    onError: (message) => {
      term.current?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    },
    onOpen: () => term.current?.focus(),
  });

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const background = cssVar("--background", "#faf9f5");
    const foreground = cssVar("--foreground", "#2d2a26");
    const accent = cssVar("--primary", "#c96442");
    const t = new Terminal({
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
    t.loadAddon(fit);
    t.loadAddon(new WebLinksAddon());
    t.open(el);
    term.current = t;
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* layout not ready; the observer will catch up */
      }
    });

    // Every keystroke is input to the remote PTY, queued by the hook until the
    // attach has a session id.
    t.onData((data) => attach.write(data));

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      attach.resize(t.cols, t.rows);
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      t.dispose();
      term.current = null;
    };
    // The terminal is a pure function of its element; it does not depend on the
    // attach, whose closed-over `write`/`resize` are stable callbacks. The
    // attach's own effect (in `useAttach`) is keyed on host and spec.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={container} className="h-full w-full px-2 py-1.5" />;
}

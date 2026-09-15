/**
 * The terminal: one xterm.js instance per open tab, rendered from the bytes of
 * a PTY session in the Rust core over a Tauri channel. Every byte that reaches
 * the remote agent (and every byte it renders) passes through here unchanged —
 * same passthrough contract as the TUI.
 *
 * This component does not own the attach any more. The attach — the lease, the
 * channel, the pending-write queue, resize — lives in `useAttach`, and since
 * Phase 3 it is leased **once for the tab** (`lib/tab-attach.ts`) because the
 * tab's conversation view is mounted at the same time and shares it: two
 * `useAttach` calls for one tab would each re-bind the same channel's
 * `onmessage`, and the terminal would go quietly deaf. What is left here is the
 * xterm instance, its fit, and the sink it registers so the shared attach can
 * read its size and draw its bytes.
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { b64ToBytes } from "@/lib/bytes";
import type { TabAttach } from "@/lib/tab-attach";

/** Read a CSS custom property so the terminal shares the app's palette. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

export function TerminalView({ attach }: { attach: TabAttach }) {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const { bind } = attach;

  // Where the shared attach's size and events land. Registered before the xterm
  // exists, and deliberately: the closures read `term.current` when they are
  // called, so the ordering of this effect and the one below does not matter —
  // and an event that arrives while there is no terminal yet is dropped by the
  // `if (!t) return` rather than drawn into a disposed one.
  useEffect(() => {
    bind({
      size: () =>
        term.current
          ? { cols: term.current.cols, rows: term.current.rows }
          : { cols: 0, rows: 0 },
      event: (event) => {
        const t = term.current;
        if (!t) return;
        if (event.kind === "data") {
          t.write(b64ToBytes(event.b64));
        } else if (event.kind === "exit") {
          t.write(`\r\n\x1b[2m── faragent: exit ${event.code} ──\x1b[0m\r\n`);
        } else {
          t.write(`\r\n\x1b[31m${event.message}\x1b[0m\r\n`);
        }
      },
      focus: () => term.current?.focus(),
      error: (message) => {
        term.current?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
      },
    });
    return () => bind(null);
  }, [bind]);

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

    // Every keystroke is input to the remote PTY, queued by the attach until it
    // has a session id — the same door the composer writes through.
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
    // attach, whose `write`/`resize` are stable callbacks. The attach's own
    // effect lives in `useTabAttach`, keyed on host and spec.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={container} className="h-full w-full px-2 py-1.5" />;
}

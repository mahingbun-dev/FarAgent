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
import { createAttachLease } from "@/lib/attach-lease";

/** Survive React StrictMode's immediate unmount/remount without SIGHUP-ing ssh. */
const attachLease = createAttachLease();

/**
 * The event channel of every live attach, keyed exactly like the lease.
 *
 * This has to be one channel **per key**, for the same reason the lease has to
 * be one slot per key. A `Channel` is bound to a callback id at construction
 * and the backend sends to *that* id, so a remount must re-bind `onmessage` on
 * the channel the attach was opened with — a fresh one is a channel nothing
 * will ever be delivered to. As a single module-level slot this was overwritten
 * by the second tab that mounted, and the first tab's next re-run then went
 * deaf; as a map, a remount finds its own entry however many tabs are open.
 *
 * The entry's lifetime is the lease's: created by the mount that opens the
 * attach, dropped in the same close callback that closes it.
 */
const channels = new Map<string, Channel<AttachEvent>>();

function channelFor(key: string): Channel<AttachEvent> {
  const live = channels.get(key);
  if (live) return live;
  const channel = new Channel<AttachEvent>();
  channels.set(key, channel);
  return channel;
}

/** Read a CSS custom property so the terminal shares the app's palette. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function writePty(id: number, data: string) {
  ipc.attachWrite(id, bytesToB64(new TextEncoder().encode(data))).catch(() => {});
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

    const key = `${host}\0${specKey}`;
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
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* layout not ready; the observer will catch up */
      }
    });

    let sessionId: number | null = null;
    let disposed = false;
    const pending: string[] = [];

    term.onData((data) => {
      if (sessionId === null) {
        pending.push(data);
        return;
      }
      writePty(sessionId, data);
    });

    const channel = channelFor(key);
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

    void attachLease
      .acquire(key, () =>
        ipc.attachOpen({
          host,
          spec: JSON.parse(specKey) as AttachSpec,
          cols: Math.max(term.cols, 80),
          rows: Math.max(term.rows, 24),
          onEvent: channel,
        }),
      )
      .then((id) => {
        if (disposed) return;
        sessionId = id;
        for (const data of pending) writePty(id, data);
        pending.length = 0;
        if (term.cols >= 2 && term.rows >= 2) {
          ipc.attachResize(id, term.cols, term.rows).catch(() => {});
        }
        term.focus();
      })
      .catch((e) => {
        if (disposed) return;
        const d = asDiagnosis(e);
        if (d) onDiagnosis(d);
        else term.write(`\r\n\x1b[31m${errorMessage(e)}\x1b[0m\r\n`);
      });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (sessionId === null || term.cols < 2 || term.rows < 2) return;
      ipc.attachResize(sessionId, term.cols, term.rows).catch(() => {});
    });
    observer.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      term.dispose();
      attachLease.release(key, (id) => {
        channels.delete(key);
        ipc.attachClose(id).catch(() => {});
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, specKey]);

  return <div ref={container} className="h-full w-full px-2 py-1.5" />;
}

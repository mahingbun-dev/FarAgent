/**
 * `use-attach.ts` — the attach without the terminal.
 *
 * The React hook is a thin `useEffect`; the logic worth a test is `createAttach`
 * beneath it, and this file drives that directly. What is checked is the three
 * things the extraction had to get right, plus the two leak invariants it
 * inherited from `lease.ts` (a slot per key, a channel per key):
 *
 * - the pending-write queue drains on open, in order and b64-encoded;
 * - the size the attach opens with, including the no-terminal default;
 * - teardown releases the lease and the deferred close drops the channel;
 * - two keys never share a slot or a channel, closing one leaves the other;
 * - a remount on one key finds the *same* channel object and re-binds on it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAttach,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type AttachChannel,
  type Size,
} from "./use-attach.ts";
import { createAttachLease } from "./attach-lease.ts";
import type { AttachEvent } from "./ipc.ts";

/** Let every pending microtask — the async `open`, its `.then` — settle. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface WorldOptions {
  /** The caller's size getter; omitted models a caller with no terminal. */
  size?: () => Size | undefined;
}

/**
 * One shared lease, one shared channel map, and a log of every PTY call — the
 * three module-level things `use-attach.ts` holds for real, so `mount` stands
 * in for an effect run and two mounts share them the way a remount does.
 */
function world(options: WorldOptions = {}) {
  const queued: Array<() => void> = [];
  const lease = createAttachLease((fn) => queued.push(fn));
  const channels = new Map<string, AttachChannel>();
  const log = {
    opened: [] as Array<{ cols: number; rows: number; channel: AttachChannel }>,
    writes: [] as Array<{ id: number; b64: string }>,
    resizes: [] as Array<{ id: number; cols: number; rows: number }>,
    closes: [] as number[],
    events: [] as AttachEvent[],
    errors: [] as string[],
    opens: 0,
    onOpens: 0,
  };
  let nextId = 0;

  const mount = (key: string, size: (() => Size | undefined) | undefined = options.size) =>
    createAttach({
      key,
      lease,
      channels,
      makeChannel: (): AttachChannel => ({ onmessage: null }),
      open: async ({ cols, rows, channel }) => {
        log.opens += 1;
        log.opened.push({ cols, rows, channel });
        nextId += 1;
        return nextId;
      },
      writePty: (id, b64) => log.writes.push({ id, b64 }),
      resizePty: (id, cols, rows) => log.resizes.push({ id, cols, rows }),
      closePty: (id) => log.closes.push(id),
      size,
      onEvent: (e) => log.events.push(e),
      onDiagnosis: () => {},
      onError: (m) => log.errors.push(m),
      onOpen: () => {
        log.onOpens += 1;
      },
    });

  const flush = () => {
    for (const fn of queued.splice(0)) fn();
  };

  return { mount, flush, channels, log };
}

// ---------------------------------------------------------------- default size

test("a caller with no terminal opens at the 80×24 default", async () => {
  const w = world();
  w.mount("devbox\0login");
  await tick();

  assert.equal(w.log.opens, 1);
  assert.deepEqual(
    [w.log.opened[0].cols, w.log.opened[0].rows],
    [DEFAULT_COLS, DEFAULT_ROWS],
  );
  assert.deepEqual([DEFAULT_COLS, DEFAULT_ROWS], [80, 24], "the default moved");
});

test("a caller's size is floored at the default and a larger one passes through", async () => {
  const small = world({ size: () => ({ cols: 10, rows: 5 }) });
  small.mount("a");
  await tick();
  assert.deepEqual(
    [small.log.opened[0].cols, small.log.opened[0].rows],
    [DEFAULT_COLS, DEFAULT_ROWS],
    "an un-fitted terminal opened below the default",
  );

  const big = world({ size: () => ({ cols: 132, rows: 43 }) });
  big.mount("a");
  await tick();
  assert.deepEqual(
    [big.log.opened[0].cols, big.log.opened[0].rows],
    [132, 43],
    "a real terminal size was clamped",
  );
});

// ------------------------------------------------------------- pending writes

test("input typed before the attach opens is queued and drained in order", async () => {
  const w = world();
  const session = w.mount("k");

  session.write("a");
  session.write("b");
  assert.deepEqual(w.log.writes, [], "ran ahead of the session id");

  await tick();
  assert.deepEqual(w.log.writes, [
    { id: 1, b64: "YQ==" },
    { id: 1, b64: "Yg==" },
  ]);
});

test("input typed after the attach opens goes straight out", async () => {
  const w = world();
  const session = w.mount("k");
  await tick();

  session.write("c");
  assert.deepEqual(w.log.writes, [{ id: 1, b64: "Yw==" }]);
});

test("a failed open reports the error and writes nothing", async () => {
  const queued: Array<() => void> = [];
  const lease = createAttachLease((fn) => queued.push(fn));
  const channels = new Map<string, AttachChannel>();
  const errors: string[] = [];
  const writes: string[] = [];

  const session = createAttach({
    key: "k",
    lease,
    channels,
    makeChannel: (): AttachChannel => ({ onmessage: null }),
    open: () => Promise.reject(new Error("no route to host")),
    writePty: (_id, b64) => writes.push(b64),
    resizePty: () => {},
    closePty: () => {},
    onEvent: () => {},
    onDiagnosis: () => {},
    onError: (m) => errors.push(m),
  });
  session.write("a");
  await tick();

  assert.deepEqual(errors, ["no route to host"]);
  assert.deepEqual(writes, [], "a write leaked onto a session that never opened");
});

// -------------------------------------------------------------------- resize

test("a resize before the attach opens is applied once it opens", async () => {
  const w = world();
  const session = w.mount("k");

  session.resize(120, 40);
  assert.deepEqual(w.log.resizes, [], "resized a session that had no id yet");

  await tick();
  assert.deepEqual(w.log.resizes, [{ id: 1, cols: 120, rows: 40 }]);
});

test("a resize after the attach opens is sent immediately", async () => {
  const w = world();
  const session = w.mount("k");
  await tick();

  session.resize(100, 30);
  assert.deepEqual(w.log.resizes, [{ id: 1, cols: 100, rows: 30 }]);
});

test("a degenerate resize is ignored, before or after open", async () => {
  const w = world();
  const session = w.mount("k");

  session.resize(1, 1);
  session.resize(0, 24);
  await tick();
  session.resize(1, 30);
  session.resize(100, 1);

  assert.deepEqual(w.log.resizes, []);
});

// ------------------------------------------------------------------ teardown

test("dispose releases the lease; the deferred close drops the channel and hangs up", async () => {
  const w = world();
  const session = w.mount("k");
  await tick();
  assert.equal(w.channels.size, 1);

  session.dispose();
  assert.deepEqual(w.log.closes, [], "the close is deferred, not immediate");

  w.flush();
  await tick();
  assert.deepEqual(w.log.closes, [1]);
  assert.equal(w.channels.size, 0, "the channel entry outlived its attach");
});

test("write after dispose is dropped, not queued", async () => {
  const w = world();
  const session = w.mount("k");
  await tick();

  session.dispose();
  session.write("x");
  w.flush();
  await tick();

  assert.deepEqual(w.log.writes, []);
});

test("events reach onEvent while live, and stop once disposed", async () => {
  const w = world();
  const session = w.mount("k");
  await tick();
  const channel = w.channels.get("k") as AttachChannel;

  channel.onmessage?.({ kind: "data", b64: "YQ==" });
  assert.equal(w.log.events.length, 1);

  session.dispose();
  channel.onmessage?.({ kind: "exit", code: 0 });
  assert.equal(w.log.events.length, 1, "a disposed mount still received an event");
});

// ------------------------------------------------- invariant 1: a slot per key

test("two keys open two sessions and get two channels", async () => {
  const w = world();
  w.mount("host\0a");
  w.mount("host\0b");
  await tick();

  assert.equal(w.log.opens, 2);
  assert.notEqual(w.log.opened[0].channel, w.log.opened[1].channel);
  assert.equal(w.channels.size, 2);
});

test("closing one key's attach leaves the other key's slot and channel alone", async () => {
  const w = world();
  const a = w.mount("host\0a");
  const b = w.mount("host\0b");
  await tick();

  a.dispose();
  w.flush();
  await tick();

  assert.deepEqual(w.log.closes, [1], "closing a also hung up b, or nothing");
  assert.equal(w.channels.has("host\0a"), false);
  assert.equal(w.channels.has("host\0b"), true);

  b.dispose();
  w.flush();
  await tick();
  assert.deepEqual(w.log.closes, [1, 2]);
});

// -------------------------------------------- invariant 2: a channel per key

test("a remount on one key reuses the same channel — not a fresh, deaf one", async () => {
  const w = world();
  const first = w.mount("devbox\0login");
  await tick();
  const channel = w.channels.get("devbox\0login") as AttachChannel;

  // StrictMode: cleanup then effect, one tick.
  first.dispose();
  const second = w.mount("devbox\0login");
  await tick();
  w.flush();
  await tick();

  assert.equal(w.log.opens, 1, "the remount opened a second attach");
  assert.deepEqual(w.log.closes, [], "the remount's attach was closed under it");
  assert.equal(w.channels.get("devbox\0login"), channel, "the remount built a fresh channel");

  // The proof of the re-bind: an event delivered on that one channel must reach
  // the *new* mount. If `onmessage` had been left on the disposed mount's
  // closure, this would no-op and `events` would stay empty.
  channel.onmessage?.({ kind: "data", b64: "YQ==" });
  assert.equal(w.log.events.length, 1, "the remount is deaf on its own channel");

  // And the real unmount then closes the one attach, once.
  second.dispose();
  w.flush();
  await tick();
  assert.deepEqual(w.log.closes, [1]);
  assert.equal(w.channels.size, 0);
});

test("two mounts on one key in the same tick share one open", async () => {
  const w = world();
  w.mount("k");
  w.mount("k");
  await tick();

  assert.equal(w.log.opens, 1, "one key opened twice");
  assert.equal(w.log.onOpens, 2, "each holder should be told it is ready");
});

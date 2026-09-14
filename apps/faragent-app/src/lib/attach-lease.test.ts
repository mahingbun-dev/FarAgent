import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttachLease } from "./attach-lease.ts";

function flush(queued: Array<() => void>) {
  const batch = queued.splice(0);
  for (const fn of batch) fn();
}

test("StrictMode acquire-release-acquire in one turn opens once and does not close", async () => {
  const queued: Array<() => void> = [];
  const lease = createAttachLease((fn) => queued.push(fn));
  let opens = 0;
  const closes: number[] = [];
  const open = async () => {
    opens += 1;
    return 7;
  };
  const close = (id: number) => {
    closes.push(id);
  };

  const first = await lease.acquire("k", open);
  lease.release("k", close); // StrictMode cleanup
  const second = await lease.acquire("k", open); // remount
  flush(queued); // delayed close from cleanup
  await Promise.resolve();

  assert.equal(first, 7);
  assert.equal(second, 7);
  assert.equal(opens, 1);
  assert.deepEqual(closes, []);

  lease.release("k", close); // real unmount
  flush(queued);
  await Promise.resolve();
  assert.deepEqual(closes, [7]);
});

test("real unmount after a turn closes the attach once", async () => {
  const queued: Array<() => void> = [];
  const lease = createAttachLease((fn) => queued.push(fn));
  const close: number[] = [];
  await lease.acquire("sess", async () => 3);
  lease.release("sess", (id) => close.push(id));
  assert.deepEqual(close, []);
  flush(queued);
  await Promise.resolve();
  assert.deepEqual(close, [3]);
});

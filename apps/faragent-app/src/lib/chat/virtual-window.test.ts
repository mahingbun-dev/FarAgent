/**
 * The windowing maths.
 *
 * The claim this file has to make good on is the one the renderer's performance
 * rests on: **however long the conversation is, only a bounded number of rows
 * is ever rendered.** So the last test here builds a transcript-sized list,
 * scrolls it to a dozen different places — including both ends and an offset
 * past the end — and asserts the window never exceeds the viewport plus two
 * overscans, while the row it picks is always the row that is actually there.
 *
 * The rest pins the arithmetic the window is built from: the prefix sum, the
 * gap that must not be counted after the last row, and the binary search at
 * exactly the boundaries (a scroll offset precisely on a row's top belongs to
 * that row, not the one before it).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { VIRTUAL_LIST } from "../../design/tokens.ts";
import { computeWindow, contentHeight, indexAt, rowTops } from "./virtual-window.ts";

test("the prefix sum starts at zero and ends one gap past the last row", () => {
  assert.deepEqual(rowTops([100, 100, 100], 96, 10), [0, 110, 220, 330]);
  assert.equal(contentHeight(rowTops([100, 100, 100], 96, 10), 10), 320);
});

test("an unmeasured row is worth the estimate", () => {
  assert.deepEqual(rowTops([null, 50, null], 20, 5), [0, 25, 80, 105]);
});

test("a zero or negative measurement falls back to the estimate", () => {
  // `offsetHeight` is 0 for a row that is mounted but not laid out yet; taking
  // it literally would collapse the list under the reader.
  assert.deepEqual(rowTops([0, 0], 40, 0), [0, 40, 80]);
  assert.deepEqual(rowTops([-3], 40, 0), [0, 40]);
});

test("no rows means no content and an empty window", () => {
  assert.deepEqual(rowTops([], 96, 12), [0]);
  assert.equal(contentHeight([0], 12), 0);
  assert.deepEqual(computeWindow(emptyWindow()), { start: 0, end: 0, top: 0, height: 0 });
});

function emptyWindow() {
  return {
    heights: [] as Array<number | null>,
    estimate: 96,
    gap: 12,
    overscan: 8,
    scrollTop: 0,
    viewportHeight: 600,
  };
}

test("indexAt finds the row an offset lands in", () => {
  const tops = [0, 110, 220, 330, 440]; // four rows of 100 with a 10 gap
  assert.equal(indexAt(tops, 0), 0);
  assert.equal(indexAt(tops, 109), 0);
  assert.equal(indexAt(tops, 110), 1, "an offset on a row's top is that row");
  assert.equal(indexAt(tops, 219), 1);
  assert.equal(indexAt(tops, 220), 2);
  assert.equal(indexAt(tops, 1e9), 3, "past the end is clamped to the last row");
  assert.equal(indexAt(tops, -5), 0, "above the top is the first row");
});

test("indexAt on an empty prefix sum is row zero, not a crash", () => {
  assert.equal(indexAt([0], 500), 0);
});

test("the window covers the viewport plus the overscan on both sides", () => {
  const heights = [100, 100, 100, 100, 100, 100, 100, 100];
  const win = computeWindow({ heights, estimate: 100, gap: 0, overscan: 1, scrollTop: 200, viewportHeight: 300 });
  // The viewport holds rows 2..5 (offsets 200..500); one row of overscan each
  // side widens it to rows 1..6.
  assert.equal(win.start, 1);
  assert.equal(win.end, 7);
  assert.equal(win.top, 100);
  assert.equal(win.height, 600, "rows 1..6 at 100px, gap 0");
});

test("the window is clamped at both ends", () => {
  const heights = [10, 10, 10];
  const top = computeWindow({ heights, estimate: 10, gap: 0, overscan: 8, scrollTop: 0, viewportHeight: 100 });
  assert.deepEqual({ start: top.start, end: top.end }, { start: 0, end: 3 });

  const bottom = computeWindow({ heights, estimate: 10, gap: 0, overscan: 8, scrollTop: 1e6, viewportHeight: 100 });
  assert.deepEqual({ start: bottom.start, end: bottom.end }, { start: 0, end: 3 });
});

test("a window's height counts the gaps between its rows and not after them", () => {
  const heights = [30, 30, 30, 30];
  const win = computeWindow({ heights, estimate: 30, gap: 10, overscan: 0, scrollTop: 0, viewportHeight: 30 });
  assert.equal(win.start, 0);
  assert.equal(win.end, 1, "one 30px row fills a 30px viewport");
  assert.equal(win.height, 30, "a single row has no trailing gap");
});

test("a zero-height viewport still renders the anchor's row and its overscan", () => {
  // The scroller is 0-high for the frame between mount and the first layout
  // pass, and a window of nothing would leave the list blank behind it.
  const heights = [40, 40, 40, 40, 40];
  const win = computeWindow({ heights, estimate: 40, gap: 0, overscan: 1, scrollTop: 80, viewportHeight: 0 });
  assert.equal(win.start, 1);
  assert.equal(win.end, 4, "row 2, its overscan either side");
});

test("a measured row shifts everything below it", () => {
  const packed = computeWindow({
    heights: [100, 100, 100],
    estimate: 100,
    gap: 0,
    overscan: 0,
    scrollTop: 0,
    viewportHeight: 250,
  });
  assert.equal(packed.end, 3);

  const tall = computeWindow({
    heights: [400, 100, 100],
    estimate: 100,
    gap: 0,
    overscan: 0,
    scrollTop: 0,
    viewportHeight: 250,
  });
  assert.equal(tall.end, 1, "the first row now fills the viewport on its own");
  assert.ok(!Object.is(packed.end, tall.end));
});

test("however long the conversation, the window stays bounded and pointed right", () => {
  const rows = 5000;
  // The shortest row, which is what decides how many the viewport can touch.
  const stride = 40 + VIRTUAL_LIST.rowGap;
  const heights = Array.from({ length: rows }, (_, i) => 40 + (i % 7) * 30);
  const overscan = VIRTUAL_LIST.overscan;
  const viewport = 800;
  /** The viewport can touch `viewport/stride + 1` rows; overscan is either side. */
  const ceiling = Math.ceil(viewport / stride) + 1 + 2 * overscan;

  const tops = rowTops(heights, VIRTUAL_LIST.rowHeightEstimate, VIRTUAL_LIST.rowGap);
  const total = contentHeight(tops, VIRTUAL_LIST.rowGap);

  for (const scrollTop of [0, 1, 400, 5000, 20_000, total / 2, total - viewport, total - 1, total, total + 5000]) {
    const win = computeWindow({
      heights,
      estimate: VIRTUAL_LIST.rowHeightEstimate,
      gap: VIRTUAL_LIST.rowGap,
      overscan,
      scrollTop,
      viewportHeight: viewport,
    });

    assert.ok(win.end > win.start, `empty window at scrollTop=${scrollTop}`);
    assert.equal(win.start, Math.max(0, indexAt(tops, Math.max(0, scrollTop)) - overscan));
    assert.ok(
      win.end - win.start <= ceiling,
      `window of ${win.end - win.start} rows at scrollTop=${scrollTop}, ceiling ${ceiling}`,
    );
    assert.ok(win.height > 0);
  }

  // The whole point, stated plainly: 5,000 rows, at most 33 rendered.
  const far = computeWindow({
    heights,
    estimate: VIRTUAL_LIST.rowHeightEstimate,
    gap: VIRTUAL_LIST.rowGap,
    overscan,
    scrollTop: total / 2,
    viewportHeight: viewport,
  });
  assert.ok(far.end - far.start <= ceiling);
  assert.ok(far.end - far.start < rows / 100);
});

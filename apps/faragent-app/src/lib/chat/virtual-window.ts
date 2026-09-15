/**
 * Which rows of a long conversation are on screen.
 *
 * The transcript is a file that measured 9.9 MB in the S0 spike, and one
 * assistant turn can carry a hundred tool calls. Mounting every row is the
 * difference between a conversation that scrolls and one that stutters, so the
 * list renders a window and this module decides where the window is.
 *
 * ## Why this is hand-rolled rather than `@tanstack/react-virtual`
 *
 * The brief allows either. This one is chosen for a reason that is about this
 * repository rather than about the library: **the arithmetic has to be
 * provable**, and the only test runner here is `node --test` on `.ts` files
 * with no DOM and no renderer (`apps/faragent-app/package.json`). A hook from a
 * virtualisation library can only be exercised by mounting it, so adopting one
 * would mean either adding a DOM test stack this project has deliberately
 * refused, or shipping the one piece of logic most likely to be subtly
 * wrong — scroll offsets, overscan, the gap between rows — with no test at all.
 * Expressed as a pure function it is thirty lines and a dozen assertions, and
 * it joins `lib/panel/highlight.ts` and `lib/panel/diff.ts`, which are pure for
 * the same reason.
 *
 * ## The model
 *
 * Rows have different heights and most of them have never been measured — the
 * ones off screen have no height yet. So each row is assigned `heights[i]` when
 * it has been seen and `estimate` when it has not, and the prefix sum of those
 * numbers plus the gaps between them is where every row starts. Measuring a row
 * shifts everything below it, which is why the prefix sum is recomputed rather
 * than patched.
 *
 * `tops` has one more entry than there are rows, and `tops[i]` is row `i`'s
 * offset from the top of the content. The extra entry is the end of the last
 * row's *gap*, so the content's own height is `tops[n] - gap` — there is no gap
 * after the last row to scroll into.
 *
 * Pure: no DOM, no React, no measuring. The caller supplies the measurements.
 */

/** What the window is computed from. */
export interface WindowInput {
  /** Measured height of row `i`, or `null` while it has not been rendered. */
  heights: ReadonlyArray<number | null>;
  /** Height to assume for a row that has not been measured. */
  estimate: number;
  /** Vertical gap between two rows. */
  gap: number;
  /** Rows kept beyond each edge of the viewport. */
  overscan: number;
  /** The scroller's `scrollTop`. */
  scrollTop: number;
  /** The scroller's `clientHeight`. */
  viewportHeight: number;
}

/** The rows to render, and where the first one goes. */
export interface Window {
  /** First row to render. */
  start: number;
  /** One past the last row to render. */
  end: number;
  /** Offset of row `start` from the top of the content. */
  top: number;
  /** Height of rows `[start, end)`, gaps between them included. */
  height: number;
}

/**
 * Every row's offset, plus the content's end.
 *
 * `tops[i]` is where row `i` starts; `tops[n]` is row `n-1`'s end plus one gap,
 * so the scrollable height is `tops[n] - gap` (see {@link contentHeight}).
 */
export function rowTops(heights: ReadonlyArray<number | null>, estimate: number, gap: number): number[] {
  const tops = new Array<number>(heights.length + 1);
  tops[0] = 0;
  for (let i = 0; i < heights.length; i++) {
    const height = heights[i];
    tops[i + 1] = tops[i] + (typeof height === "number" && height > 0 ? height : estimate) + gap;
  }
  return tops;
}

/** The height the rows occupy together, with no gap after the last one. */
export function contentHeight(tops: readonly number[], gap: number): number {
  const last = tops[tops.length - 1];
  return last === undefined ? 0 : Math.max(0, last - gap);
}

/**
 * The row an offset falls in: the last row whose top is at or above it.
 *
 * Binary search over the prefix sum, which is sorted because heights are
 * non-negative — so the cost is logarithmic in the number of rows, not linear.
 * That matters: this runs on every scroll frame, and the list it runs over is
 * the whole conversation.
 */
export function indexAt(tops: readonly number[], offset: number): number {
  const rows = tops.length - 1;
  if (rows <= 0) return 0;
  if (offset <= 0) return 0;
  if (offset >= tops[rows - 1]) return rows - 1;

  let low = 0;
  let high = rows - 1;
  while (low < high) {
    // Upper middle: the loop must not stall when `low` is one below `high`.
    const mid = (low + high + 1) >> 1;
    if (tops[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * The window of rows to render.
 *
 * The viewport is covered from its first visible row to its last, and `overscan`
 * rows are added on each side so that a fast scroll — which moves the viewport
 * further than one frame's worth of rows — lands on rows that are already
 * mounted. Both edges are clamped: there is nothing before row 0 or after the
 * last row to keep.
 *
 * An empty list answers an empty window rather than throwing, because the
 * conversation is empty until the tail's first read lands.
 */
export function computeWindow(input: WindowInput): Window {
  const { heights, estimate, gap, overscan, viewportHeight } = input;
  const scrollTop = Math.max(0, input.scrollTop);
  const viewport = Math.max(0, viewportHeight);
  const tops = rowTops(heights, estimate, gap);
  const rows = tops.length - 1;

  if (rows === 0) return { start: 0, end: 0, top: 0, height: 0 };

  const firstVisible = indexAt(tops, scrollTop);
  const lastVisible = indexAt(tops, scrollTop + viewport);

  const start = Math.max(0, firstVisible - Math.max(0, overscan));
  const end = Math.min(rows, lastVisible + 1 + Math.max(0, overscan));
  const top = tops[start];
  const height = end > start ? tops[end] - tops[start] - gap : 0;

  return { start, end, top, height };
}

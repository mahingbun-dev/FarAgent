/**
 * The conversation, virtualised.
 *
 * A transcript measured 9.9 MB in the S0 spike and one assistant turn can carry
 * a hundred tool calls, so mounting every row is not an option. This renders the
 * window `lib/chat/virtual-window.ts` computes — rows from a start index to an
 * end index, absolutely positioned at the offsets that module returns — and
 * nothing else. The arithmetic and its tests live in that file; this is the
 * DOM side of it.
 *
 * ## Measuring
 *
 * The window's maths needs each row's height, and rows here have no fixed one: a
 * paragraph is one line or twelve, a collapsed tool row is one, an opened one is
 * a screenful. So heights are measured in the browser and fed back:
 *
 * - a **`ResizeObserver`** on each mounted row, because a row's height changes
 *   without the row remounting (opening a tool row, a `Read` result arriving)
 *   and a ref callback would never hear about it;
 * - the **viewport** from a `ResizeObserver` on the scroller, which is also what
 *   makes the list survive a window resize or the right panel opening.
 *
 * Unmeasured rows fall back to `VIRTUAL_LIST.rowHeightEstimate`, which is why
 * the list is usable on the very first frame.
 *
 * ## Scroll position
 *
 * Two behaviours, and getting either wrong is the difference between a
 * conversation and a fight with a scrollbar:
 *
 * 1. **Sticking to the bottom.** New events arrive while the reader watches, and
 *    a conversation that does not follow them is a conversation you have to keep
 *    dragging. While the viewport is at (or a hair above) the bottom, every
 *    change scrolls back to the bottom. Scroll up and it lets go.
 * 2. **Holding the reader's place.** A measurement landing above the viewport,
 *    or an earlier window being prepended, changes the content height and would
 *    otherwise drag the reader somewhere else. The row at the top of the
 *    viewport and its offset are remembered, and after the height changes the
 *    scroll position is set so that same row sits at the same offset. Applying
 *    it repeatedly is idempotent — the anchor is what the *scroll* recorded, not
 *    what the correction produced — so it does not fight the user.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatRow } from "@/components/chat/chat-row";
import { VIRTUAL_LIST, CONTENT_WIDTH } from "@/design";
import type { ChatItem } from "@/lib/chat/sidechain";
import { computeWindow, contentHeight, indexAt, rowTops } from "@/lib/chat/virtual-window";

/** How close to the bottom still counts as "at the bottom", in px. */
const STICK_SLACK = 8;

/** The row list's identity and its offset from the top of the viewport. */
interface Anchor {
  id: string;
  /** `tops[index] - scrollTop`: within one row, and unchanged by a re-measure above. */
  offset: number;
}

export function MessageList({ items }: { items: readonly ChatItem[] }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** Measured height per row index; `undefined` while unmeasured. */
  const heightsRef = useRef<Array<number | null>>([]);
  /** Bumped whenever a measurement changes, to recompute the prefix sum. */
  const [measured, setMeasured] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  const stickRef = useRef(true);
  const anchorRef = useRef<Anchor | null>(null);
  const lastTotalRef = useRef(0);
  const lastHeadRef = useRef<string | null>(null);

  const estimate = VIRTUAL_LIST.rowHeightEstimate;
  const gap = VIRTUAL_LIST.rowGap;
  const overscan = VIRTUAL_LIST.overscan;

  const record = useCallback((index: number, height: number) => {
    if (height <= 0) return;
    const heights = heightsRef.current;
    if (heights[index] === height) return;
    heights[index] = height;
    setMeasured((n) => n + 1);
  }, []);

  // -------------------------------------------------------------- the window

  /**
   * Every row's offset, from the heights measured so far.
   *
   * The measurement array is padded **in place** to the row count first, and
   * that is not a detail: `computeWindow` below reads the same array, and it
   * counts rows as `tops.length - 1`. A ref left at its initial `[]` — which is
   * what happens on the first render, when no row has been observed yet — would
   * have it compute an empty window and draw nothing at all while the container
   * around it was correctly sized. The rows that have not been measured read as
   * `null`, which is what the window falls back to `estimate` for.
   */
  const tops = useMemo(() => {
    const heights = heightsRef.current;
    if (heights.length !== items.length) heights.length = items.length;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] === undefined) heights[i] = null;
    }
    return rowTops(heights, estimate, gap);
    // `measured` is the signal that a height changed; the ref is read, not
    // depended on, because mutating it does not re-render on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, measured, estimate, gap]);

  const total = contentHeight(tops, gap);
  const win = computeWindow({
    heights: heightsRef.current,
    estimate,
    gap,
    overscan,
    scrollTop,
    viewportHeight: viewport,
  });

  // ------------------------------------------------------------- measurement

  /** The viewport's own height: the other half of the window's input. */
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setViewport(scroller.clientHeight);
    const observer = new ResizeObserver(() => setViewport(scroller.clientHeight));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  /**
   * One observer for every mounted row, created once. The callback reads the
   * row's index off the element rather than closing over it, so rows entering
   * the window do not each need a new observer.
   *
   * ## The sweep, and why the ref callback cannot do this alone
   *
   * The rows mounted in this component's **first** commit are in the DOM before
   * this effect exists: React attaches refs during the mutation phase and runs
   * layout effects after it, so `observerRef.current?.observe(element)` in the
   * row ref below found a null ref and did nothing — and each row's callback is
   * memoised per index (`refsRef`), so it is never called again for that row.
   * Those rows were therefore observed by nothing at all, and the failure is
   * silent and shaped like a layout bug rather than a missing subscription:
   * opening one grows it while every row below keeps the offset it was
   * measured at, so the next row paints **over** it. For a conversation shorter
   * than one screen that is every row in the list.
   *
   * The sweep is the fix, and it has to live here rather than in the callback:
   * the callback runs before this effect and cannot observe anything it has not
   * created yet. Rows mounted *later* — the ones that scroll into the window —
   * are still the callback's job, and it does hear about those.
   */
  const observerRef = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const index = Number(element.dataset.row);
        if (Number.isInteger(index)) record(index, element.offsetHeight);
      }
    });
    observerRef.current = observer;
    const scroller = scrollerRef.current;
    if (scroller) {
      for (const element of scroller.querySelectorAll<HTMLElement>("[data-row]")) {
        observer.observe(element);
      }
    }
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [record]);

  /**
   * A stable ref callback per row index.
   *
   * Stable on purpose: an inline arrow would make React detach and re-attach the
   * observer on every render, and the list re-renders on every scroll frame. The
   * `box` is what makes the detach path (`null`, on unmount) able to un-observe
   * the element it observed, which would otherwise be leaked by the observer's
   * strong reference to it.
   */
  const refsRef = useRef(new Map<number, (element: HTMLDivElement | null) => void>());
  const rowRef = (index: number) => {
    let ref = refsRef.current.get(index);
    if (!ref) {
      const box: { element: HTMLDivElement | null } = { element: null };
      ref = (element) => {
        if (box.element) {
          observerRef.current?.unobserve(box.element);
          box.element = null;
        }
        if (!element) return;
        box.element = element;
        observerRef.current?.observe(element);
        record(index, element.offsetHeight);
      };
      refsRef.current.set(index, ref);
    }
    return ref;
  };

  // -------------------------------------------------------- scroll behaviour

  /**
   * The head moved: an earlier window was prepended, so every index now means a
   * different row and every measurement is suspect.
   */
  useLayoutEffect(() => {
    const head = items[0]?.id ?? null;
    const previous = lastHeadRef.current;
    lastHeadRef.current = head;
    if (previous === null || head === null || previous === head) return;
    heightsRef.current = new Array<number | null>(items.length).fill(null);
    setMeasured((n) => n + 1);
  }, [items]);

  /**
   * The content's height changed. Either follow the bottom or put the anchored
   * row back where it was.
   *
   * Runs in the layout phase so the correction lands in the same frame as the
   * change — a `useEffect` here would paint the jump and then fix it.
   */
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const previous = lastTotalRef.current;
    lastTotalRef.current = total;
    if (total === previous) return;

    if (stickRef.current) {
      scroller.scrollTop = total;
      setScrollTop(scroller.scrollTop);
      return;
    }

    const anchor = anchorRef.current;
    if (!anchor) return;
    const index = items.findIndex((item) => item.id === anchor.id);
    if (index < 0) return;
    const next = Math.max(0, tops[index] - anchor.offset);
    if (Math.abs(next - scroller.scrollTop) < 0.5) return;
    scroller.scrollTop = next;
    setScrollTop(scroller.scrollTop);
  }, [total, items, tops]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.scrollTop;
    setScrollTop(top);
    stickRef.current = top + scroller.clientHeight >= total - STICK_SLACK;
    const item = items[indexAt(tops, top)];
    if (item) anchorRef.current = { id: item.id, offset: tops[indexAt(tops, top)] - top };
  };

  const rows: ReactNode[] = [];
  for (let index = win.start; index < win.end; index++) {
    const item = items[index];
    if (!item) continue;
    rows.push(
      <div
        key={item.id}
        data-row={index}
        ref={rowRef(index)}
        className="absolute inset-x-0"
        style={{ top: tops[index] }}
      >
        <ChatRow item={item} />
      </div>,
    );
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="relative min-h-0 flex-1 overflow-y-auto px-gutter py-4"
    >
      <div
        className="relative mx-auto w-full"
        style={{ maxWidth: CONTENT_WIDTH.content, height: total }}
      >
        {rows}
      </div>
    </div>
  );
}

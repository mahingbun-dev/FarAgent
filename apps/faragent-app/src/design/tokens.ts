/**
 * Design scales that JavaScript has to read.
 *
 * `src/index.css` is the source of truth for the visual language — anything a
 * Tailwind class can express (`w-sidebar`, `rounded-lg`, `text-micro`, …) lives
 * there and only there. This module carries the subset that has to be a number
 * inside the app: measuring and clamping a dragged panel, sizing the virtual
 * scroll window, scaling the terminal. The values mirror the CSS tokens; when
 * one moves, move both.
 */

/**
 * The 4px spacing grid (`--spacing`), in px.
 *
 * The step names are labels for the grid, not utilities — Tailwind's numeric
 * scale is the class-side API (`p-1` = 4px, `p-4` = 16px). Entries appear here
 * only when JS actually needs the number.
 */
export const SPACING = {
  /** base unit of the grid */
  unit: 4,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  /** page padding (`--spacing-gutter`) */
  gutter: 24,
  /** the session rail (`--spacing-sidebar`) */
  sidebar: 256,
  /** the top bar above the canvas (`--spacing-titlebar`) */
  titlebar: 40,
} as const;

/** Type scale, in px, with the line heights the CSS pairs them with. */
export const FONT_SIZE = {
  micro: { size: 11, lineHeight: 16 },
  xs: { size: 12, lineHeight: 16 },
  sm: { size: 14, lineHeight: 22 },
  base: { size: 16, lineHeight: 24 },
  lg: { size: 18, lineHeight: 28 },
  xl: { size: 20, lineHeight: 28 },
  "2xl": { size: 24, lineHeight: 32 },
  "3xl": { size: 30, lineHeight: 36 },
} as const;

/** Loose prose leading used by the conversation body (`--leading-prose`). */
export const LEADING_PROSE = 1.7;

/** Corner radii, in px, derived from the single `--radius` knob (10px). */
export const RADIUS = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  "2xl": 16,
} as const;

/** Motion, in ms. Mirrors `--duration-*` / `--ease-*`. */
export const DURATION = {
  fast: 120,
  base: 180,
  slow: 260,
} as const;

export const EASING = {
  standard: [0.2, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const;

/**
 * Reading measures, in px: the centred conversation column
 * (`--container-content`) and its prose width (`--container-prose`).
 */
export const CONTENT_WIDTH = {
  content: 1088,
  prose: 704,
} as const;

/**
 * The right-hand workspace panel. Draggable, so the shell needs the bounds as
 * numbers rather than classes; `snapClose` is the width below which releasing
 * the drag collapses the panel instead of leaving a sliver.
 */
export const PANEL = {
  minWidth: 240,
  maxWidth: 720,
  defaultWidth: 360,
  snapClose: 180,
} as const;

/**
 * Virtualised message list. Rows measure themselves; these are the seed values
 * the windowing math starts from before the first measurement lands.
 */
export const VIRTUAL_LIST = {
  /** rows rendered beyond each edge of the viewport */
  overscan: 8,
  /** starting guess for a collapsed row */
  rowHeightEstimate: 96,
  /** vertical gap between rows */
  rowGap: 12,
} as const;

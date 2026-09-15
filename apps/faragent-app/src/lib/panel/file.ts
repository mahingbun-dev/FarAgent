/**
 * What the file preview will and will not render.
 *
 * Three caps, all enforced here rather than in the component, so a test can
 * pin them without a DOM:
 *
 * 1. `PREVIEW_MAX_BYTES` — a file over this is never read. The panel asks
 *    `fs.stat` first and shows a placeholder with the size; nothing is put on
 *    the wire for the body, and nothing reaches the DOM. `previewReadPath` is
 *    the guard, and it withholds the path until the stat has answered, because
 *    a read issued one render early is a read issued at any size.
 * 2. `PREVIEW_MAX_LINES` / `PREVIEW_MAX_CHARS` — a file *under* the byte cap
 *    can still be a 30k-line minified bundle. The preview renders the first N
 *    lines and says so, instead of freezing the frame.
 * 3. Binary — a NUL byte in the head is the helper's own `looks_binary`, and
 *    the panel re-checks the whole returned chunk rather than trusting the
 *    remote alone. Binary never becomes text.
 *
 * Pure: no DOM, no imports.
 */

/** 1 MiB. Over this the preview shows a placeholder and issues no `fs.read`. */
export const PREVIEW_MAX_BYTES = 1024 * 1024;

/** Most lines the preview will put in the DOM. */
export const PREVIEW_MAX_LINES = 2000;

/** Character budget for the rendered preview, minified files being the reason. */
export const PREVIEW_MAX_CHARS = 400_000;

/** Characters under which syntax highlighting is applied; above, plain text. */
export const HIGHLIGHT_MAX_CHARS = 200_000;

/** How much of a file the helper sniffs for a NUL byte. */
export const BINARY_SNIFF_BYTES = 8192;

/** True when the preview must not try to render this file's body. */
export function isPreviewTooLarge(size: number): boolean {
  return size > PREVIEW_MAX_BYTES;
}

/**
 * The path the preview may actually read, given what `fs.stat` said.
 *
 * `""` is how every panel query hook is told "not now", and it is the return
 * value here for all three of the ways a body must not be fetched: no stat
 * answer yet, not a regular file, or over `PREVIEW_MAX_BYTES`.
 *
 * The "no answer yet" case is the one that is easy to get wrong, and was:
 * issuing the read on mount and *then* discarding the chunk when the stat
 * arrives still puts a file of any size on the wire, which is the cost the cap
 * exists to avoid. So the rule lives here, as a function a test can pin, rather
 * than as a condition inlined in a component where only reading it carefully
 * catches the mistake.
 */
export function previewReadPath(
  stat: { kind: string; size: number } | undefined,
  path: string,
): string {
  if (stat === undefined) return "";
  if (stat.kind !== "file") return "";
  if (isPreviewTooLarge(stat.size)) return "";
  return path;
}

/**
 * The read window the preview asks for.
 *
 * `PREVIEW_MAX_BYTES` rather than the helper's own 256 KiB default: a file
 * between the two is under the cap, so the preview is supposed to show it, and
 * the default would hand back a fragment that looks whole. It is well under the
 * protocol's `MAX_READ_CHUNK`. A reply with `eof: false` is then a file that
 * grew past the stat between the two calls, and the preview says so rather than
 * printing a fragment.
 */
export const PREVIEW_READ_LIMIT = PREVIEW_MAX_BYTES;

/** True when any byte is NUL. */
export function containsNul(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * `faragent_helper::ops::fs::looks_binary`: a NUL in the first 8 KiB.
 *
 * The helper refuses such a read outright, so this is the panel's second
 * opinion for a reply that arrived anyway (an older remote, a chunk that
 * starts clean and turns binary later).
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = bytes.length < BINARY_SNIFF_BYTES ? bytes.length : BINARY_SNIFF_BYTES;
  return containsNul(bytes.subarray(0, end));
}

export interface PreviewSlice {
  /** The lines to render. */
  lines: string[];
  /** The file had more than this slice could hold. */
  truncated: boolean;
  /** How many lines the whole file had, as far as the slice can tell. */
  totalLines: number;
}

/**
 * Take the part of `text` the preview is allowed to render.
 *
 * `truncated` is true when anything was left behind, whether the line budget
 * or the character budget stopped it, so the placeholder's "showing the first
 * …" line is never a lie. One over-long line is still shown rather than
 * skipped: a minified bundle with a single 400k-character line should render
 * (and be capped by `truncated`), not display an empty box.
 */
export function slicePreview(
  text: string,
  maxLines: number = PREVIEW_MAX_LINES,
  maxChars: number = PREVIEW_MAX_CHARS,
): PreviewSlice {
  const all = text.split("\n");
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const line of all) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    if (lines.length > 0 && chars + line.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
    if (chars > maxChars) {
      truncated = true;
      break;
    }
  }
  if (lines.length < all.length) truncated = true;
  return { lines, truncated, totalLines: all.length };
}

/** A size a person reads: `1.5 MB`, `912 KB`, `48 B`. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

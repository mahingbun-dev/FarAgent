/**
 * `file.ts` — the preview's three caps.
 *
 * The byte cap and the binary sniff are the two rules a reviewer will look for
 * in the component; pinning them here means the component's job is only to
 * call them in the right order. `slicePreview`'s truncation flag is what the
 * placeholder claims to the user, so it has to be exact.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BINARY_SNIFF_BYTES,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_CHARS,
  PREVIEW_MAX_LINES,
  containsNul,
  formatBytes,
  isPreviewTooLarge,
  looksBinary,
  slicePreview,
} from "./file.ts";

function bytes(values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

test("the byte cap is 1 MiB and is exclusive at the boundary", () => {
  assert.equal(PREVIEW_MAX_BYTES, 1024 * 1024);
  assert.equal(isPreviewTooLarge(PREVIEW_MAX_BYTES), false, "exactly 1 MiB renders");
  assert.equal(isPreviewTooLarge(PREVIEW_MAX_BYTES + 1), true);
  // The fixture's oversized file, which the panel must never read.
  assert.equal(isPreviewTooLarge(1536 * 1024), true);
  assert.equal(isPreviewTooLarge(0), false);
});

test("containsNul finds a NUL anywhere, not only in the head", () => {
  assert.equal(containsNul(bytes([1, 2, 3])), false);
  assert.equal(containsNul(bytes([1, 0, 3])), true);
  assert.equal(containsNul(bytes([1, 2, 3, 0])), true);
  assert.equal(containsNul(new Uint8Array(0)), false);
});

test("looksBinary only sniffs the head, the way the helper does", () => {
  const clean = new Uint8Array(BINARY_SNIFF_BYTES);
  clean.fill(65);
  assert.equal(looksBinary(clean), false);

  const headNul = Uint8Array.from(clean);
  headNul[10] = 0;
  assert.equal(looksBinary(headNul), true);

  // A NUL past the sniff window is not what the remote would refuse on —
  // `containsNul` is the panel's belt for that case, and it still sees it.
  const late = new Uint8Array(BINARY_SNIFF_BYTES * 2);
  late.fill(65);
  late[BINARY_SNIFF_BYTES + 5] = 0;
  assert.equal(looksBinary(late), false);
  assert.equal(containsNul(late), true);

  // A real PNG's signature has no NUL; the fixture's noise does, at i = 256.
  const png = new Uint8Array(1536);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < png.length; i++) png[i] = (i * 31) & 0xff;
  assert.equal(looksBinary(png), true);
});

test("slicePreview renders everything when the file fits", () => {
  const slice = slicePreview("a\nb\nc");
  assert.deepEqual(slice.lines, ["a", "b", "c"]);
  assert.equal(slice.truncated, false);
  assert.equal(slice.totalLines, 3);
});

test("slicePreview stops at the line budget and says so", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const slice = slicePreview(text, 4);
  assert.deepEqual(slice.lines, ["line 0", "line 1", "line 2", "line 3"]);
  assert.equal(slice.truncated, true);
  assert.equal(slice.totalLines, 10);
});

test("slicePreview stops at the character budget and says so", () => {
  const slice = slicePreview("aaaaaaaa\nbbbbbbbb\ncccccccc", 100, 20);
  assert.equal(slice.truncated, true);
  assert.ok(slice.lines.length < 3, "the third line must not have been rendered");
  assert.ok(slice.lines.join("\n").length <= 20);
});

test("an over-long single line is shown rather than skipped", () => {
  // A minified bundle: one 300k-character line and nothing else. Rendering an
  // empty box for it would be worse than rendering a truncated line.
  const slice = slicePreview("x".repeat(PREVIEW_MAX_CHARS + 100), 10, PREVIEW_MAX_CHARS);
  assert.equal(slice.lines.length, 1);
  assert.equal(slice.truncated, true);
  assert.equal(slice.totalLines, 1);
});

test("the shipped budgets are the ones the component uses", () => {
  const long = Array.from({ length: PREVIEW_MAX_LINES + 50 }, (_, i) => `${i}`).join("\n");
  assert.equal(slicePreview(long).truncated, true);
  const short = Array.from({ length: PREVIEW_MAX_LINES - 1 }, (_, i) => `${i}`).join("\n");
  assert.equal(slicePreview(short).truncated, false);
});

test("formatBytes is readable at every step", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(1536 * 1024), "1.5 MB");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.0 GB");
});

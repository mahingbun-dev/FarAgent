/**
 * Tailing a session's transcript over the helper channel.
 *
 * A session's conversation lives in a `.jsonl` file on the remote (the S0 spike
 * measured one Claude session at 9.9 MB and one Codex session at 17.5 MB). The
 * app renders that file, but it must never become a download: opening a session
 * reads a bounded **tail window** and grows from there, and a reader who scrolls
 * up asks for the window before what it holds.
 *
 * This module is only about **moving and framing bytes**. It knows the file is
 * line-delimited JSON and nothing else — not what a record means, not which
 * agent wrote it. Turning a record into an event is the per-agent adapter's job
 * (the next task), and it belongs on top of this, not inside it.
 *
 * ## The helper calls it uses
 *
 * No new protocol. The tail rides three ops `lib/helper.ts` already wraps:
 *
 * - `fs.stat` for the file's size, so the tail window can start near the end;
 * - `fs.read` for a byte range (`offset`, `limit`), which is what makes a tail
 *   possible at all — reading from an offset rather than from the start;
 * - `watch.subscribe` / `watch.unsubscribe` for the follow. The subscription is
 *   taken on the transcript's **directory** (`recursive: false`) and each
 *   `fs.changed` is matched against the transcript's own path, because a watch
 *   is taken on a directory the filesystem reports appends through.
 *
 * ## Invariants
 *
 * 1. **A partial final line is held, never parsed.** jsonl is written a line at
 *    a time and the tail will read the file mid-write; the trailing bytes with
 *    no newline yet are carried in `partial` and joined to the next read. A
 *    truncated record is never handed to `JSON.parse` and never reaches
 *    `records`.
 * 2. **`offset` only moves forward with bytes actually read.** It is the byte
 *    position of the next `fs.read`, advanced by the length of each chunk — not
 *    assumed from the file size, which can move under us.
 * 3. **`start` is a line boundary.** It is the byte offset of `records[0]`, so
 *    `loadEarlier` can ask for exactly the bytes before it.
 * 4. **`complete` means byte 0 is held.** Only then is there nothing earlier to
 *    load.
 * 5. **Reads are serialized behind one drain.** Pushes arrive per record — a
 *    tool call and its result are two — so two refreshes can be asked for
 *    inside one round trip; the second marks the drain dirty rather than
 *    racing it, and no byte is ever appended twice.
 * 6. **A file shorter than `offset` rewinds.** A truncate or a resume into a
 *    new file at the same path resets the model and re-reads the tail, rather
 *    than splicing two conversations together.
 *
 * The model is pure — a reducer over byte chunks with no network, no DOM and no
 * helper connection — so `node --test` drives it directly. {@link TranscriptTail}
 * is the thin client that feeds it from a {@link TranscriptChannel}, which a real
 * `HelperConnection` satisfies and an in-memory double can too.
 */
import type { FsRead, WatchSubscription } from "../helper.ts";
import { asFsChanged, decodeText } from "../helper.ts";

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * How much of a transcript's tail is read when a session is opened.
 *
 * 256 KiB is the helper's own default read limit (`DEFAULT_READ_LIMIT` in
 * `crates/faragent-helper/src/ops/fs.rs`) and holds a few hundred average
 * records — enough for the first screenful of a conversation — while staying
 * two orders of magnitude under the spike's 9.9 MB Claude sample. Opening a
 * session must not be a download, and this is the number that decides it.
 */
export const TAIL_WINDOW_BYTES = 256 * 1024;

/** How much is read at a time when following the file or loading earlier content. */
export const READ_CHUNK_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Framing — pure functions over byte streams
// ---------------------------------------------------------------------------

/** A run of complete lines plus whatever trailing bytes had no newline yet. */
export interface Framed {
  /** Complete lines, each without its terminator, in file order. */
  lines: Uint8Array[];
  /** The bytes after the last newline: a record still being written. */
  rest: Uint8Array;
}

/** Index of the first `\n` in `bytes`, or `-1`. */
function indexOfNewline(bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) return i;
  }
  return -1;
}

/**
 * Split `bytes` into complete newline-terminated lines plus the trailing
 * remainder.
 *
 * Splitting on the `\n` byte is safe for UTF-8: `0x0a` never appears inside a
 * multi-byte sequence, so a character split across two reads cannot be mistaken
 * for a line boundary — the partial bytes stay in `rest` until the newline
 * arrives. A `\r` immediately before the `\n` is dropped, so a CRLF writer
 * yields the same JSON as an LF one.
 */
export function frameLines(bytes: Uint8Array): Framed {
  const lines: Uint8Array[] = [];
  let from = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    let end = i;
    if (end > from && bytes[end - 1] === 0x0d) end -= 1;
    lines.push(bytes.subarray(from, end));
    from = i + 1;
  }
  return { lines, rest: bytes.subarray(from) };
}

/**
 * Parse one framed line, or `undefined` for a blank or malformed one.
 *
 * `undefined` is the miss sentinel because `JSON.parse` never returns it — a
 * line that is literally `null` is a (rare) valid record and stays one.
 */
export function parseRecord(line: Uint8Array): unknown {
  const text = decodeText(line);
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// The model — pure, and directly testable
// ---------------------------------------------------------------------------

/**
 * The records a tail has framed so far, plus where they sit in the file.
 *
 * Mutated in place by the three reads a tail performs: {@link openTail} for the
 * first window, {@link append} for bytes that arrived after it, and
 * {@link prepend} for an earlier window loaded on demand. Nothing here touches
 * the network.
 */
export class TranscriptModel {
  /** Parsed records, in file order. A record is whatever `JSON.parse` returned. */
  records: unknown[] = [];
  /** Byte offset of `records[0]`'s first byte — a line boundary. */
  start = 0;
  /** Byte offset of the next byte to read. Advances only with bytes read. */
  offset = 0;
  /** The file size as last reported by the remote. */
  size = 0;
  /** Bytes read past the last newline: a record the writer has not finished. */
  partial: Uint8Array = new Uint8Array(0);

  /** True when the whole file, from byte 0, is held. */
  get complete(): boolean {
    return this.start === 0;
  }

  /** How many bytes precede `records[0]` — what `loadEarlier` can still fetch. */
  get unloadedBefore(): number {
    return this.start;
  }

  /**
   * Take the first window: the last `bytes.length` bytes of a `size`-byte file.
   *
   * The window's **first** line is discarded whenever it does not start at byte
   * 0 — the tail cannot see the byte before the window, so a record straddling
   * the boundary is indistinguishable from one that begins exactly there, and a
   * half-record must never be parsed. The cost when the boundary happens to be
   * aligned is one old record, which `loadEarlier` recovers the moment the
   * reader scrolls up. When the window already covers the whole file
   * (`size <= bytes.length`) nothing is discarded and `start` is 0.
   */
  openTail(bytes: Uint8Array, size: number): void {
    let windowStart = size - bytes.length;
    if (windowStart < 0) windowStart = 0;
    let buf = bytes;
    let start = windowStart;

    if (windowStart > 0) {
      const cut = indexOfNewline(buf);
      if (cut < 0) {
        // The whole window sits inside one record whose head is before the
        // window. Hold the bytes so a later append can finish the line; if it
        // never parses it is dropped, which beats inventing a record.
        this.records = [];
        this.partial = buf;
        this.start = size;
        this.offset = size;
        this.size = size;
        return;
      }
      start = windowStart + cut + 1;
      buf = buf.subarray(cut + 1);
    }

    const { lines, rest } = frameLines(buf);
    const records: unknown[] = [];
    for (const line of lines) {
      const record = parseRecord(line);
      if (record !== undefined) records.push(record);
    }
    this.records = records;
    this.partial = rest;
    this.start = start;
    // Past the bytes actually read, not past the requested window: a shrunken
    // file leaves `offset` short of `size`, and the next read catches up.
    this.offset = windowStart + bytes.length;
    this.size = size;
  }

  /**
   * Append bytes read from {@link offset} onward, completing the held partial
   * line first. `size` is the file's size as the read reported it.
   */
  append(bytes: Uint8Array, size: number): void {
    const { lines, rest } = frameLines(concat(this.partial, bytes));
    for (const line of lines) {
      const record = parseRecord(line);
      if (record !== undefined) this.records.push(record);
    }
    this.partial = rest;
    this.offset += bytes.length;
    this.size = size;
  }

  /**
   * Prepend a window of bytes that ends exactly at {@link start}.
   *
   * The window's last line is therefore complete (it ends on the boundary this
   * model already held), and only its leading fragment — if it began
   * mid-record — is discarded. A window with no newline at all says nothing
   * usable and is dropped rather than half-parsed.
   */
  prepend(bytes: Uint8Array): void {
    let windowStart = this.start - bytes.length;
    if (windowStart < 0) windowStart = 0;
    let buf = bytes;
    let start = windowStart;

    if (windowStart > 0) {
      const cut = indexOfNewline(buf);
      if (cut < 0) return;
      start = windowStart + cut + 1;
      buf = buf.subarray(cut + 1);
    }

    const { lines } = frameLines(buf);
    const records: unknown[] = [];
    for (const line of lines) {
      const record = parseRecord(line);
      if (record !== undefined) records.push(record);
    }
    if (records.length > 0) this.records = records.concat(this.records);
    this.start = start;
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * The slice of a helper connection the tail needs.
 *
 * `HelperConnection` satisfies it structurally; a test provides an in-memory
 * double. Keeping it this narrow is what lets the follow/advance/scroll-up
 * behaviour be tested without a remote.
 */
export interface TranscriptChannel {
  stat(path: string): Promise<{ size: number }>;
  readFile(
    path: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<FsRead>;
  subscribe(path: string, recursive?: boolean): Promise<WatchSubscription>;
  unsubscribe(opts: { subscription?: number; path?: string }): Promise<{ removed: number }>;
  onPush(handler: (event: { event: string; data: unknown }) => void): () => void;
}

export interface TranscriptTailOptions {
  /** Bytes of tail read on open. Defaults to {@link TAIL_WINDOW_BYTES}. */
  windowBytes?: number;
  /** Bytes per follow and scroll-up read. Defaults to {@link READ_CHUNK_BYTES}. */
  chunkBytes?: number;
  /** Called whenever `records` changes: on open and after every append. */
  onChange?: (records: readonly unknown[]) => void;
  /** Called when a read or the watch fails. The tail stays usable afterwards. */
  onError?: (error: unknown) => void;
}

/**
 * The directory a path sits in, POSIX or Windows spelling.
 *
 * No normalisation beyond dropping one trailing separator: `/a/b/` → `/a/b`,
 * `/a/b/c` → `/a/b`, `/c` → `/`. A bare name with no separator is returned
 * unchanged — there is no parent to name, and the caller (a watch on a
 * transcript whose directory is always known) never passes one.
 */
export function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut > 0) return trimmed.slice(0, cut);
  if (cut === 0) return trimmed.slice(0, 1);
  return trimmed;
}

/**
 * A live view of one transcript file.
 *
 * Open it with {@link TranscriptTail.open}, read {@link records}, call
 * {@link refresh} to pull in anything the follow missed, {@link loadEarlier} to
 * fetch the window before what is held, and {@link close} to drop the
 * subscription. A push on the watched directory whose path is this file
 * triggers a `refresh` on its own.
 */
export class TranscriptTail {
  readonly path: string;
  readonly model: TranscriptModel;

  private readonly channel: TranscriptChannel;
  private readonly windowBytes: number;
  private readonly chunkBytes: number;
  private readonly onChange: ((records: readonly unknown[]) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private subscription: number | null = null;
  private offPush: () => void = () => undefined;
  private closed = false;
  /** The refresh currently reading, if any — refreshes serialize behind it. */
  private draining: Promise<void> | null = null;
  /** Set when a push arrives mid-drain; makes the drain read once more. */
  private dirty = false;

  private constructor(
    channel: TranscriptChannel,
    path: string,
    options: TranscriptTailOptions,
  ) {
    this.channel = channel;
    this.path = path;
    this.model = new TranscriptModel();
    this.windowBytes = options.windowBytes ?? TAIL_WINDOW_BYTES;
    this.chunkBytes = options.chunkBytes ?? READ_CHUNK_BYTES;
    this.onChange = options.onChange;
    this.onError = options.onError;
  }

  /**
   * Open a transcript: take the watch, then read the tail window.
   *
   * The watch is taken **before** the first read, so a change that lands during
   * the read still produces a push and the read cannot be the last word on the
   * file. A failure to watch is not fatal — the tail is still readable and
   * {@link refresh} still works — so it is reported and swallowed.
   */
  static async open(
    channel: TranscriptChannel,
    path: string,
    options: TranscriptTailOptions = {},
  ): Promise<TranscriptTail> {
    const tail = new TranscriptTail(channel, path, options);
    const onPush = (event: { event: string; data: unknown }) => {
      if (tail.closed) return;
      const changed = asFsChanged(event);
      if (!changed) return;
      // The watch is on the directory, so it also reports sibling transcripts;
      // only this file's own path advances this tail.
      if (decodeText(changed.path) !== tail.path) return;
      void tail.refresh().catch((e) => tail.reportError(e));
    };
    try {
      const sub = await channel.subscribe(parentDir(path), false);
      tail.subscription = sub.subscription;
      tail.offPush = channel.onPush(onPush);
    } catch (e) {
      options.onError?.(e);
    }
    try {
      await tail.readTail();
    } catch (e) {
      // The window read failed (a missing file, a permission refusal): there is
      // no tail to hand back, so drop the watch rather than leak it behind a
      // rejection the caller can do nothing about.
      await tail.close();
      throw e;
    }
    return tail;
  }

  /** Parsed records held so far, in file order. */
  get records(): readonly unknown[] {
    return this.model.records;
  }

  /** True when the whole file from byte 0 is held. */
  get complete(): boolean {
    return this.model.complete;
  }

  /** How many leading bytes are not yet loaded, for the scroll-up case. */
  get unloadedBefore(): number {
    return this.model.unloadedBefore;
  }

  /**
   * Pull in everything written since the last read.
   *
   * Reads from `offset` until the remote says the range reached end-of-file, so
   * a single push that added more than one chunk is fully covered.
   *
   * **Serialized.** An agent CLI appends one record per line, so a tool call and
   * its result arrive as two changes — and two `fs.changed` for this file inside
   * one ssh round trip is the normal case, not a corner. Two refreshes running
   * at once would both read `offset` before either awaited and both append the
   * same bytes, duplicating records and leaving `offset` past the real
   * end of file, after which the file silently stops updating. A refresh that
   * arrives while one is in flight therefore marks the tail dirty instead:
   * the in-flight drain reads once more on its way out, and every caller waits
   * for the whole drain, so `await refresh()` never returns with bytes pending.
   */
  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.draining !== null) {
      this.dirty = true;
      return this.draining;
    }
    const drain = (async () => {
      do {
        this.dirty = false;
        await this.readToEnd();
      } while (this.dirty && !this.closed);
    })();
    this.draining = drain;
    try {
      await drain;
    } finally {
      this.draining = null;
    }
    this.notify();
  }

  /** Read from `offset` to end-of-file, taking every chunk on the way. */
  private async readToEnd(): Promise<void> {
    let guard = 0;
    for (;;) {
      const from = this.model.offset;
      const read = await this.channel.readFile(this.path, {
        offset: from,
        limit: this.chunkBytes,
      });
      if (read.size < from) {
        // The file is shorter than where this tail is, so the bytes it was
        // following are gone: the session was truncated, or resumed into a new
        // file at the same path. Reading on would splice the new conversation
        // onto the old one and lose everything in between without a trace, so
        // start over from a tail of what is there now. (The remote answers an
        // `offset > size` read with an empty body and the true `size`, which is
        // the only signal the protocol gives — a replacement that has already
        // grown past `offset` is indistinguishable from an append.)
        await this.readTail();
        return;
      }
      if (read.data.length > 0) this.model.append(read.data, read.size);
      else this.model.size = read.size;
      if (read.eof || read.data.length === 0) break;
      if (++guard > 10_000) break;
    }
  }

  /**
   * Load the window ending at what is currently held, for a reader scrolling up.
   *
   * A no-op once the whole file is held. `bytes` defaults to the read chunk.
   */
  async loadEarlier(bytes: number = this.chunkBytes): Promise<void> {
    if (this.closed || this.model.complete) return;
    const want = Math.min(bytes, this.model.start);
    if (want <= 0) return;
    const read = await this.channel.readFile(this.path, {
      offset: this.model.start - want,
      limit: want,
    });
    if (read.data.length > 0) this.model.prepend(read.data);
    this.notify();
  }

  /** Read the tail window and replace what the model holds. */
  private async readTail(): Promise<void> {
    const { size } = await this.channel.stat(this.path);
    const window = Math.min(this.windowBytes, size);
    const read = await this.channel.readFile(this.path, {
      offset: size - window,
      limit: window,
    });
    this.model.openTail(read.data, read.size);
    this.notify();
  }

  /** Drop the subscription and the push handler. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.offPush();
    this.offPush = () => undefined;
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription === null) return;
    try {
      await this.channel.unsubscribe({ subscription });
    } catch {
      // The connection may already be gone; there is nothing left to drop.
    }
  }

  private notify(): void {
    this.onChange?.(this.model.records.slice());
  }

  private reportError(error: unknown): void {
    this.onError?.(error);
  }
}

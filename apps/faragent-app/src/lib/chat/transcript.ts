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
 * 7. **A file that is not there yet is a wait, not an error.** A new session's
 *    transcript is written when its CLI takes the first turn, so `fs.stat`
 *    answering `not_found` is the ordinary state for the first seconds of a
 *    session — see {@link TranscriptTail}.
 *
 * The model is pure — a reducer over byte chunks with no network, no DOM and no
 * helper connection — so `node --test` drives it directly. {@link TranscriptTail}
 * is the thin client that feeds it from a {@link TranscriptChannel}, which a real
 * `HelperConnection` satisfies and an in-memory double can too.
 */
import type { FsRead, WatchSubscription } from "../helper.ts";
import { HelperError, asFsChanged, decodeText } from "../helper.ts";

/** True when `error` is the helper's `not_found` — the path is not there. */
function isNotFound(error: unknown): boolean {
  return HelperError.from(error).errorCode === "not_found";
}

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

/**
 * How long a tail waits between attempts to reach a transcript that is not there
 * yet, and how many attempts it makes.
 *
 * A brand-new session's file appears when its CLI writes the first record — and
 * its `~/.claude/projects/<slug>` directory may not exist a moment before that,
 * and a watch cannot be taken on a directory that is not there. So a tail with
 * no watch has to knock. This is the knock, and it is bounded on purpose: once
 * the directory exists the watch is what covers the common case, and an
 * unbounded poll would cost a remote round trip every interval for the life of
 * the tab.
 */
export const AWAIT_RETRY_MS = 1500;
export const MAX_AWAIT_RETRIES = 20;

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
  /**
   * The index the next record appended to {@link records} will take.
   *
   * Record indices exist so that an adapter can name an event after the record
   * it came from and have that name survive the window growing — a renderer
   * keys a list on it and remembers the reader's scroll position by it. A tail
   * window is neither the whole file nor a window that begins at byte 0, so the
   * numbering is anchored at the **tail** and not at the file: opening a window
   * numbers its records from 0, {@link append} continues upward, and
   * {@link prepend} leaves the number alone — which is the whole point, since
   * prepending an earlier window must not renumber the conversation already on
   * screen.
   */
  private nextIndex = 0;

  /** True when the whole file, from byte 0, is held. */
  get complete(): boolean {
    return this.start === 0;
  }

  /** How many bytes precede `records[0]` — what `loadEarlier` can still fetch. */
  get unloadedBefore(): number {
    return this.start;
  }

  /**
   * The index of `records[0]` — how an adapter names a record that has no id of
   * its own.
   *
   * Negative once an earlier window has been loaded, which is expected rather
   * than a bug: the numbering counts records held from the tail, not records
   * from the start of the file, and the file's head is exactly what is still
   * unloaded. An adapter only needs it to be *stable*, not to be a position.
   */
  get firstIndex(): number {
    return this.nextIndex - this.records.length;
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
        this.nextIndex = 0;
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
    // A window replaces whatever was held, so the numbering starts over with it
    // rather than continuing from records this call just discarded.
    this.nextIndex = records.length;
  }

  /**
   * Append bytes read from {@link offset} onward, completing the held partial
   * line first. `size` is the file's size as the read reported it.
   */
  append(bytes: Uint8Array, size: number): void {
    const { lines, rest } = frameLines(concat(this.partial, bytes));
    for (const line of lines) {
      const record = parseRecord(line);
      if (record !== undefined) {
        this.records.push(record);
        // The tail moves forward, so every record already held keeps the index
        // it had — `firstIndex` reads this and `records.length` together.
        this.nextIndex += 1;
      }
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
    // `nextIndex` is deliberately left alone. These records sit *before* the
    // ones already held and the numbering is anchored at the tail, so what
    // happens here is that `firstIndex` drops by the count just inserted while
    // every record on screen keeps the index the renderer is already using.
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
  /**
   * Milliseconds between knocks while a transcript is not there yet. Defaults to
   * {@link AWAIT_RETRY_MS}; tests drive it down to run in real time.
   */
  awaitRetryMs?: number;
  /** How many knocks before giving up. Defaults to {@link MAX_AWAIT_RETRIES}. */
  maxAwaitRetries?: number;
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
 *
 * ## A file that is not there yet
 *
 * A session started from the app has a transcript path from the moment it is
 * launched, but the file is written only when the CLI takes its first turn — and
 * for a cwd the CLI has never run in, its `~/.claude/projects/<slug>` directory
 * does not exist until then either. Opening a path that is not there is
 * therefore the ordinary first seconds of a new session, not a failure:
 *
 * - `fs.stat` answering `not_found` (a distinct code from every real failure)
 *   opens the tail **empty and waiting** rather than rejecting, so the reader
 *   sees "no conversation yet" instead of an error the view implies is wrong.
 * - A watch taken on a directory that *does* exist is enough on its own: the
 *   file's own creation is a push, and {@link refresh} reads it.
 * - A watch that could not be taken — the directory is missing too — is retried
 *   on a bounded timer ({@link AWAIT_RETRY_MS} × {@link MAX_AWAIT_RETRIES}),
 *   because a directory that cannot be watched can never push. The retry also
 *   re-reads, so a file that lands before its directory can be watched is still
 *   found.
 *
 * {@link waiting} reports which of those states the tail is in; it is a
 * convenience for a caller that wants to say so, not a separate failure mode.
 */
export class TranscriptTail {
  readonly path: string;
  readonly model: TranscriptModel;

  private readonly channel: TranscriptChannel;
  private readonly windowBytes: number;
  private readonly chunkBytes: number;
  private readonly awaitRetryMs: number;
  private readonly maxAwaitRetries: number;
  private readonly onChange: ((records: readonly unknown[]) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private subscription: number | null = null;
  private offPush: () => void = () => undefined;
  /** The push handler as a field, so a retry can re-register the same one. */
  private pushHandler: (event: { event: string; data: unknown }) => void = () => undefined;
  private closed = false;
  /** The refresh currently reading, if any — refreshes serialize behind it. */
  private draining: Promise<void> | null = null;
  /** Set when a push arrives mid-drain; makes the drain read once more. */
  private dirty = false;
  /** True while the transcript file is not there yet. See the class doc. */
  private awaiting = false;
  /** How many knocks have been spent on a missing directory. */
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.awaitRetryMs = options.awaitRetryMs ?? AWAIT_RETRY_MS;
    this.maxAwaitRetries = options.maxAwaitRetries ?? MAX_AWAIT_RETRIES;
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
   *
   * A file that does not exist yet is not a failure either: the tail opens
   * empty and waiting (see the class doc). Only a *real* stat or read failure
   * drops the watch and rejects.
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
    tail.pushHandler = onPush;
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
      // The window read failed for a reason other than the file being absent (a
      // permission refusal, a dead channel): there is no tail to hand back, so
      // drop the watch rather than leak it behind a rejection the caller can do
      // nothing about.
      await tail.close();
      throw e;
    }
    // Waiting *and* unwatched: the directory is missing too, so nothing will ever
    // push. Knock until the directory or the file appears, or the budget runs out.
    if (tail.awaiting && tail.subscription === null) tail.scheduleAwaitRetry();
    return tail;
  }

  /** Parsed records held so far, in file order. */
  get records(): readonly unknown[] {
    return this.model.records;
  }

  /**
   * The index of {@link records}'s first record — the stable name an adapter
   * gives to a record that carries no id of its own.
   *
   * It goes **down** when {@link loadEarlier} brings an earlier window in, and
   * that is what makes it useful: the records already rendered keep the indices
   * the renderer keyed them on, instead of every one of them shifting.
   */
  get firstIndex(): number {
    return this.model.firstIndex;
  }

  /** True when the whole file from byte 0 is held. */
  get complete(): boolean {
    return this.model.complete;
  }

  /** How many leading bytes are not yet loaded, for the scroll-up case. */
  get unloadedBefore(): number {
    return this.model.unloadedBefore;
  }

  /** True while the transcript file is not there yet — a wait, not an error. */
  get waiting(): boolean {
    return this.awaiting;
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
      let read: FsRead;
      try {
        read = await this.channel.readFile(this.path, {
          offset: from,
          limit: this.chunkBytes,
        });
      } catch (e) {
        // `not_found` is a wait — but only while this tail holds nothing. A file
        // that was already read and has since gone is a real loss of the thing
        // being read, and the reader should hear about it rather than watch the
        // conversation go quiet. See the class doc.
        if (isNotFound(e) && from === 0 && this.model.records.length === 0) {
          this.holdEmpty();
          return;
        }
        throw e;
      }
      this.settled();
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
    let stat: { size: number };
    try {
      stat = await this.channel.stat(this.path);
    } catch (e) {
      // The ordinary first seconds of a new session: the path is known but the
      // CLI has not written the file yet. Hold an empty model and wait for it.
      if (isNotFound(e)) {
        this.holdEmpty();
        return;
      }
      throw e;
    }
    const window = Math.min(this.windowBytes, stat.size);
    const read = await this.channel.readFile(this.path, {
      offset: stat.size - window,
      limit: window,
    });
    this.model.openTail(read.data, read.size);
    this.settled();
    this.notify();
  }

  /**
   * Hold an empty model for a transcript that is not there yet, and say so.
   *
   * Opening the tail on no bytes with a size of 0 is exactly the model a
   * zero-byte file would give: nothing held, nothing earlier to load, nothing
   * waiting behind the window. That is what makes the reader see the view's own
   * "no conversation yet" rather than an error — the honest reading of a session
   * that has not spoken.
   */
  private holdEmpty(): void {
    this.awaiting = true;
    this.model.openTail(new Uint8Array(0), 0);
    this.notify();
  }

  /** The file was read after all: any wait is over and any knock is cancelled. */
  private settled(): void {
    this.awaiting = false;
    this.retries = 0;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Arm the next knock, or stop after {@link MAX_AWAIT_RETRIES}.
   *
   * Stopping is quiet on purpose: the reader still sees the empty conversation,
   * which is the same thing a session that never speaks shows, and a transcript
   * that has not appeared in half a minute is not something the view can act on.
   * A later manual refresh or a re-open tries again from scratch.
   */
  private scheduleAwaitRetry(): void {
    if (this.closed || !this.awaiting || this.retryTimer !== null) return;
    if (this.retries >= this.maxAwaitRetries) return;
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      void this.retryAwait();
    }, this.awaitRetryMs);
  }

  /**
   * One knock: take the watch again if there is none, then read.
   *
   * A directory that was missing may exist by now, and the watch is what turns
   * the *next* record into a push instead of another knock — so it is worth
   * retrying before the read. The read covers a file that landed in the same
   * moment the directory did.
   */
  private async retryAwait(): Promise<void> {
    this.retryTimer = null;
    if (this.closed || !this.awaiting) return;
    if (this.subscription === null) {
      let sub: WatchSubscription | null = null;
      try {
        sub = await this.channel.subscribe(parentDir(this.path), false);
      } catch (e) {
        this.reportError(e);
      }
      if (sub !== null) {
        // `watch.subscribe` is a round trip, and the tab can close while it is
        // in flight: `close()` read `this.subscription`, found it unset (it is
        // assigned only *after* the await), and returned without dropping
        // anything. The id this knock then took would stay subscribed on the
        // remote — with its push handler — for the life of the helper
        // connection. So re-check `closed` on the far side of the await and
        // drop what was just taken rather than keep it.
        if (this.closed) {
          await this.dropSubscription(sub.subscription);
          return;
        }
        this.subscription = sub.subscription;
        this.offPush = this.channel.onPush(this.pushHandler);
      }
    }
    try {
      await this.refresh();
    } catch (e) {
      this.reportError(e);
    }
    if (this.closed || !this.awaiting) return;
    this.scheduleAwaitRetry();
  }

  /**
   * Drop one remote subscription, swallowing a channel that is already gone.
   *
   * Shared by {@link close} and the close-during-knock path in
   * {@link retryAwait}: both hold an id the remote must be told about, and
   * neither should throw if the connection died first.
   */
  private async dropSubscription(subscription: number): Promise<void> {
    try {
      await this.channel.unsubscribe({ subscription });
    } catch {
      // The connection may already be gone; there is nothing left to drop.
    }
  }

  /** Drop the subscription and the push handler. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.offPush();
    this.offPush = () => undefined;
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription === null) return;
    await this.dropSubscription(subscription);
  }

  private notify(): void {
    this.onChange?.(this.model.records.slice());
  }

  private reportError(error: unknown): void {
    this.onError?.(error);
  }
}

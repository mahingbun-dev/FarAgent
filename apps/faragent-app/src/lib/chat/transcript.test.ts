/**
 * `chat/transcript.ts` — framing byte streams into records, and following a
 * file that is still being written.
 *
 * The tail is the whole point of this module, so the tests are split the same
 * way the module is:
 *
 * * the **pure** half drives {@link TranscriptModel} and the framing helpers
 *   directly, over byte arrays it builds itself — no channel, no timers. This is
 *   where "hold a partial final line", "advance the offset by bytes read" and
 *   "load the window before what is held" are pinned, because those are exactly
 *   the bugs a tail has.
 * * the **client** half drives {@link TranscriptTail} against an in-memory
 *   remote: opening reads a bounded tail window, a push on the watched directory
 *   advances the tail, a push naming a different file does not, and closing
 *   drops the subscription.
 *
 * A transcript can be 9.9–17.5 MB, which is the reason a tail exists; the
 * window test below is the one that keeps opening a session from becoming a
 * download.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FsRead, WatchSubscription } from "../helper.ts";
import { HelperError } from "../helper.ts";
import { TranscriptModel, TranscriptTail, frameLines, parentDir, parseRecord } from "./transcript.ts";
import { TAIL_WINDOW_BYTES, READ_CHUNK_BYTES } from "./transcript.ts";
import type { TranscriptChannel } from "./transcript.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// Framing — pure functions over byte streams
// ---------------------------------------------------------------------------

test("frameLines splits on newline and keeps ordered, terminator-free lines", () => {
  const { lines, rest } = frameLines(enc("a\nbb\nccc\n"));
  assert.deepEqual(lines.map(dec), ["a", "bb", "ccc"]);
  assert.equal(rest.length, 0, "a trailing newline leaves no remainder");
});

test("frameLines holds a final line with no newline yet as the remainder", () => {
  const { lines, rest } = frameLines(enc("a\nb"));
  assert.deepEqual(lines.map(dec), ["a"]);
  assert.equal(dec(rest), "b", "the unterminated tail is carried, not parsed");
});

test("frameLines treats an empty stream as no lines and no remainder", () => {
  const { lines, rest } = frameLines(new Uint8Array(0));
  assert.equal(lines.length, 0);
  assert.equal(rest.length, 0);
});

test("frameLines drops a CR before the LF, so a CRLF writer parses the same", () => {
  const { lines, rest } = frameLines(enc('{"a":1}\r\n{"b":2}\r\n'));
  assert.deepEqual(lines.map(dec), ['{"a":1}', '{"b":2}']);
  assert.equal(rest.length, 0);
});

test("a byte split across two reads is not mistaken for a line boundary", () => {
  // A multi-byte character cut mid-sequence: the lead bytes contain no 0x0a, so
  // they stay in the remainder and the next read completes them. This is why the
  // tail can split on the byte rather than decoding first.
  const full = enc('{"t":"héllo"}\n');
  const cut = full.indexOf(0xc3) + 1; // between the two bytes of `é`
  const first = frameLines(full.subarray(0, cut));
  assert.equal(first.lines.length, 0, "a fragment inside the string is not a line");
  const second = frameLines(concatBytes(first.rest, full.subarray(cut)));
  assert.deepEqual(second.lines.map(dec), ['{"t":"héllo"}']);
});

test("parseRecord returns the parsed value, and undefined for blank or broken", () => {
  assert.deepEqual(parseRecord(enc('{"a":1}')), { a: 1 });
  assert.equal(parseRecord(enc("")), undefined, "a blank line is not a record");
  assert.equal(parseRecord(enc("   ")), undefined, "whitespace is not a record");
  assert.equal(parseRecord(enc("{not json")), undefined, "a broken line is skipped, not thrown on");
  assert.equal(parseRecord(enc("null")), null, "a literal null is a valid record");
});

test("parentDir drops the last segment, on either separator", () => {
  assert.equal(parentDir("/home/me/.claude/projects/x/s.jsonl"), "/home/me/.claude/projects/x");
  assert.equal(parentDir("/a/b/c"), "/a/b");
  assert.equal(parentDir("/c"), "/", "a top-level name's parent is the root");
  assert.equal(parentDir("C:\\Users\\me\\t.jsonl"), "C:\\Users\\me");
  assert.equal(parentDir("bare.txt"), "bare.txt", "no separator, no parent to name");
});

// ---------------------------------------------------------------------------
// The model: opening a tail window
// ---------------------------------------------------------------------------

test("a window covering the whole file is complete, from byte 0", () => {
  const bytes = enc('{"a":1}\n{"b":2}\n');
  const model = new TranscriptModel();
  model.openTail(bytes, bytes.length);

  assert.deepEqual(model.records, [{ a: 1 }, { b: 2 }]);
  assert.equal(model.start, 0, "a whole-file window holds byte 0");
  assert.equal(model.complete, true);
  assert.equal(model.offset, bytes.length, "the next read is the end of the file");
  assert.equal(model.unloadedBefore, 0);
});

test("a tail window starts at a line boundary and drops the leading fragment", () => {
  // 16 bytes; a 10-byte window starts at byte 6, inside the first record. The
  // fragment `}\n` is discarded and the held records begin at the second record's
  // first byte (byte 8) — so `start` is a boundary `loadEarlier` can read up to.
  const bytes = enc('{"a":1}\n{"b":2}\n');
  const window = bytes.subarray(6);
  const model = new TranscriptModel();
  model.openTail(window, bytes.length);

  assert.deepEqual(model.records, [{ b: 2 }], "the first whole record in the window");
  assert.equal(model.start, 8, "start is the byte offset of records[0]");
  assert.equal(model.complete, false, "bytes 0..8 are not held");
  assert.equal(model.unloadedBefore, 8);
  assert.equal(model.offset, bytes.length, "offset is past the bytes read, not the fragment");
});

test("a window that sits wholly inside one record holds its bytes and nothing else", () => {
  // The file's last record has no newline yet (still being written), and the
  // window begins inside it: there is no complete line to keep, so the bytes are
  // held as the partial and `offset` is the file's end.
  const bytes = enc('{"a":1}\n{"b":2}');
  const window = bytes.subarray(8);
  const model = new TranscriptModel();
  model.openTail(window, bytes.length);

  assert.deepEqual(model.records, []);
  assert.equal(dec(model.partial), '{"b":2}', "the unterminated bytes are carried");
  assert.equal(model.start, bytes.length, "nothing held, so start is the end");
  assert.equal(model.offset, bytes.length);
  assert.equal(model.complete, false);
});

// ---------------------------------------------------------------------------
// The model: appending (following the file)
// ---------------------------------------------------------------------------

test("append advances the offset by the bytes read", () => {
  const model = new TranscriptModel();
  const head = enc('{"a":1}\n');
  model.openTail(head, head.length);
  assert.equal(model.offset, 8);

  const more = enc('{"b":2}\n');
  model.append(more, head.length + more.length);
  assert.equal(model.offset, 16, "offset moved by the appended length, not the new size");
  assert.equal(model.size, 16);
  assert.deepEqual(model.records, [{ a: 1 }, { b: 2 }]);
});

test("append completes a partial line held from an earlier read", () => {
  // A record delivered in two pieces: neither half alone is a line, and the JSON
  // is only assembled — and only then parsed — once the newline arrives.
  const model = new TranscriptModel();
  const head = enc('{"a":1}\n{"b":');
  model.openTail(head, head.length);
  assert.deepEqual(model.records, [{ a: 1 }], "the completed record parsed, the partial did not");
  assert.equal(dec(model.partial), '{"b":');

  model.append(enc("2}\n"), head.length + 4);
  assert.deepEqual(model.records, [{ a: 1 }, { b: 2 }], "the joined line parsed as one record");
  assert.equal(model.partial.length, 0, "the partial was consumed");
});

test("append holds a second partial when the read also ends mid-record", () => {
  const model = new TranscriptModel();
  model.append(enc('{"a":1}\n{"b":'), 14);
  assert.deepEqual(model.records, [{ a: 1 }]);
  assert.equal(dec(model.partial), '{"b":');
  // Nothing further arrives: the partial stays buffered, not parsed.
  model.append(new Uint8Array(0), 14);
  assert.equal(dec(model.partial), '{"b":');
  assert.deepEqual(model.records, [{ a: 1 }]);
});

test("a malformed line is skipped without losing the records around it", () => {
  const model = new TranscriptModel();
  const bytes = enc('{"a":1}\ngarbage\n{"b":2}\n');
  model.openTail(bytes, bytes.length);
  assert.deepEqual(model.records, [{ a: 1 }, { b: 2 }]);
});

// ---------------------------------------------------------------------------
// The model: prepending (loading an earlier window)
// ---------------------------------------------------------------------------

test("prepend puts an earlier window before the held records and lowers start", () => {
  const model = new TranscriptModel();
  const bytes = enc('{"a":1}\n{"b":2}\n{"c":3}\n');
  model.openTail(bytes.subarray(14), bytes.length); // start 16, records [{c:3}]
  assert.equal(model.start, 16);

  model.prepend(bytes.subarray(6, 16)); // '}\n{"b":2}\n'
  assert.deepEqual(model.records, [{ b: 2 }, { c: 3 }], "earlier records come first");
  assert.equal(model.start, 8, "start moved back to the earlier boundary");
  assert.equal(model.complete, false);
});

test("prepend reaching byte 0 makes the model complete", () => {
  const model = new TranscriptModel();
  const bytes = enc('{"a":1}\n{"b":2}\n');
  // A window starting inside the first record: start lands on byte 8, the second
  // record's first byte.
  model.openTail(bytes.subarray(6), bytes.length);
  assert.equal(model.start, 8);
  assert.deepEqual(model.records, [{ b: 2 }]);

  model.prepend(bytes.subarray(0, 8)); // the whole head, ending on the boundary
  assert.deepEqual(model.records, [{ a: 1 }, { b: 2 }]);
  assert.equal(model.start, 0);
  assert.equal(model.complete, true, "byte 0 is now held");
  assert.equal(model.unloadedBefore, 0);
});

test("prepend of a window with no newline changes nothing", () => {
  const model = new TranscriptModel();
  const bytes = enc('{"a":1}\n{"b":2}\n');
  model.openTail(bytes.subarray(6), bytes.length); // start 8, records [{b:2}]
  const before = model.start;
  model.prepend(enc("noline")); // cannot be split into a usable record
  assert.deepEqual(model.records, [{ b: 2 }]);
  assert.equal(model.start, before, "start did not move on unusable bytes");
});

// ---------------------------------------------------------------------------
// The client: an in-memory remote
// ---------------------------------------------------------------------------

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/**
 * A stand-in for a `HelperConnection`, holding the transcript in a mutable
 * byte array and recording every call, so the tail's windowing and following can
 * be asserted without a remote.
 */
function fakeRemote(initial: string) {
  let data = enc(initial);
  let nextSub = 1;
  const reads: Array<{ offset: number; limit: number }> = [];
  const subscribes: Array<{ path: string; recursive: boolean }> = [];
  const unsubscribes: number[] = [];
  const handlers = new Set<(e: { event: string; data: unknown }) => void>();

  const channel: TranscriptChannel = {
    stat: () => Promise.resolve({ size: data.length }),
    readFile: (_path, opts = {}) => {
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? data.length;
      reads.push({ offset, limit });
      const end = Math.min(offset + limit, data.length);
      const read: FsRead = {
        data: data.subarray(offset, end),
        eof: end >= data.length,
        size: data.length,
      };
      return Promise.resolve(read);
    },
    subscribe: (path, recursive = false) => {
      subscribes.push({ path, recursive });
      const sub: WatchSubscription = {
        subscription: nextSub++,
        path: enc(path),
        recursive,
        already: false,
        gitDir: null,
      };
      return Promise.resolve(sub);
    },
    unsubscribe: (opts) => {
      unsubscribes.push(opts.subscription ?? -1);
      return Promise.resolve({ removed: 1 });
    },
    onPush: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  return {
    channel,
    reads,
    subscribes,
    unsubscribes,
    handlerCount: () => handlers.size,
    append: (more: string) => {
      data = concatBytes(data, enc(more));
    },
    /** Replace the whole file, as a truncate or a resume into a new file does. */
    replace: (text: string) => {
      data = enc(text);
    },
    /** Deliver an `fs.changed` push naming `path`, as the helper would. */
    change: (path: string) => {
      for (const handler of [...handlers]) {
        handler({
          event: "fs.changed",
          data: {
            subscription: 1,
            root_b64: b64(parentDir(path)),
            path_b64: b64(path),
            kind: "modified",
          },
        });
      }
    },
  };
}

/** One macrotask, by which point a push-triggered refresh has settled. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const PATH = "/home/me/.claude/projects/x/s.jsonl";

test("opening reads a bounded tail window and watches the parent directory", async () => {
  const remote = fakeRemote('{"a":1}\n{"b":2}\n');
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 10 });

  // One read, of the window — not of the file. `size` is 16; the window is the
  // last 10 bytes, starting at 6.
  assert.deepEqual(remote.reads, [{ offset: 6, limit: 10 }]);
  assert.deepEqual(tail.records, [{ b: 2 }]);

  assert.deepEqual(remote.subscribes, [{ path: parentDir(PATH), recursive: false }]);
  assert.equal(tail.unloadedBefore, 8, "the head is not held yet");

  await tail.close();
});

test("the default tail window is the documented 256 KiB", () => {
  // The number is load-bearing: it is what stops a 9.9 MB session from becoming
  // a download. Pin it so a change is deliberate.
  assert.equal(TAIL_WINDOW_BYTES, 262_144);
  assert.equal(READ_CHUNK_BYTES, 262_144);
});

test("a push for this file advances the tail and fires onChange", async () => {
  const remote = fakeRemote('{"a":1}\n');
  const seen: number[] = [];
  const tail = await TranscriptTail.open(remote.channel, PATH, {
    windowBytes: 8,
    chunkBytes: 8,
    onChange: (records) => seen.push(records.length),
  });
  assert.deepEqual(tail.records, [{ a: 1 }], "the whole 8-byte file fits the window");
  assert.deepEqual(seen, [1], "open reported once");

  remote.append('{"b":2}\n');
  remote.change(PATH);
  await settle();

  assert.deepEqual(tail.records, [{ a: 1 }, { b: 2 }], "the appended record was read");
  assert.deepEqual(seen, [1, 2], "onChange fired for the append");

  await tail.close();
});

test("two pushes in one round trip neither duplicate a record nor wedge the file", async () => {
  // An agent CLI appends one record per line, so a tool call and its result are
  // two changes: two `fs.changed` for the same file inside one ssh round trip
  // is the normal case. Two refreshes running at once used to read the same
  // offset before either returned, append the same bytes twice, and leave the
  // offset past the real end of file — after which the file stopped updating,
  // silently and for good.
  const remote = fakeRemote('{"a":1}\n');
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 8, chunkBytes: 8 });
  assert.deepEqual(tail.records, [{ a: 1 }]);

  remote.append('{"b":2}\n');
  remote.change(PATH);
  remote.change(PATH); // the same tick, before the first read settles
  await settle();
  assert.deepEqual(tail.records, [{ a: 1 }, { b: 2 }], "the record appears exactly once");

  // And the tail is not wedged past the end: the next record still arrives.
  remote.append('{"c":3}\n');
  remote.change(PATH);
  await settle();
  assert.deepEqual(
    tail.records,
    [{ a: 1 }, { b: 2 }, { c: 3 }],
    "the file still updates after the double push",
  );

  await tail.close();
});

test("a file replaced by a shorter one rewinds instead of splicing", async () => {
  // A session resumed into a new file at the same path — the case the task
  // names — or a plain truncate leaves the tail holding an offset past the new
  // end. Reading on would splice the new conversation onto the old and lose
  // everything in between, so a file shorter than `offset` must reset the model.
  const remote = fakeRemote('{"old":1}\n{"old":2}\n{"old":3}\n');
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 64, chunkBytes: 64 });
  assert.deepEqual(tail.records, [{ old: 1 }, { old: 2 }, { old: 3 }]);

  remote.replace('{"new":1}\n{"new":2}\n'); // 20 bytes where 30 were held
  remote.change(PATH);
  await settle();
  assert.deepEqual(tail.records, [{ new: 1 }, { new: 2 }], "the old conversation is gone");

  // The rewind leaves the offset at the new end, so growth is still followed.
  remote.append('{"new":3}\n');
  remote.change(PATH);
  await settle();
  assert.deepEqual(tail.records, [{ new: 1 }, { new: 2 }, { new: 3 }], "the new file still updates");

  await tail.close();
});

test("a push naming a different file in the watched directory is ignored", async () => {
  const remote = fakeRemote('{"a":1}\n');
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 8 });
  const readsAfterOpen = remote.reads.length;

  remote.append('{"b":2}\n');
  // The watch is on the directory, so a sibling transcript's change arrives too.
  remote.change("/home/me/.claude/projects/x/other.jsonl");
  await settle();

  assert.deepEqual(tail.records, [{ a: 1 }], "the sibling's change did not touch this tail");
  assert.equal(remote.reads.length, readsAfterOpen, "no read was issued for the sibling");

  await tail.close();
});

test("refresh reads to end-of-file across several chunks, carrying partials", async () => {
  const remote = fakeRemote('{"a":1}\n');
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 8, chunkBytes: 10 });
  assert.equal(tail.complete, true, "the 8-byte file is wholly held");

  // 16 bytes arrive, read 10 at a time: the first read ends mid-record and the
  // second completes it — no line is parsed before its newline.
  remote.append('{"b":2}\n{"c":3}\n');
  await tail.refresh();

  assert.deepEqual(tail.records, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  // offsets 8 and 18: the first chunk of the new bytes, then the rest.
  assert.deepEqual(remote.reads.slice(-2), [
    { offset: 8, limit: 10 },
    { offset: 18, limit: 10 },
  ]);

  await tail.close();
});

test("loadEarlier fetches the window before what is held, down to byte 0", async () => {
  const remote = fakeRemote('{"a":1}\n{"b":2}\n{"c":3}\n');
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 10, chunkBytes: 10 });
  assert.deepEqual(tail.records, [{ c: 3 }], "only the tail record is held");
  assert.equal(tail.unloadedBefore, 16);

  await tail.loadEarlier();
  assert.deepEqual(tail.records, [{ b: 2 }, { c: 3 }]);

  await tail.loadEarlier();
  assert.deepEqual(tail.records, [{ a: 1 }, { b: 2 }, { c: 3 }], "the head was reached");
  assert.equal(tail.complete, true);
  assert.equal(tail.unloadedBefore, 0);

  // Once complete, another load is a no-op rather than a read at a negative
  // offset.
  const reads = remote.reads.length;
  await tail.loadEarlier();
  assert.equal(remote.reads.length, reads);

  await tail.close();
});

test("a failed load-earlier keeps the records already held, and rejects", async () => {
  // A failure to load *older* content must not take away the content already on
  // screen. The tail's model is untouched when the read rejects, so the
  // conversation the reader is looking at stays exactly as it was, and the
  // strip's own state — `complete` is still false, so there is still older
  // content to fetch — is unchanged too. This is the data half of "the failed
  // load stays on the strip"; the view routes the rejection to the strip rather
  // than to the whole-pane error, which is what keeps the two on screen
  // together.
  const remote = fakeRemote('{"a":1}\n{"b":2}\n{"c":3}\n');
  let fail = false;
  const channel: TranscriptChannel = {
    ...remote.channel,
    readFile: (path, opts) =>
      fail ? Promise.reject(new Error("the read failed")) : remote.channel.readFile(path, opts),
  };
  const tail = await TranscriptTail.open(channel, PATH, { windowBytes: 10, chunkBytes: 10 });
  assert.deepEqual(tail.records, [{ c: 3 }], "only the tail record is held initially");

  fail = true;
  await assert.rejects(tail.loadEarlier(), /the read failed/, "the failure is reported, not swallowed");

  assert.deepEqual(tail.records, [{ c: 3 }], "the records already on screen survived the failed load");
  assert.equal(tail.complete, false, "there is still older content, so the strip stays");
  assert.equal(tail.unloadedBefore, 16, "the byte count the strip names is unchanged");

  // The tail is still usable: the next load, with the read working again, lands.
  fail = false;
  await tail.loadEarlier();
  assert.deepEqual(tail.records, [{ b: 2 }, { c: 3 }], "a retry after the failure still loads earlier turns");

  await tail.close();
});

test("close drops the push handler and unsubscribes once", async () => {
  const remote = fakeRemote('{"a":1}\n');
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 8 });
  assert.equal(remote.handlerCount(), 1);

  await tail.close();
  assert.equal(remote.handlerCount(), 0, "the push handler was left registered");
  assert.deepEqual(remote.unsubscribes, [1]);

  // Idempotent: a second close (a second React cleanup) does nothing.
  await tail.close();
  assert.deepEqual(remote.unsubscribes, [1], "the channel was unsubscribed twice");

  // A push after close is inert.
  remote.append('{"b":2}\n');
  remote.change(PATH);
  await settle();
  assert.deepEqual(tail.records, [{ a: 1 }]);
});

test("a failed watch is reported but leaves the tail readable", async () => {
  const remote = fakeRemote('{"a":1}\n');
  const errors: unknown[] = [];
  const channel: TranscriptChannel = {
    ...remote.channel,
    subscribe: () => Promise.reject(new Error("no such directory")),
  };

  const tail = await TranscriptTail.open(channel, PATH, { windowBytes: 8, onError: (e) => errors.push(e) });
  assert.deepEqual(tail.records, [{ a: 1 }], "the tail still loaded without a watch");
  assert.equal(errors.length, 1, "the watch failure was reported");
  assert.equal(tail.complete, true);

  // `refresh` still works as a snapshot poll when the watch is gone.
  remote.append('{"b":2}\n');
  await tail.refresh();
  assert.deepEqual(tail.records, [{ a: 1 }, { b: 2 }]);

  await tail.close();
});

test("a failed first read drops the watch and rejects", async () => {
  // Opening a path that is gone must fail loudly *and* leave nothing behind: a
  // subscription the caller can never close is a leak on the remote.
  const remote = fakeRemote('{"a":1}\n');
  const channel: TranscriptChannel = {
    ...remote.channel,
    stat: () => Promise.reject(new Error("no such file")),
  };

  await assert.rejects(
    TranscriptTail.open(channel, PATH, { windowBytes: 8 }),
    /no such file/,
  );
  assert.deepEqual(remote.unsubscribes, [1], "the watch leaked behind the rejection");
  assert.equal(remote.handlerCount(), 0, "the push handler leaked behind the rejection");
});

// ---------------------------------------------------------------------------
// The client: a file that is not there yet
// ---------------------------------------------------------------------------

/**
 * The helper's `not_found`, in the shape `invoke` rejects with: a distinct code
 * on a remote failure. The tail reads the code, so the shape has to be the real
 * one — a plain `Error` would take the "real failure" path and prove nothing.
 */
function notFound(path: string): unknown {
  return { kind: "remote", code: "not_found", message: `no such file: ${path}` };
}

/** The helper code a rejection carries — `null` for anything that is not one. */
function codeOf(error: unknown): string | null {
  return HelperError.from(error).errorCode;
}

/** Long enough for a knock or two of a 1 ms retry timer to run. */
const sleep = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a transcript that is not there yet opens empty and waiting, not as an error", async () => {
  // The ordinary first seconds of a session started from the app: the path is
  // known from the launch, the CLI has not written the file. `fs.stat` says
  // `not_found` and the tail opens on nothing rather than rejecting — an empty
  // conversation is what the reader should see, not a failure they cannot act on.
  const remote = fakeRemote("");
  const channel: TranscriptChannel = {
    ...remote.channel,
    stat: () => Promise.reject(notFound(PATH)),
    readFile: () => Promise.reject(notFound(PATH)),
  };

  const tail = await TranscriptTail.open(channel, PATH, { windowBytes: 8 });
  assert.equal(tail.waiting, true, "the file is not there yet — a wait, not an error");
  assert.deepEqual(tail.records, []);
  assert.equal(tail.complete, true, "an absent file has nothing before byte 0 either");
  assert.deepEqual(
    remote.subscribes,
    [{ path: parentDir(PATH), recursive: false }],
    "the watch was taken anyway, so the file's own arrival is a push",
  );

  await tail.close();
});

test("the file appearing under a held watch turns the wait into records", async () => {
  const remote = fakeRemote("");
  let present = false;
  const channel: TranscriptChannel = {
    ...remote.channel,
    stat: () => (present ? remote.channel.stat(PATH) : Promise.reject(notFound(PATH))),
    readFile: (path, opts) =>
      present ? remote.channel.readFile(path, opts) : Promise.reject(notFound(PATH)),
  };

  const tail = await TranscriptTail.open(channel, PATH, { windowBytes: 64 });
  assert.equal(tail.waiting, true);

  // The CLI takes its first turn: the file is created in the watched directory.
  present = true;
  remote.append('{"a":1}\n');
  remote.change(PATH);
  await settle();

  assert.equal(tail.waiting, false, "the file is there, so the wait is over");
  assert.deepEqual(tail.records, [{ a: 1 }], "the push read the new file");

  await tail.close();
});

test("a directory that is missing too is knocked until the file can be watched", async () => {
  // The cwd may be one the CLI has never run in, so its
  // `~/.claude/projects/<slug>` directory is missing as well — and a watch
  // cannot be taken on a directory that is not there, so nothing will ever push.
  // The tail has to knock, and the knock is what finds the file.
  const remote = fakeRemote('{"a":1}\n');
  let ready = false;
  const subscribes: string[] = [];
  const channel: TranscriptChannel = {
    ...remote.channel,
    subscribe: (path, recursive = false) => {
      subscribes.push(path);
      if (!ready) return Promise.reject(notFound(path));
      return remote.channel.subscribe(path, recursive);
    },
    stat: () => (ready ? remote.channel.stat(PATH) : Promise.reject(notFound(PATH))),
    readFile: (path, opts) =>
      ready ? remote.channel.readFile(path, opts) : Promise.reject(notFound(PATH)),
  };

  const tail = await TranscriptTail.open(channel, PATH, {
    windowBytes: 64,
    awaitRetryMs: 1,
    maxAwaitRetries: 5,
  });
  assert.equal(tail.waiting, true, "no file and no directory: nothing can push");
  assert.equal(subscribes.length, 1, "the open's own watch attempt failed");

  ready = true; // the CLI created the directory and the file in it
  await sleep();

  assert.equal(tail.waiting, false, "a knock found the directory and the file");
  assert.deepEqual(tail.records, [{ a: 1 }], "the knock read the file the open could not");
  assert.ok(subscribes.length >= 2, "the watch was retried once the directory existed");

  await tail.close();
});

test("the knock stops once its budget is spent, quietly", async () => {
  // Bounded on purpose: a directory that never appears must not cost a remote
  // round trip every interval for the life of the tab. Giving up leaves the
  // reader on the empty conversation, which is what a session that never speaks
  // shows — not an error.
  const remote = fakeRemote("");
  let attempts = 0;
  const channel: TranscriptChannel = {
    ...remote.channel,
    subscribe: () => {
      attempts += 1;
      return Promise.reject(notFound("the directory is not there"));
    },
    stat: () => Promise.reject(notFound(PATH)),
    readFile: () => Promise.reject(notFound(PATH)),
  };

  const errors: unknown[] = [];
  const tail = await TranscriptTail.open(channel, PATH, {
    awaitRetryMs: 1,
    maxAwaitRetries: 2,
    onError: (e) => errors.push(e),
  });
  assert.equal(attempts, 1, "the open's own watch attempt");

  await sleep();
  assert.equal(attempts, 3, "two knocks, then the budget is spent");
  assert.equal(tail.waiting, true, "still waiting, and quiet about it");
  assert.equal(errors.length, 3, "the open's watch failure and each knock's were reported");

  // Nothing more: the timer is not re-armed past the budget.
  await sleep();
  assert.equal(attempts, 3, "no knock after the budget");

  await tail.close();
});

test("a close during the knock's subscribe still drops the watch it just took", async () => {
  // The knock re-takes the watch, and `watch.subscribe` is a round trip. The
  // subscription id is assigned only *after* the await, so a tab that closes
  // while that round trip is in flight used to leak: `close()` read
  // `this.subscription`, found it unset, and returned without dropping
  // anything — and the knock then registered the id it took, which stayed
  // subscribed on the remote (with its push handler) for the life of the
  // helper connection. The window is one round trip; the fix closes it.
  const remote = fakeRemote('{"a":1}\n');
  let release: (sub: WatchSubscription) => void = () => undefined;
  const inFlight = new Promise<WatchSubscription>((resolve) => {
    release = resolve;
  });
  let subscribes = 0;
  const channel: TranscriptChannel = {
    ...remote.channel,
    subscribe: () => {
      subscribes += 1;
      // The open's own attempt fails (nothing can push), so the tail knocks;
      // the knock's attempt hangs until the test releases it.
      return subscribes === 1 ? Promise.reject(notFound("no directory")) : inFlight;
    },
    stat: () => Promise.reject(notFound(PATH)),
    readFile: () => Promise.reject(notFound(PATH)),
  };

  const tail = await TranscriptTail.open(channel, PATH, {
    awaitRetryMs: 1,
    maxAwaitRetries: 5,
  });
  assert.equal(tail.waiting, true, "no file and no directory: nothing can push");

  await sleep(); // the knock has begun and is awaiting its `subscribe`
  assert.equal(subscribes, 2, "the knock reached `subscribe` and is in flight");

  const closed = tail.close(); // the tab closes mid-knock
  release({
    subscription: 7,
    path: enc(parentDir(PATH)),
    recursive: false,
    already: false,
    gitDir: null,
  });
  await closed;
  await sleep();

  assert.deepEqual(remote.unsubscribes, [7], "the watch the knock took after the close leaked");
  assert.equal(remote.handlerCount(), 0, "the push handler registered after the close leaked");
});

test("a not_found for a file this tail has read is a failure, not a wait", async () => {
  // A wait is only honest while the tail holds nothing. A file that was read and
  // has since gone is a real loss of the thing being read, and relabelling it a
  // wait would leave the reader watching a conversation that will never resume.
  const remote = fakeRemote('{"a":1}\n');
  let present = true;
  const channel: TranscriptChannel = {
    ...remote.channel,
    stat: () => (present ? remote.channel.stat(PATH) : Promise.reject(notFound(PATH))),
    readFile: (path, opts) =>
      present ? remote.channel.readFile(path, opts) : Promise.reject(notFound(PATH)),
  };

  const tail = await TranscriptTail.open(channel, PATH, { windowBytes: 8 });
  assert.deepEqual(tail.records, [{ a: 1 }]);
  assert.equal(tail.waiting, false);

  present = false;
  await assert.rejects(
    tail.refresh(),
    (e: unknown) => codeOf(e) === "not_found",
    "a vanished file the tail had read must reject",
  );
  assert.equal(tail.waiting, false, "a lost file is not relabelled a wait");

  await tail.close();
});

test("a transcript that changes mid-read is caught by the next refresh", async () => {
  // The window read and the file growing cannot be atomic; the tail's `offset`
  // is past the bytes it actually read, so the append is fetched next time.
  const remote = fakeRemote('{"a":1}\n');
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 8 });
  remote.append('{"b":2}\n');
  await tail.refresh();
  assert.deepEqual(tail.records, [{ a: 1 }, { b: 2 }]);
  await tail.close();
});

test("an empty file opens as complete with no records", async () => {
  const remote = fakeRemote("");
  const tail = await TranscriptTail.open(remote.channel, PATH, { windowBytes: 8 });
  assert.deepEqual(tail.records, []);
  assert.equal(tail.complete, true, "nothing precedes byte 0 of an empty file");
  assert.deepEqual(remote.reads, [{ offset: 0, limit: 0 }], "an empty file reads nothing");

  remote.append('{"a":1}\n');
  remote.change(PATH);
  await settle();
  assert.deepEqual(tail.records, [{ a: 1 }], "the first record arrives on the push");
  await tail.close();
});

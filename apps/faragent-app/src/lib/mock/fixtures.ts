/**
 * Fixture data for the browser IPC mock.
 *
 * A Tauri app cannot run in a plain browser: the frontend calls `invoke()` and
 * there is no backend behind it, so every region of the shell falls back to its
 * error state. These fixtures give the shell data shaped like the real
 * backend's, which is what makes the UI renderable, screenshottable and
 * regression-checkable from a browser (`pnpm dev`, :1420).
 *
 * Layering: this file is data only. `handlers.ts` maps a command name onto one
 * of these values; `index.ts` installs the interception that reaches it.
 *
 * Nothing here may reach a production build. `src/main.tsx` reaches the mock
 * layer only behind `import.meta.env.DEV`, and Task 3's acceptance greps
 * `dist/` for `MOCK_MARKER` and for the host aliases below to prove it.
 *
 * `node --test` runs these files directly and knows nothing about the `@/`
 * alias, so the mock layer uses relative `.ts` specifiers throughout.
 */
import type {
  Action,
  AgentKind,
  AttachSpec,
  AuthMode,
  DirListing,
  EnsuredSession,
  GitHubSync,
  Host,
  Lang,
  Plan,
  Probe,
  Session,
} from "../ipc.ts";
import { AGENT_TITLES, tmuxIdFromName, tmuxName } from "../agents.ts";
import { claudeTranscriptPath } from "../chat/transcript-path.ts";

/**
 * A string no production build can contain. `npm run build` is followed by a
 * grep of `dist/` for this marker (and for the host aliases below); both must
 * come back empty. Do not reuse it anywhere else.
 */
export const MOCK_MARKER = "faragent-mock-fixture-must-not-ship";

/** A fixed clock: the rail sorts by `mtime`, and fixtures must not drift. */
const NOW = Date.UTC(2026, 8, 14, 9, 0, 0); // 2026-09-14T09:00:00Z
const MIN = 60_000;

// ------------------------------------------------------------------ hosts

/** `faragent_transport::ssh::auth_tag`, verbatim — including `auto`'s empty tag. */
const AUTH_TAGS: Record<AuthMode, { zh: string; en: string }> = {
  auto: { zh: "", en: "" },
  key: { zh: "  [仅密钥]", en: "  [key only]" },
  password: { zh: "  [密码登录]", en: "  [password]" },
};

interface HostSeed {
  alias: string;
  auth: AuthMode;
}

/**
 * `list_hosts` order is the switcher's order, and the shell auto-selects the
 * first host — so the first entry here is the one the rail probes on load.
 */
const HOST_SEEDS: HostSeed[] = [
  { alias: "build-01.farm.internal", auth: "key" },
  { alias: "gpu-box", auth: "auto" },
  { alias: "win-builder", auth: "password" },
];

/**
 * Mutable on purpose: `set_host_auth` has to be observable afterwards, which is
 * what the switcher's auth-tag cycle does (mutate, then re-read `list_hosts`).
 */
const hosts: Host[] = HOST_SEEDS.map((seed) => ({
  alias: seed.alias,
  hostname: seed.alias,
  user: "deploy",
  port: 22,
  identity: "~/.ssh/id_ed25519",
  label: seed.alias,
  auth: seed.auth,
  authTag: AUTH_TAGS[seed.auth],
}));

function findHost(alias: string): Host | undefined {
  return hosts.find((h) => h.alias === alias);
}

/** A fresh array each call, so react-query sees a new reference after a mutation. */
export function listHosts(): Host[] {
  return hosts.map((h) => ({ ...h, authTag: { ...h.authTag } }));
}

export function hostAuth(alias: string): AuthMode {
  return findHost(alias)?.auth ?? "auto";
}

export function setHostAuth(alias: string, mode: string): void {
  const host = findHost(alias);
  if (!host || !(mode in AUTH_TAGS)) return;
  host.auth = mode as AuthMode;
  host.authTag = AUTH_TAGS[mode as AuthMode];
}

/** Windows hosts are the reason `host_os` exists at all. */
export function hostOs(alias: string): "posix" | "windows" {
  return alias.startsWith("win") ? "windows" : "posix";
}

// ------------------------------------------------------------------ probe

export function probe(alias: string): Probe {
  if (hostOs(alias) === "windows") {
    return {
      home: "C:\\Users\\deploy",
      os: "windows",
      shell: "powershell.exe",
      path: "C:\\Windows\\System32;C:\\Program Files\\nodejs",
      tmux: { found: false, path: null, version: null },
      agents: [
        {
          id: "claude",
          found: true,
          path: "C:\\Users\\deploy\\AppData\\Roaming\\npm\\claude.cmd",
          version: "2.0.1",
          authHint: "ok",
        },
        { id: "codex", found: false, path: null, version: null, authHint: "missing" },
        { id: "grok", found: false, path: null, version: null, authHint: "missing" },
        { id: "pi", found: false, path: null, version: null, authHint: "missing" },
      ],
    };
  }
  return {
    home: "/home/deploy",
    os: "posix",
    shell: "/bin/zsh",
    path: "/home/deploy/.local/bin:/usr/local/bin:/usr/bin:/bin",
    tmux: { found: true, path: "/usr/bin/tmux", version: "tmux 3.4" },
    agents: [
      {
        id: "claude",
        found: true,
        path: "/home/deploy/.local/bin/claude",
        version: "2.0.1",
        authHint: "ok",
      },
      {
        id: "codex",
        found: true,
        path: "/home/deploy/.local/bin/codex",
        version: "0.28.0",
        authHint: "ok",
      },
      // Two agents stay uninstalled so the install flow has a subject.
      { id: "grok", found: false, path: null, version: null, authHint: "missing" },
      { id: "pi", found: false, path: null, version: null, authHint: "missing" },
    ],
  };
}

// --------------------------------------------------------------- sessions

interface SessionSeed {
  id: string;
  title: string | null;
  cwd: string | null;
  /** Minutes before `NOW`; the rail shows newest first. */
  age: number;
  live?: boolean;
  running?: boolean;
  scheduled?: boolean;
  /**
   * The conversation file the row points at, when the list carried one. Only the
   * first Claude row sets it, so a session with no transcript (the common case:
   * a tmux- or process-only row) is also reachable in the fixture.
   */
  transcript?: string;
}

/**
 * One Claude session's transcript, in the real shape `~/.claude/projects/<slug>/
 * <session-id>.jsonl` — the slug is the cwd with every non-alphanumeric replaced
 * by `-`, the file is the session id.
 *
 * The content is the four record kinds a transcript renders — a `user` string
 * message, an `assistant` text message, an `assistant` `tool_use`, and the
 * matching `user` `tool_result` whose `tool_use_id` is the `tool_use`'s `id` —
 * plus a `system` and a `queue-operation` record, which a reader must skip. The
 * pairing key (`tool_use.id` ↔ `tool_result.tool_use_id`) is the one the S0
 * spike confirms is 1:1 and is *not* the record `uuid`.
 *
 * Built with `JSON.stringify` rather than hand-written strings so the fixture is
 * valid jsonl by construction — an escaping slip here would look like a parser
 * bug in `lib/chat/transcript.ts`.
 */
export const TRANSCRIPT_PATH =
  "/home/deploy/.claude/projects/-srv-app-faragent/01H8ZQk1live.jsonl";

/**
 * A session whose transcript file exists and is empty.
 *
 * This is the honest-state fixture: a session that has started but written no
 * records yet, which is the one case the conversation view has to answer with
 * words rather than with a pane that is merely blank. It is a *registered empty
 * file* rather than an unregistered path on purpose — an unregistered path is
 * the error state (`fs.read` rejects), which is a different thing to draw.
 */
export const EMPTY_TRANSCRIPT_PATH =
  "/home/deploy/.claude/projects/-srv-app-faragent/01H8ZQk3idle.jsonl";

export function transcriptJsonl(): string {
  const session = "01H8ZQk1live";
  const t = (n: number): string =>
    new Date(Date.UTC(2026, 8, 14, 9, 0, n)).toISOString();
  const records: unknown[] = [
    {
      type: "user",
      uuid: "u-0001",
      timestamp: t(0),
      sessionId: session,
      cwd: "/srv/app/faragent",
      gitBranch: "main",
      message: {
        role: "user",
        content: "Why does the attach lease key on the tab id and not the slot?",
      },
    },
    {
      type: "assistant",
      uuid: "u-0002",
      timestamp: t(2),
      sessionId: session,
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Let me read the lease module first." }],
      },
    },
    {
      type: "assistant",
      uuid: "u-0003",
      timestamp: t(3),
      sessionId: session,
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          {
            type: "tool_use",
            id: "call_00_Xk7Qm2",
            name: "Read",
            input: {
              file_path:
                "/srv/app/faragent/apps/faragent-app/src/lib/attach-lease.ts",
            },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "u-0004",
      timestamp: t(3),
      sessionId: session,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_00_Xk7Qm2",
            content:
              "export function attachLease(tabId: string): Lease {\n  // one attach per tab, not per slot\n  return acquire(`attach:${tabId}`);\n}\n",
          },
        ],
      },
      toolUseResult: {
        type: "text",
        file: {
          filePath:
            "/srv/app/faragent/apps/faragent-app/src/lib/attach-lease.ts",
        },
      },
      sourceToolAssistantUUID: "u-0003",
    },
    {
      type: "assistant",
      uuid: "u-0005",
      timestamp: t(5),
      sessionId: session,
      message: {
        id: "msg_02",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          {
            type: "text",
            text: "A slot can be handed to a different tab, so the slot id is not stable enough to own the lease; the tab id is.",
          },
        ],
      },
    },
    {
      type: "system",
      uuid: "u-0006",
      timestamp: t(5),
      sessionId: session,
      subtype: "stop_hook_summary",
    },
    {
      type: "queue-operation",
      uuid: "u-0007",
      timestamp: t(5),
      sessionId: session,
      operation: "dequeue",
    },
  ];
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/**
 * A second Claude session's transcript: the one the **conversation view** is
 * exercised against.
 *
 * `transcriptJsonl` above is the parser's fixture — seven records, one of each
 * kind, small enough to assert on by index. This one is the renderer's, and it
 * is built to the opposite brief: **long enough that a virtualised list is the
 * only way to draw it**, and containing every shape the conversation view has a
 * separate rendering for, so none of them has to be reached by hand-editing a
 * file on a remote machine.
 *
 * What it deliberately contains:
 *
 * - **Thousands of events.** `cycles` tool-call/result pairs plus the fixed
 *   parts, which lands about 4,400 events and 2,000 rows with the default —
 *   over eleven tail windows' worth of file. So the loaded tail is itself 184
 *   rows, and `chat.earlier` ("earlier turns are not loaded") is reachable
 *   without any setup.
 * - **The shapes at the *end*, where the tail lands.** A tail reads the last
 *   `TAIL_WINDOW_BYTES`, so a shape placed at the start of the file would be
 *   invisible on open. The showcase is therefore after the bulk:
 *   - **Markdown, in all the shapes `remark-gfm` is there for** — headings, a
 *     nested list, a table, inline code, a fenced block with a language, a link.
 *   - **Thinking**, collapsed by the view.
 *   - **A successful call**, and **an edit and a write that produce diffs** —
 *     `old_string`/`new_string`, and a bare `content`, which
 *     `lib/chat/tool-input.ts` synthesises a patch from.
 *   - **A failed call.** A `tool_result` with `is_error: true`.
 *   - **A sidechain run.** A contiguous block of `isSidechain` records — a
 *     subagent's turn — so the nesting path has a subject.
 *   - **A pending call.** The last record is a `tool_use` with no result, which
 *     is the normal live case: the agent is running the tool right now.
 * - **Lines wider than the reading width, in each of the three containers that
 *   can hold one** — a long line in the synthesised patch (the tool row), a long
 *   command in a fence inside a thinking block, and a long line in the
 *   subagent's grep output. A conversation whose longest line is 40 characters
 *   cannot tell a renderer that handles wide content apart from one that clips
 *   it, and that is how the same defect shipped twice: the corpus had no wide
 *   line to look at. Each is ~130 characters — wider than the 65ch reading cap,
 *   narrower than the content column — so it is shown whole exactly when the
 *   container around it is sized right. (The subagent's result block is the one
 *   that wraps rather than clips, so there the same width is the difference
 *   between one line and two.)
 *
 * Built with `JSON.stringify`, like the parser's fixture, so an escaping slip
 * cannot masquerade as a bug in the reader.
 */
export const LONG_TRANSCRIPT_PATH =
  "/home/deploy/.claude/projects/-srv-app-faragent/01H8ZQk2run.jsonl";

/** The workspace the long transcript's session ran in. */
const LONG_CWD = "/srv/app/faragent";

/**
 * The long transcript, as jsonl.
 *
 * `cycles` is the number of tool-call/result pairs in the bulk. The fixed parts
 * add a hundred-odd records around them, which the defaults turn into a file of
 * about **2.8 MiB and 4,400 events** — eleven times the tail window, and 184
 * rows inside it, so opening the session shows the end of a conversation and
 * offers to load the rest.
 */
export function longTranscriptJsonl(cycles = 2500): string {
  const session = "01H8ZQk2run";
  const base = Date.UTC(2026, 8, 14, 10, 0, 0);
  const records: unknown[] = [];
  let tick = 0;
  let serial = 0;

  const stamp = (): string => new Date(base + (tick += 1) * 1000).toISOString();
  const uuid = (): string => `L${String((serial += 1)).padStart(5, "0")}`;

  /** A `user` record whose content is a plain string: one turn of prose. */
  const ask = (text: string, sidechain = false): void => {
    records.push({
      type: "user",
      uuid: uuid(),
      timestamp: stamp(),
      sessionId: session,
      cwd: LONG_CWD,
      gitBranch: "main",
      ...(sidechain ? { isSidechain: true } : {}),
      message: { role: "user", content: text },
    });
  };

  /** An `assistant` record carrying content blocks, in order. */
  const say = (content: unknown[], sidechain = false): void => {
    records.push({
      type: "assistant",
      uuid: uuid(),
      timestamp: stamp(),
      sessionId: session,
      cwd: LONG_CWD,
      gitBranch: "main",
      ...(sidechain ? { isSidechain: true } : {}),
      message: {
        id: `msg_${uuid()}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content,
      },
    });
  };

  const text = (body: string) => ({ type: "text", text: body });
  const think = (body: string) => ({ type: "thinking", thinking: body, signature: "sig" });

  /**
   * A call and its result, written as the two records they really are.
   *
   * `result: null` writes the call and **no** result record, which is how a
   * pending call is spelled — the agent has not finished the tool yet.
   */
  const call = (
    id: string,
    name: string,
    input: unknown,
    result: { content: string; isError?: boolean } | null,
    sidechain = false,
  ): void => {
    say([{ type: "tool_use", id, name, input }], sidechain);
    if (result === null) return;
    records.push({
      type: "user",
      uuid: uuid(),
      timestamp: stamp(),
      sessionId: session,
      cwd: LONG_CWD,
      ...(sidechain ? { isSidechain: true } : {}),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          },
        ],
      },
      sourceToolAssistantUUID: "L00000",
    });
  };

  // --- the preamble: prose in every Markdown shape the renderer claims to
  // handle, so a missing `remark-gfm` or a broken component override shows up
  // on the first screen rather than five hundred turns in.
  ask(
    "The rail keeps dropping the lease when I switch tabs. Read the module and tell me what owns it.",
  );
  say([
    think(
      "The title says the lease is keyed by slot, but the commit that fixed this said tab. One of the two is stale, and the code is the one that runs.",
    ),
    text(
      [
        "## What owns the lease",
        "",
        "`lib/attach-lease.ts` keys the slot on **the tab id**, not the slot:",
        "",
        "```ts",
        "export function attachLease(tabId: string): Lease {",
        "  return acquire(`attach:${tabId}`);",
        "}",
        "```",
        "",
        "Three things follow from that, and only the first is obvious:",
        "",
        "1. A slot can be handed to a different tab, so a slot id is not stable.",
        "2. A remount of the *same* tab must not drop the lease.",
        "   - which is what `createLease`'s deferred close is for",
        "   - and why the key carries no attempt counter",
        "3. Two tabs on one host are two slots, and two slots are two attaches.",
        "",
        "| surface | keyed by | survives a remount |",
        "| --- | --- | --- |",
        "| attach | tab id | yes |",
        "| helper | host | yes |",
        "| transcript | host + path | yes |",
        "",
        "See [the lease module](https://example.invalid/lease.ts) for the close path.",
      ].join("\n"),
    ),
  ]);

  // --- the bulk. Alternating tools with plain-prose turns between them, so the
  // list is a realistic mix of one-line rows and paragraphs rather than a
  // column of identical rows — which is also what makes the measured-height
  // path (as opposed to the estimate) the one that gets exercised.
  //
  // It is deliberately the *middle* of the file and not its end: the tail reads
  // the last `TAIL_WINDOW_BYTES`, so whatever is at the end is what a reader
  // sees on open, and the shapes below are the ones worth landing on.
  const FILES = [
    "src/state.ts",
    "src/lib/lease.ts",
    "src/lib/attach-lease.ts",
    "src/lib/use-attach.ts",
    "src/components/TerminalView.tsx",
    "src/components/shell/workspace-tabs.tsx",
    "src/lib/chat/transcript.ts",
    "src/lib/chat/events.ts",
    "src/lib/chat/sidechain.ts",
    "src/lib/panel/diff.ts",
  ];

  for (let i = 0; i < cycles; i++) {
    if (i % 25 === 0) {
      ask(`Continue with step ${i / 25} of the plan.`);
    }
    // Prose every third cycle, so a run of tool calls is bounded at three and
    // the list has a paragraph-to-row ratio a real conversation has. Without
    // this the whole bulk would fold into a handful of enormous tool rows.
    if (i % 3 === 0) {
      say([text(`Step ${i / 3}: reading \`${FILES[i % FILES.length]}\` to see who holds the lease.`)]);
    }
    const file = `${LONG_CWD}/${FILES[i % FILES.length]}`;
    call(`call_L_r${i}`, "Read", { file_path: file }, {
      content: `// ${file}\n// line 1 of a file the agent looked at\n${"// filler\n".repeat(6)}`,
    });
    if (i % 5 === 0) {
      call(
        `call_L_g${i}`,
        "Grep",
        { pattern: "createLease", path: `${LONG_CWD}/src` },
        { content: `src/lib/lease.ts:${40 + i}:export function createLease` },
      );
    }
    if (i % 7 === 0) {
      call(
        `call_L_e${i}`,
        "Edit",
        {
          file_path: file,
          old_string: `// filler ${i}`,
          new_string: `// filler ${i} — checked`,
        },
        { content: "The file has been updated." },
      );
    }
    if (i % 40 === 0) {
      say([
        think(
          `Step ${i} looked like the previous one; the only difference is which module the lease is read from.`,
        ),
        text(
          `Read \`${FILES[i % FILES.length]}\` and found nothing new: the lease is still held by the tab.`,
        ),
      ]);
    }
  }

  // --- the showcase. Everything below is inside the tail window, so it is what
  // a reader sees when the session opens: prose in every Markdown shape the
  // renderer claims to handle, a call that succeeded, an edit and a write that
  // produce diffs, a call that failed, and a subagent's turn.
  say([
    think(
      [
        "The lease is right; the bug is that nothing told the reader which view they are in.",
        "Worth showing the shapes in one place, and reproducing it is one command:",
        "",
        "```sh",
        `pnpm --filter faragent-app exec node --test "src/lib/chat/*.test.ts" --experimental-strip-types 2>&1 | tee /tmp/faragent-tail.log`,
        "```",
      ].join("\n"),
    ),
    text(
      [
        "## Wrapping up",
        "",
        "`attachLease` keys on the tab id, and the table below is the whole reason:",
        "",
        "| surface | keyed by | survives a remount |",
        "| --- | --- | --- |",
        "| attach | tab id | yes |",
        "| helper | host | yes |",
        "| transcript | host + path | yes |",
        "",
        "1. A slot can be handed to a different tab.",
        "2. A remount of the *same* tab must not drop the lease.",
        "   - which is what `createLease`'s deferred close is for",
        "   - and why the key carries no attempt counter",
        "",
        "```ts",
        "export function attachLease(tabId: string): Lease {",
        "  return acquire(`attach:${tabId}`);",
        "}",
        "```",
        "",
        "See [the lease module](https://example.invalid/lease.ts) for the close path.",
      ].join("\n"),
    ),
  ]);

  say([text("Spot-checking the tests before I touch anything.")]);
  call(
    "call_L_bash",
    "Bash",
    { command: "pnpm --filter faragent-app test 2>&1 | tail -20", description: "run the app tests" },
    {
      content: [
        "> faragent-app@0.2.0 test",
        "> node --test \"src/**/*.test.ts\"",
        "",
        "# tests 48",
        "# pass 48",
        "# fail 0",
        "# duration_ms 812.4",
      ].join("\n"),
    },
  );

  say([text("Now the comment, which is the part that was actually wrong.")]);
  call(
    "call_L_edit",
    "Edit",
    {
      file_path: `${LONG_CWD}/src/lib/attach-lease.ts`,
      old_string: [
        "export function attachLease(tabId: string): Lease {",
        "  // one attach per tab, not per slot",
        "  return acquire(`attach:${tabId}`);",
        "}",
      ].join("\n"),
      new_string: [
        "export function attachLease(tabId: string): Lease {",
        "  // One attach per tab, so a slot handed to another tab cannot take this",
        "  // tab's ssh child with it. The key carries no attempt counter: a",
        "  // remount of the same tab must join the lease it already holds.",
        "  return acquire(`attach:${tabId}`);",
        "}",
      ].join("\n"),
    },
    { content: "The file has been updated. Here's the result of running `cat -n` on a snippet." },
  );

  call(
    "call_L_write",
    "Write",
    {
      file_path: `${LONG_CWD}/src/lib/chat/virtual-window.ts`,
      content: [
        "export function rowTops(heights: ReadonlyArray<number | null>, estimate: number, gap: number): number[] {",
        "  const tops = new Array<number>(heights.length + 1);",
        "  tops[0] = 0;",
        "  for (let i = 0; i < heights.length; i++) {",
        "    const height = heights[i];",
        "    tops[i + 1] = tops[i] + (typeof height === 'number' && height > 0 ? height : estimate) + gap; // measured, or the estimate",
        "  }",
        "  return tops;",
        "}",
      ].join("\n"),
    },
    { content: "File created successfully." },
  );

  say([text("The Rust side no longer compiles, which is the next thing to look at.")]);
  call(
    "call_L_fail",
    "Bash",
    { command: "cargo test --manifest-path crates/faragent/Cargo.toml", description: "run the rust tests" },
    {
      content: [
        "error[E0308]: mismatched types",
        "  --> crates/faragent/src/lease.rs:88:9",
        "   |",
        "88 |     Ok(lease)",
        "   |        ^^^^^ expected `Lease`, found `Option<Lease>`",
        "",
        "error: could not compile `faragent` (lib test) due to 1 previous error",
      ].join("\n"),
      isError: true,
    },
  );

  // --- a subagent's turn. Contiguous, because the fold takes a maximal run of
  // `isSidechain` records as one block, and this is what proves it nests rather
  // than splicing itself into the main thread.
  say([think("This is a subagent's reasoning and must not read as the main agent's.")], true);
  ask("Find every call site of `attachLease` and report the file and line.", true);
  call(
    "call_L_sub_grep",
    "Grep",
    { pattern: "attachLease\\(", path: `${LONG_CWD}/src`, output_mode: "content" },
    {
      content: [
        "src/components/TerminalView.tsx:94:  const lease = attachLease(tabId);",
        "src/lib/attach-lease.ts:12:export function attachLease(tabId: string): Lease {",
        "src/lib/attach-lease.test.ts:31:  const lease = attachLease('tab-1');",
        "src/components/shell/workspace-tabs.tsx:412:  const lease = attachLease(tab.id); // keyed by the tab, never the slot id, never the host",
      ].join("\n"),
    },
    true,
  );
  say(
    [
      text(
        "Two production call sites: `TerminalView` holds the lease and the module defines it. The test is the third.",
      ),
    ],
    true,
  );

  // --- the coda: a call with no result record at all. This is the state the
  // conversation is in *while the agent is working*, and it is the one a
  // renderer is most likely to draw as broken.
  say([
    text("Last check before I summarise:"),
    { type: "tool_use", id: "call_L_pending", name: "Read", input: { file_path: `${LONG_CWD}/README.md` } },
  ]);

  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/**
 * One row per rail mark — `live`, `running`, `idle` and `scheduled` — spread
 * over three workspaces plus the no-cwd bucket, so grouping, group counts,
 * collapse and all four status dots are reachable in a single screen.
 *
 * `session-list.tsx` derives the mark live > running > scheduled > idle, so the
 * combinations below are what produce each of the four dots.
 */
const SESSION_SEEDS: SessionSeed[] = [
  // /srv/app/faragent
  { id: "01H8ZQk1live", title: "fix attach lease", cwd: "/srv/app/faragent", age: 0, live: true, running: true, transcript: TRANSCRIPT_PATH },
  { id: "01H8ZQk2run", title: "rework the rail", cwd: "/srv/app/faragent", age: 2, running: true, transcript: LONG_TRANSCRIPT_PATH },
  { id: "01H8ZQk3idle", title: "update the README", cwd: "/srv/app/faragent", age: 6, transcript: EMPTY_TRANSCRIPT_PATH },
  { id: "01H8ZQk4idle", title: "bump xterm", cwd: "/srv/app/faragent", age: 11 },
  // /srv/app/docs
  { id: "01H8ZQk5docs", title: "translate the manual", cwd: "/srv/app/docs", age: 18 },
  { id: "01H8ZQk6docs", title: "screenshot the switchers", cwd: "/srv/app/docs", age: 24 },
  { id: "01H8ZQk7docs", title: "trim dead i18n keys", cwd: "/srv/app/docs", age: 31 },
  // /home/deploy/code/scratch
  { id: "01H8ZQk8scr", title: "scratch: parse the probe output", cwd: "/home/deploy/code/scratch", age: 40 },
  { id: "01H8ZQk9scr", title: "scratch: try tmux -CC", cwd: "/home/deploy/code/scratch", age: 47 },
  // no workspace — one null cwd, one whitespace, which the rail also buckets
  { id: "01H8ZQk10orphan", title: "orphan rollout", cwd: null, age: 58 },
  { id: "01H8ZQk11orphan", title: null, cwd: "   ", age: 66 },
  // Codex rollouts / launchd; the rail lists these in their own group
  { id: "01H8ZQk12sched", title: "nightly regression (codex exec)", cwd: "/srv/app/faragent", age: 74, scheduled: true },
  { id: "01H8ZQk13sched", title: "launchd: sync mirrors", cwd: null, age: 85, scheduled: true },
];

/**
 * The backend rebuilds the list per `(host, agent, os)`; the fixture stamps the
 * requested agent on every row rather than pretending only one agent exists.
 * The scheduled rows are returned for every agent — the rail renders a
 * scheduled group whenever the data has one, and keeping it makes the fourth
 * mark reachable without switching agents first.
 *
 * The launched sessions of this process are appended, from `launched` below —
 * see `launchedRows`, which is the one place the rows-join fix is observable
 * outside Rust.
 */
export function listSessions(agent: AgentKind): Session[] {
  return [
    ...SESSION_SEEDS.map((seed) => ({
      id: seed.id,
      agent,
      title: seed.title,
      cwd: seed.cwd,
      mtime: NOW - seed.age * MIN,
      live: !!seed.live,
      running: !!seed.running,
      tmux: seed.live ? tmuxName(agent, seed.id) : null,
      scheduled: !!seed.scheduled,
      // A transcript path is agent-specific (Claude's lives under
      // `~/.claude/projects`), and the row that has one is a Claude row — so it is
      // stripped for every other agent rather than leaked onto a Codex or Grok
      // row, which is what an un-gated stamp would do.
      transcript: agent === "claude" ? (seed.transcript ?? null) : null,
    })),
    ...launchedRows(agent),
  ];
}

/** The home the mock's POSIX remote reports (`probe`, and `expand_home`). */
const MOCK_HOME = "/home/deploy";

/**
 * A session this mock started from the app: the tmux name it was ensured under,
 * the id it was pinned to, the file the app will find that id's conversation in,
 * and whether the CLI has taken a first turn yet.
 */
interface LaunchedSession {
  sessionId: string;
  path: string;
  /** The cwd the launch carried — the `(live)` row's group, and nothing else. */
  cwd: string;
  /**
   * The first turn's text, once there has been one — the title a real file row
   * reads out of the jsonl (`remote::jsonl_meta`). `null` until then, which is
   * also what makes a row a *file* row: `written` is whether the file exists.
   */
  title: string | null;
}

/**
 * The sessions this mock has *launched*, keyed by the tmux name they were
 * ensured under: what a `--session-id`-pinned Claude session answers.
 */
const launched = new Map<string, LaunchedSession>();

/**
 * The rows a launched session contributes to the list, modelled on
 * `merge_sessions` rather than assumed to join.
 *
 * The backend has two ways to report a live tmux session, and which applies
 * turns on whether a file exists yet:
 *
 * - A **file row** goes live only when `tmux_name(agent, row.id)` is a name the
 *   tmux dump carries. That is the join. An unjoined file row is not live, and
 *   its `tmux` is the name its own id derives — which is what makes it a second
 *   row for a session the dump row already describes.
 * - A **tmux session** no file row claimed becomes its own `(live)` row, whose
 *   id is the *short* suffix `tmux_id_from_name` reads out of the name — never
 *   the uuid, which the name does not carry.
 *
 * So the join is computed here rather than asserted: with a name derived from
 * the pinned id (what `ensureSession` does, as `sessions.rs:155` does) the two
 * are one row; with a name derived from anything else they are two. It is
 * derived from `launched` and not from the fixture filesystem, because the mock
 * has no directory of `~/.claude/projects` to scan: `noteLaunchedTurn` is the
 * stand-in for the CLI writing the file.
 */
function launchedRows(agent: AgentKind): Session[] {
  const rows: Session[] = [];
  for (const [name, fresh] of launched) {
    // `launched` only ever holds Claude sessions: the `--session-id` pin is what
    // makes a file nameable before it exists, and only Claude takes it.
    if (agent !== "claude") continue;

    const joined = tmuxName(agent, fresh.sessionId) === name;
    if (fresh.title !== null) {
      rows.push({
        id: fresh.sessionId,
        agent,
        title: fresh.title,
        cwd: fresh.cwd,
        // Newer than every seed: a session started a moment ago sorts to the top,
        // and `mtime` is what the rail sorts by.
        mtime: NOW + MIN,
        live: joined,
        running: false,
        tmux: joined ? name : tmuxName(agent, fresh.sessionId),
        scheduled: false,
        transcript: fresh.path,
      });
    }
    if (!joined || fresh.title === null) {
      rows.push({
        id: tmuxIdFromName(agent, name) ?? name,
        agent,
        title: "(live)",
        cwd: fresh.cwd,
        mtime: NOW + MIN,
        live: true,
        running: false,
        tmux: name,
        scheduled: false,
        transcript: null,
      });
    }
  }
  return rows;
}

/**
 * Record that a launched session's CLI has taken a turn: `line` is the first
 * one, which is the title the row will carry, and the file now exists.
 *
 * Called by `handlers.ts`'s `submit` — the one place the mock writes a
 * transcript — so that `launchedRows` can report the session the way
 * `merge_sessions` would *after* the file lands rather than before. A path no
 * launch claims is ignored: the seeded sessions' files are there from the start.
 */
export function noteLaunchedTurn(path: string, line: string): void {
  for (const fresh of launched.values()) {
    if (fresh.path !== path) continue;
    fresh.title ??= line;
  }
}

/**
 * A uuid-shaped id, deterministic in its order of issue.
 *
 * The real backend takes the uuid the CLI would have chosen; the mock has no
 * CLI, so it counts. Deterministic rather than random so two runs of the same
 * script produce the same paths, which is what makes a screenshot reproducible.
 */
let launchSeq = 0;

function newSessionUuid(): string {
  launchSeq += 1;
  return `0152c0de-0000-4000-8000-${String(launchSeq).padStart(12, "0")}`;
}

/** Mirrors `ensure_session`: the tmux name it attached, and the session uuid. */
export function ensureSession(
  agent: AgentKind,
  cwd: string,
  sessionId: string | null,
): EnsuredSession {
  // The id is settled FIRST and the name is derived from it — `sessions.rs:152`
  // takes the caller's id or generates one, and `:155` names the tmux session
  // after *that*. Never after the cwd: the name is what a later listing joins a
  // file row by (`merge_sessions` recomputes `tmux_name(agent, row.id)`), and
  // the file is named by the id, so a name derived from anything else is a name
  // no file row can match. That mismatch is the two-rows-for-one-session bug
  // this fixture's `launchedRows` now reproduces rather than hides.
  const id = sessionId ?? newSessionUuid();
  const name = tmuxName(agent, id);
  // A resume already has its id; there is nothing new to name. A *new* Claude
  // session is the one the `--session-id` pin exists for — the id is what makes
  // its transcript path computable before the file is written — so the mock
  // pins one too, and remembers the pair so the file the terminal later writes
  // is the one the app computed a path for.
  if (sessionId !== null) return { name, session_id: sessionId };
  if (agent !== "claude") return { name, session_id: null };
  const path = claudeTranscriptPath(id, cwd, MOCK_HOME, "posix");
  if (path !== null) launched.set(name, { sessionId: id, path, cwd, title: null });
  return { name, session_id: id };
}

/**
 * The conversation file a terminal's attach spec belongs to, the session it is,
 * and whether that file **may not exist yet** — or `null` for a spec with no
 * conversation behind it (a login shell, an install run, a session whose row
 * never carried a transcript).
 *
 * This is the mock's **inverse** of `sessionTabKey`/`ensureSession`: the attach
 * carries a tmux name or a session id and nothing else, while the transcript is
 * named by session id, so a mock that wants to show a typed message arriving has
 * to resolve one from the other. It answers for the seeded sessions — the only
 * ones whose files are there from the start — and for the sessions this mock has
 * launched.
 *
 * `late` is the honest difference between the two: a launched session's file is
 * written by its CLI on the first turn, exactly as it is on a real remote, so
 * the file is *not* registered when the session is (see `handlers.ts`'s
 * `submit`, which creates it the moment something is typed). It is a property of
 * the spec, not of the moment: after the first line the file exists and creating
 * it again is a no-op.
 */
export function transcriptForSpec(
  spec: AttachSpec,
): { path: string; sessionId: string; late: boolean } | null {
  if (spec.kind === "tmux") {
    const fresh = launched.get(spec.tmux_name);
    if (fresh) return { path: fresh.path, sessionId: fresh.sessionId, late: true };
    for (const seed of SESSION_SEEDS) {
      if (seed.transcript && tmuxName("claude", seed.id) === spec.tmux_name) {
        return { path: seed.transcript, sessionId: seed.id, late: false };
      }
    }
    return null;
  }
  if (spec.kind === "win_agent") {
    const { session_id } = spec;
    if (session_id === null) return null;
    const seed = SESSION_SEEDS.find((s) => s.id === session_id && s.transcript);
    return seed?.transcript
      ? { path: seed.transcript, sessionId: session_id, late: false }
      : null;
  }
  return null;
}

/**
 * One `user` turn, as the jsonl line a Claude transcript would carry it in.
 *
 * Handed to `appendFile` by `handlers.ts` when something is typed into a
 * session. The shape is the one `transcriptJsonl` above uses — `content` a bare
 * string is the spelling `lib/chat/adapters/claude.ts` turns into one message —
 * and the text is written **exactly as it was typed**, which is what lets the
 * composer's echo be recognised and dropped when the record lands
 * (`lib/chat/echo.ts` matches on the text, so a fixture that trimmed or
 * decorated it would leave every echo on screen twice).
 */
let userTurnSeq = 0;

export function userTurnJsonl(sessionId: string, text: string, at: number): string {
  userTurnSeq += 1;
  return (
    JSON.stringify({
      type: "user",
      uuid: `mock-u${String(userTurnSeq).padStart(4, "0")}`,
      timestamp: new Date(at * 1000).toISOString(),
      sessionId,
      cwd: "/srv/app/faragent",
      gitBranch: "main",
      message: { role: "user", content: text },
    }) + "\n"
  );
}

// ------------------------------------------------------------------- dirs

/** A tiny virtual tree so the new-session picker has somewhere to walk. */
const DIRS: Record<string, string[]> = {
  "/": ["home", "srv"],
  "/home": ["deploy"],
  "/home/deploy": ["code"],
  "/home/deploy/code": ["faragent", "scratch"],
  "/home/deploy/code/faragent": ["apps", "crates", "docs", "src-tauri"],
  "/home/deploy/code/scratch": ["probe", "tmux"],
  "/srv": ["app"],
  "/srv/app": ["faragent", "docs"],
  "/srv/app/faragent": ["apps", "crates", "docs", "target"],
  "/srv/app/faragent/apps": ["faragent-app"],
  "/srv/app/faragent/apps/faragent-app": ["src", "src-tauri", "public"],
  "/srv/app/faragent/crates": [
    "faragent-core",
    "faragent-remote",
    "faragent-transport",
    "faragent-tui",
  ],
  "/srv/app/faragent/docs": ["design"],
  "/srv/app/docs": ["zh", "en"],
};

function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function parentOf(path: string): string {
  if (path === "/") return "/";
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function listDirs(path: string): DirListing {
  const cwd = trimTrailingSlash(path.trim() || "/");
  return { cwd, parent: parentOf(cwd), dirs: [...(DIRS[cwd] ?? [])] };
}

/**
 * `~` / `~/x` (or `~\x`) against a remote home, in that host's separator style.
 * Prefix only: `~bob` and mid-path tildes stay literal.
 *
 * This mirrors `faragent_core::paths::expand_home` (`crates/faragent-core/src/
 * paths.rs`) line for line, because a UI check of the new-session picker
 * compares what the picker shows against what *this* returns — if the two
 * disagree, the check passes while proving nothing. The three details below are
 * easy to get subtly wrong, and each has a test (`mock.test.ts`) and a matching
 * case in the Rust `paths.rs` tests:
 *
 * - `home` gets its trailing separators stripped (`/` for posix, `/` *and* `\`
 *   for windows), so a home ending in a separator does not double up.
 * - Input is matched exactly. `"~"` is not trimmed, so `" ~/x"` does **not**
 *   expand — the backend would return it literally, and so must this.
 * - Windows always joins with `\` and rewrites every inner `/` to `\`, even when
 *   the input was written `~/`.
 */
export function expandHome(path: string, home: string, os: "posix" | "windows"): string {
  if (path === "~") return home;
  if (os === "windows") {
    for (const prefix of ["~/", "~\\"]) {
      if (path.startsWith(prefix)) {
        const rest = path.slice(prefix.length).replaceAll("/", "\\");
        return `${home.replace(/[\\/]+$/, "")}\\${rest}`;
      }
    }
    return path;
  }
  if (path.startsWith("~/")) {
    return `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
  }
  return path;
}

// ---------------------------------------------------------------- dialogs

export function githubSync(host: string): GitHubSync {
  return {
    user: "deploy",
    remoteGh: true,
    sshKeyAdded: false,
    warnings: [
      {
        zh: `mock：没有真的把 gh 凭据复制到 ${host}`,
        en: `mock: no gh credential was actually copied to ${host}`,
      },
    ],
    lines: {
      zh: [`已在 ${host} 上找到 gh`, "SSH 密钥保持原样（mock）", "没有写入任何文件"],
      en: [`found gh on ${host}`, "left the SSH key alone (mock)", "wrote no files"],
    },
  };
}

export function installPlan(host: string, agent: AgentKind, action: Action): Plan {
  const title = AGENT_TITLES[agent];
  const install = action !== "uninstall";
  const command = install
    ? `npm install -g ${agent}@latest`
    : `npm uninstall -g ${agent}`;
  return {
    action,
    agent,
    script: `set -e\n${command}\n`,
    steps: [
      {
        title: install ? `install ${title}` : `remove ${title}`,
        command,
        sudo: false,
      },
    ],
    blocked: null,
    warnings: [],
    suggested: [],
    canRun: true,
    title: { zh: `${action} ${title}`, en: `${action} ${title}` },
    listTitle: { zh: `${title} · ${action}`, en: `${title} · ${action}` },
    blockedText: null,
    warningTexts: [],
    stepSudo: { zh: "以 root 运行", en: "runs as root" },
    suggestedTitle: { zh: `建议在 ${host} 上执行`, en: `Suggested on ${host}` },
  };
}

/**
 * `install_preflight` is registered but no frontend code consumes it yet, so
 * this only has to be shaped like `PreflightDto` — a later task that starts
 * reading it can tighten it.
 */
export interface PreflightFixture {
  os: "posix" | "windows";
  home: string;
  curl: boolean;
  node: boolean;
  npm: boolean;
  nvm: boolean;
  tmux: boolean;
  winget: boolean;
  pkg: string | null;
  agentFound: boolean;
  agentPath: string | null;
  liveTmux: boolean;
}

export function installPreflight(host: string, agent: AgentKind): PreflightFixture {
  const p = probe(host);
  const found = p.agents.find((a) => a.id === agent);
  const windows = p.os === "windows";
  return {
    os: p.os,
    home: p.home,
    curl: !windows,
    node: true,
    npm: true,
    nvm: false,
    tmux: p.tmux.found,
    winget: windows,
    pkg: windows ? "winget" : "apt-get",
    agentFound: !!found?.found,
    agentPath: found?.path ?? null,
    liveTmux: p.tmux.found,
  };
}

// ------------------------------------------------------------ in-memory state

/** `get/set_full_permissions` persist to config.json in the backend; in the
 *  mock they live for the page's lifetime, which is all a screenshot needs. */
let fullPermissions = true;

export function getFullPermissions(): boolean {
  return fullPermissions;
}

export function setFullPermissions(on: boolean): void {
  fullPermissions = on;
}

/** Same story as the permissions: in-memory, not written to config.json. */
let language: Lang = "zh";

export function getLanguage(): Lang {
  return language;
}

export function setLanguage(lang: string): void {
  if (lang === "zh" || lang === "en") language = lang;
}

/** `askpass_active`: no password is ever held, so the password flow is reachable
 *  only through the diagnosis path, exactly as with a key-only host. */
export function askpassActive(): boolean {
  return false;
}

export function askpassInstall(): boolean {
  return true;
}

# Chat adapters for Codex, Grok and Pi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chat view an adapter for each of Codex, Grok and Pi, and let a new Grok session compute its transcript path the way a new Claude session already does.

**Architecture:** Every adapter is a pure function `(records: unknown[]) => ChatEvent[]` registered in one map in `adapters/index.ts`. It reads records the tail already parsed and writes the model in `lib/chat/events.ts` and nothing else — no React, no DOM, no helper connection. Tasks 2–4 touch one adapter file and its test each, so they are disjoint and land as separate commits; Task 1 is the shared groundwork they all sit on and lands first.

**Tech Stack:** TypeScript run directly by `node --test` (no bundler, no transpile step), React + Vite for the app shell, Rust 1.80 workspace for the remote scripts.

**Spec:** `docs/superpowers/specs/2026-09-15-chat-adapters-design.md`

## Global Constraints

- Work only in this worktree: `/Users/maqb11/code/ma-code/FarAgent/.worktrees/chat-adapters` on branch `feat/chat-adapters`.
- Frontend tests: `npm test` in `apps/faragent-app` (`node --test "src/**/*.test.ts"`). Type check: `npm run build`. Rust: `cargo test --workspace`.
- TDD: write the failing test first, watch it fail, then implement. Tests live beside their subject (`foo.ts` / `foo.test.ts`), matching this repo.
- Adapters are **total**: never throw, for any input, including a container that is not an array. Guard every level with the `isObject` helper `claude.ts` defines.
- Only measured shapes are implemented. Anything not measured is researched in the vendor's docs or source first, and marked `unverified` at the field and in the fixture. Never guess a shape into existence.
- `EventBase.timestamp` is `string | null` and `null` is a normal value, not a failure.
- `adapterFor` returning `null` keeps meaning "this agent has no chat view, fall back to the terminal". Do not replace it with an empty-array stub.
- Comments are prose that explains *why*, in the register of `adapters/claude.ts` and `transcript-path.ts`. Do not add comments that restate the code.
- user-facing strings need both languages (`lib/i18n.ts`; `i18n-coverage.test.ts` enforces it).
- Commit messages follow this repo: `app: what changed` for the frontend, `remote: …` / `service: …` for Rust.
- Do not commit unless the tests you added were seen failing first.

## File map

| File | Responsibility |
| --- | --- |
| `apps/faragent-app/src/lib/chat/transcript-path.ts` | `transcriptPathFor(agent, …)` + Grok's rule (Task 1) |
| `apps/faragent-app/src/lib/chat/transcript-path.test.ts` | Grok/Codex/Pi cases (Task 1) |
| `apps/faragent-app/src/lib/chat/adapters/index.ts` | registry: three new entries (Tasks 1–4) |
| `apps/faragent-app/src/components/shell/session-launcher.tsx` | call `transcriptPathFor` (Task 1) |
| `apps/faragent-app/src/lib/chat/adapters/codex.ts` + `.test.ts` | Codex adapter (Task 2) |
| `apps/faragent-app/src/lib/chat/adapters/grok.ts` + `.test.ts` | Grok adapter (Task 3) |
| `apps/faragent-app/src/lib/chat/adapters/pi.ts` + `.test.ts` | Pi adapter (Task 4) |
| `apps/faragent-app/src/lib/mock/fixtures.ts` | a transcript fixture per new agent (Tasks 2–4) |
| `crates/faragent-remote/src/remote.rs` | Pi `cwd_hint` (Task 5) |
| `docs/{zh,en}/{development,roadmap,user-guide}.md` | the six doc edits (Task 6) |

---

### Task 1: transcript-path dispatch, registry groundwork

**Files:**
- Modify: `apps/faragent-app/src/lib/chat/transcript-path.ts`
- Modify: `apps/faragent-app/src/lib/chat/transcript-path.test.ts`
- Modify: `apps/faragent-app/src/components/shell/session-launcher.tsx`
- Modify: `apps/faragent-app/src/lib/chat/adapters/index.ts`

**Interfaces:**
- Consumes: existing `claudeTranscriptPath`, `projectSlug`, `joinPath` from `lib/panel/paths.ts`
- Produces: `transcriptPathFor(agent: AgentKind, sessionId: string, cwd: string, home: string, os: "posix" | "windows"): string | null` and `grokTranscriptPath(...)`

- [ ] **Step 1: Write the failing tests**

`grokTranscriptPath` percent-encodes the cwd into one directory name. Measured on this machine: `/Users/maqb11/code/ma-code/FarAgent` yielded the directory literally named `%2FUsers%2Fmaqb11%2Fcode%2Fma-code%2FFarAgent`, and inside it one directory per session id holding `chat_history.jsonl`.

```ts
test("grokTranscriptPath percent-encodes the cwd into one path segment", () => {
  assert.equal(
    grokTranscriptPath(ID, "/srv/my app/faragent", "/home/deploy", "posix"),
    `/home/deploy/.grok/sessions/%2Fsrv%2Fmy%20app%2Ffaragent/${ID}/chat_history.jsonl`,
  );
});

test("transcriptPathFor dispatches, and is null where the id cannot be pinned", () => {
  assert.equal(transcriptPathFor("grok", ID, "/srv/app", "/h", "posix"), grokTranscriptPath(ID, "/srv/app", "/h", "posix"));
  assert.equal(transcriptPathFor("claude", ID, "/srv/app", "/h", "posix"), claudeTranscriptPath(ID, "/srv/app", "/h", "posix"));
  // Neither accepts --session-id, so the CLI picks the id and the launch cannot know the path.
  assert.equal(transcriptPathFor("codex", ID, "/srv/app", "/h", "posix"), null);
  assert.equal(transcriptPathFor("pi", ID, "/srv/app", "/h", "posix"), null);
});

test("transcriptPathFor is null on a Windows remote for every agent", () => {
  for (const agent of ["claude", "codex", "grok", "pi"] as const) {
    assert.equal(transcriptPathFor(agent, ID, "C:\\s", "C:\\u", "windows"), null, agent);
  }
});
```

**Measure the encoding before trusting the test.** The rule above is `encodeURIComponent` per segment; confirm it against a real `~/.grok/sessions` listing and adjust the assertion to what is on disk. If a measured cwd encodes differently (a space, a `+`, a non-ASCII segment), the on-disk name wins and the doc comment records the measured example the way `projectSlug` does.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd apps/faragent-app && npm test`
Expected: FAIL — `grokTranscriptPath` and `transcriptPathFor` are not exported.

- [ ] **Step 3: Implement**

Keep `claudeTranscriptPath` and `projectSlug` exactly as they are — their tests are measured assets. Add the Grok rule and the dispatcher, with a module doc that states why Codex and Pi return `null` and points at `AgentKind::may_accept_session_id` as the source of that distinction.

- [ ] **Step 4: Point the launcher at the dispatcher**

In `session-launcher.tsx`, the call at the `claudeTranscriptPath(...)` site becomes `transcriptPathFor(agent, …)`. Nothing else in that file changes; a `null` return already flows into the existing "no transcript path, open on the terminal" behaviour.

- [ ] **Step 5: Refresh the registry doc**

`adapters/index.ts` currently says "Only Claude is registered… their adapters are a later task". That stops being true. Rewrite the header so the rule it states is the permanent one — an agent with no adapter returns `null`, which means the tab has no chat view and keeps its terminal — and the maintenance note is "adding one is a single entry below". Do not add the three entries yet if their modules do not exist: an import of a missing file breaks the build. Add each entry in its own task.

- [ ] **Step 6: Verify and commit**

Run: `cd apps/faragent-app && npm test && npm run build`
Expected: all tests pass, `tsc` clean.

```bash
git add -A && git commit -m "app: dispatch a new session's transcript path per agent"
```

---

### Task 2: Codex adapter

**Files:**
- Create: `apps/faragent-app/src/lib/chat/adapters/codex.ts`
- Create: `apps/faragent-app/src/lib/chat/adapters/codex.test.ts`
- Modify: `apps/faragent-app/src/lib/chat/adapters/index.ts` (one entry)
- Modify: `apps/faragent-app/src/lib/mock/fixtures.ts`

**Interfaces:**
- Consumes: `ChatEvent`, `MessageEvent`, `ToolEvent` from `../events.ts`
- Produces: `export function adapt(records: unknown[]): ChatEvent[]`

Read the spec's Codex section before writing. The load-bearing decisions, all measured:

- Read **`response_item` only**. `event_msg` repeats the same text; reading both doubles every message. Test this explicitly — a fixture containing both spellings must yield exactly one event per message, and a fixture holding only the `event_msg` half must yield none.
- `reasoning` becomes a `ThinkingEvent`, with the text taken from `content`'s `reasoning_text` blocks and `summary`'s `summary_text` blocks as the fallback. The corpus is 97% readable and the readable field moved in June 2026 — see the spec's table, and put that table (not a one-line claim) in the module doc.
- `message.role` has a third value, `developer`, which is dropped: `ChatEvent` has two roles and folding these into either would misreport who spoke.
- Name events by the record's `ordinal`, not its array index — `loadEarlier` prepends records and would drift an index.
- `function_call.arguments` is a JSON **string**, passed to `ToolEvent.input` verbatim, unparsed.
- `call_id` is both the event id and the pairing key for `function_call_output`. There is no error signal in that record, so `isError` is the conservative `false`, marked `unverified`.
- `sidechain` is always `false`; there is no flag in the record.

- [ ] **Step 1: Write the failing tests**

Fixture records must be built to the measured shapes verbatim (see the real sample in the spec), constructed with `JSON.stringify` the way `mock/fixtures.ts` already does it. Cover: a user message, an assistant message, a call and its later result pairing on `call_id`, the duplicate-write case yielding one message, a `reasoning` record yielding no event, the non-conversation top-level types yielding nothing, and totality for junk input (a non-array container, `null` records, wrong-typed fields, a `function_call` with no `name`).

- [ ] **Step 2: Run and watch them fail**

Run: `cd apps/faragent-app && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `adapt`**

Mirror `claude.ts` structurally: walk records once, keep a `Map` of emitted calls by id so a later result finds its call, keep a `Set` of emitted ids so a record written twice emits one event, and skip anything not understood. Do not share code with `claude.ts` by extracting a helper — the two walks differ in where the tool call lives and what pairs it, and a premature abstraction would obscure both.

- [ ] **Step 4: Register it**

Add `codex: adaptCodex` to `ADAPTERS`. Extend `transcriptJsonl`-style fixture support in `mock/fixtures.ts` so the mocked channel can serve a Codex transcript for the end-to-end check.

- [ ] **Step 5: Verify and commit**

Run: `cd apps/faragent-app && npm test && npm run build`

```bash
git add -A && git commit -m "app: a chat adapter for Codex transcripts"
```

---

### Task 3: Grok adapter

**Files:**
- Create: `apps/faragent-app/src/lib/chat/adapters/grok.ts`
- Create: `apps/faragent-app/src/lib/chat/adapters/grok.test.ts`
- Modify: `apps/faragent-app/src/lib/chat/adapters/index.ts` (one entry)
- Modify: `apps/faragent-app/src/lib/mock/fixtures.ts`

**Interfaces:**
- Produces: `export function adapt(records: unknown[]): ChatEvent[]`

The load-bearing decisions, all measured:

- `assistant.content` is a bare string → one `MessageEvent`. It is **not** a block array.
- Tool calls live in `assistant.tool_calls[]`, ids paired with `tool_result.tool_call_id`.
- `reasoning.summary[]` holds `{type: "summary_text", text}`; join the parts in order, skip parts without a string `text`, and emit nothing when the join is empty. State the joining rule in a comment — the renderer draws one collapsed row and must not receive a second one per summary part.
- `timestamp` is always `null`; the records have no time field. Say why in the module doc, or someone will add timestamp parsing that can never succeed.
- `system` records are dropped.

- [ ] **Step 1: Write the failing tests**

Cover: a user record with text blocks, an assistant record with bare-string content plus two tool calls, results pairing by `tool_call_id`, a `reasoning` with several `summary_text` parts (one collapsed `ThinkingEvent`), a `reasoning` with an empty summary (no event), a `system` record (no event), a `tool_result` with no matching call (no event), and totality for junk.

Before asserting anything about a Grok **error** result, research the shape (the spec's *Unverified shapes* table). If it cannot be established, assert the conservative `isError: false` and mark the fixture `unverified`.

- [ ] **Step 2: Run and watch them fail** — `cd apps/faragent-app && npm test`

- [ ] **Step 3: Implement `adapt`**, Step 4: **register it** (`grok: adaptGrok`), Step 5: **verify and commit**

```bash
git add -A && git commit -m "app: a chat adapter for Grok transcripts"
```

---

### Task 4: Pi adapter

**Files:**
- Create: `apps/faragent-app/src/lib/chat/adapters/pi.ts`
- Create: `apps/faragent-app/src/lib/chat/adapters/pi.test.ts`
- Modify: `apps/faragent-app/src/lib/chat/adapters/index.ts` (one entry)
- Modify: `apps/faragent-app/src/lib/mock/fixtures.ts`

**Blocked on a real sample.** This machine's Anthropic credentials belong to the Claude desktop app's local proxy and Pi is refused by it (403), so Pi cannot produce a session until one of: the user runs `pi` and completes `/login`, or supplies a usable provider key. Until then this task is implemented against the installed package's `docs/session-format.md` and every shape is marked `unverified`. Do not ship it as measured.

The load-bearing decisions:

- The first line is `type: "session"` (a `SessionHeader`) — not conversation, and it carries the session's `cwd`.
- Conversation lines are `type: "message"`; the payload is `entry.message`.
- `role: "user"` / `"assistant"` blocks map as in the spec's table. `role: "toolResult"` carries `toolCallId`, `toolName`, `isError` and text blocks — it fills a call's result rather than emitting a row.
- The four extension roles (`bashExecution`, `custom`, `branchSummary`, `compactionSummary`) are not the conversation. Decide each one and record the decision in a comment; dropping all four is the defensible default, and `bashExecution` (a local shell command the user ran, with its output) is the one worth reconsidering out loud.
- Entries are a **tree**. Render in file order and rely on the id set to keep a re-written entry from doubling; settle the fork case against a real session that has been `/fork`ed, and say what was observed.

- [ ] **Step 1: obtain a sample** — see the block above. Then write the tests from it.
- [ ] **Step 2: run and watch them fail**, **Step 3: implement**, **Step 4: register** (`pi: adaptPi`), **Step 5: verify and commit**

```bash
git add -A && git commit -m "app: a chat adapter for Pi transcripts"
```

---

### Task 5: Pi cwd resolution

**Files:**
- Modify: `crates/faragent-remote/src/remote.rs` and/or `crates/faragent-service/src/sessions.rs`

**Do not guess which of these needs to change — find out first.** The Pi `cwd_hint` is `--Users-me-code-app--` (wrapper dashes included) and `sessions.rs` currently feeds it to `percent_decode`, which is Grok's rule and leaves it unchanged. `row_from_file` already prefers the header's cwd (`m.cwd.or(hint)`), so the first question is whether `jsonl_meta` reads Pi's header at all.

- [ ] **Step 1: Determine the current behaviour** with a test, not a reading. Build a `DiskFile` whose body is a real Pi `SessionHeader` and whose `cwd_hint` is the real wrapper-dashed name, run it through `row_from_file`, and assert what cwd comes out. That failing (or passing) assertion is the finding.
- [ ] **Step 2: Fix the branch that is actually wrong.** If `jsonl_meta` reads the header, the hint is only a fallback and the fix is to stop treating the Pi hint as percent-encoded — strip the `--` wrapper and turn `-` back into `/`, or leave it `None`. If it does not read the header, fix that. Either way the assertion from Step 1 becomes the regression test.
- [ ] **Step 3: verify and commit** — `cargo test --workspace`

```bash
git add -A && git commit -m "remote: read Pi's cwd from its session header, not its directory name"
```

---

### Task 6: Docs

**Files:** `docs/zh/development.md`, `docs/en/development.md`, `docs/zh/roadmap.md`, `docs/en/roadmap.md`, `docs/zh/user-guide.md`, `docs/en/user-guide.md`

- [ ] **Step 1:** *Adding an agent* gains a step 5 — register a chat adapter — and a sentence that `may_accept_session_id` decides whether a new session's transcript path is knowable at launch.
- [ ] **Step 2:** roadmap: mark whatever this work completes. Read the file first; do not invent entries.
- [ ] **Step 3:** user-guide: the "which agents have a conversation view" text goes from Claude-only to all four.
- [ ] **Step 4:** both languages, same meaning. `localized-text`-style drift between zh and en is the failure mode here.

---

## Verification

Not a single-agent self-check: the dev/verify split is required (CLAUDE.md), so an independent test subagent designs and runs the acceptance pass.

1. `cd apps/faragent-app && npm test` — the adapter suites plus the existing ones (the repo's other tests must not regress; `i18n-coverage.test.ts` in particular).
2. `npm run build` — `tsc` clean.
3. `cargo test --workspace` — the remote/service tests, including the new Pi cwd regression test.
4. **Mocked end-to-end:** with the fixture transcripts registered in `lib/mock/channel.ts`, open a Codex and a Grok session and confirm the chat view renders the conversation. Confirm the fallback too: an agent with no adapter still opens on the terminal (`state.ts` `defaultTabView`).
5. **Real remote spot-check:** on a host that has all four agents, open one session per agent and compare the rendered conversation against what the terminal shows.
6. **Run the app:** `npm run dev` in `apps/faragent-app` and look at it. UI conclusions come from the rendered result, not from reading CSS or the accessibility tree.

## Self-review

- **Spec coverage:** the spec's three measured record-shape sections map 1:1 onto Tasks 2–4; its transcript-path table onto Task 1; its Pi cwd defect onto Task 5; its *Surfaces* onto the Verification section.
- **Disjointness:** Tasks 2, 3, 4 and 5 each touch files no other task touches, except the one-line registry entry per adapter and the shared `mock/fixtures.ts` — both are append-only and ordered by task, so they cannot conflict on content.
- **Ordering:** Task 1 must land before 2–4 (the dispatcher and the registry doc). 2–4 are independent of each other. Task 4 is gated on a sample, not on the others.
- **Open risk:** Task 4's correctness depends entirely on a sample that does not exist yet; if it cannot be obtained, that task ships document-derived and `unverified`, or is dropped from this branch.

# Chat adapters for Codex, Grok and Pi

Approved 2026-09-15. Three per-agent adapters behind the registry `apps/faragent-app/src/lib/chat/adapters/index.ts`, plus the transcript-path work they depend on.

The chat view renders a session's conversation by tailing its transcript on the remote. That path was built in layers: `lib/chat/transcript.ts` moves and frames bytes and knows only that the file is line-delimited JSON; an **adapter** turns one agent's records into the unified model in `lib/chat/events.ts`. Only Claude has one. The remote discovery side (`crates/faragent-remote/src/remote.rs` `list_script`) has listed all four agents' transcripts for some time, so Codex, Grok and Pi sessions today open on the terminal — not for want of data, but because the renderer cannot read what came back.

`adapterFor` returning `null` stays the honest answer for an agent with no adapter, and the callers already fall back to the terminal (`state.ts` `tabHasChatView`, `defaultTabView`). This spec adds three entries; it does not change what `null` means.

## Measured record shapes

Every shape below was read from a real transcript on disk. Where the measurement contradicts what the record type is remembered to be, the measurement wins and the disagreement is called out at the field — the same discipline `adapters/claude.ts` records for its own S0 spike.

### Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`

Records are filed by date, **not under a cwd**. Top-level `type` is one of `session_meta`, `response_item`, `event_msg`, `turn_context`. Conversation lives inside `payload` of `response_item`:

| `payload.type` | Shape |
| --- | --- |
| `message` | `{role: "user"\|"assistant", content: [{type: "input_text"\|"output_text", text}]}` |
| `function_call` | `{name, arguments: "<JSON string>", call_id}` |
| `function_call_output` | `{call_id, output: "<JSON string>"}` |
| `reasoning` | `{summary: [], content: null, encrypted_content: "<encrypted>"}` |

Three measured facts drive the adapter:

1. **The same text is written twice.** Once in `event_msg` `payload.type === "item_completed"` (as `payload.item.type` `UserMessage` / `AgentMessage`) and once in the `response_item` that follows it. Verified record by record. The adapter reads **`response_item` only**; reading both renders every message twice.
2. **Thinking is not renderable.** Every measured `reasoning` record has `summary: []` and `content: null`; the body exists only as `encrypted_content`. The adapter therefore emits no `ThinkingEvent`. This is a finding, not an omission, and it belongs in the module doc so it is not "fixed" later by guessing at a summary field.
3. **`arguments` is a string.** Unlike Claude's `tool_use.input`, which is already an object. `ToolEvent.input` is typed `unknown` and `events.ts` promises it is kept verbatim as the adapter found it, so it is passed through unparsed.

### Grok — `~/.grok/sessions/<percent-encoded-cwd>/<uuid>/chat_history.jsonl`

| `type` | Shape |
| --- | --- |
| `user` | `{content: [{type: "text", text}]}` |
| `assistant` | `{content: "<bare string>", tool_calls: [{id, name, arguments: "<JSON string>"}], model_id, reasoning_effort}` |
| `reasoning` | `{id, summary: [{type: "summary_text", text}], encrypted_content, status}` |
| `tool_result` | `{tool_call_id, content: "<string>"}` |
| `system` | `{content: "<string>"}` |

Measured facts:

1. `assistant.content` is a **bare string**, not a block array. This is a third spelling, distinct from Claude's two.
2. Tool calls sit in a separate `tool_calls` array, paired `tool_calls[].id` ↔ `tool_result.tool_call_id`. The record carries no uuid to pair on.
3. A `reasoning` record's readable text is `summary[].text` — the field is neither `thinking` nor `content`; the body is encrypted like Codex's.
4. **Records carry no timestamp.** `EventBase.timestamp` is `null` for every Grok event. That is a legal value of the model, not a defect.
5. A measured `tool_result` has exactly `type`, `tool_call_id`, `content` — **no error flag**. See *Unverified shapes*.

### Pi — `~/.pi/agent/sessions/--<cwd path>/--/<timestamp>_<uuid>.jsonl`

Pi 0.73.0 is installed locally (`/opt/homebrew/bin/pi`) and ships `docs/session-format.md`, which is the authority here because no Pi sample existed when the spike ran.

- The first line is a `SessionHeader`, `{"type":"session","version":3,"id","timestamp","cwd"}` — it carries the **cwd directly**, so the directory name never has to be decoded.
- Conversation lines are `{"type":"message","id","parentId","timestamp","message":<AgentMessage>}`.
- `AgentMessage.role` is `user`, `assistant` or `toolResult`, plus four extension roles: `bashExecution`, `custom`, `branchSummary`, `compactionSummary`.
- Blocks are `{type:"text",text}`, `{type:"thinking",thinking}`, `{type:"toolCall",id,name,arguments}`, `{type:"image"}`.
- `ToolResultMessage` carries `isError: boolean` and `toolName`.
- **Entries form a tree, not a chain** (`id`/`parentId`). `/fork`, `/clone` and compaction leave branches in one file, so the adapter must decide what to draw.

## Mapping

| Adapter | Record | Event |
| --- | --- | --- |
| Codex | `response_item/message`, role user | `MessageEvent{role:"user"}` |
| Codex | `response_item/message`, role assistant, `output_text` blocks | `MessageEvent{role:"assistant"}` |
| Codex | `response_item/function_call` | `ToolEvent{id: call_id, input: arguments verbatim}` |
| Codex | `response_item/function_call_output` | fills `ToolEvent.result` |
| Codex | `response_item/reasoning` | **nothing** (see above) |
| Grok | `user`, text blocks | `MessageEvent{role:"user"}` |
| Grok | `assistant.content` | `MessageEvent{role:"assistant"}` |
| Grok | `assistant.tool_calls[]` | `ToolEvent{id: tool_calls[].id, input: arguments verbatim}` |
| Grok | `tool_result` | fills `ToolEvent.result` |
| Grok | `reasoning.summary[].text` | `ThinkingEvent` |
| Pi | `message` / `user` | `MessageEvent{role:"user"}` |
| Pi | `message` / `assistant`, text blocks | `MessageEvent{role:"assistant"}` |
| Pi | `message` / `assistant`, thinking blocks | `ThinkingEvent` |
| Pi | `message` / `assistant`, `toolCall` blocks | `ToolEvent{id: block.id}` |
| Pi | `message` / `toolResult` | fills `ToolEvent.result`, `isError` from the record |

Every adapter is total in the sense `claude.ts` defines: the transcript is a file another program is writing while the app reads it, so a half-written record, an unknown block type, a field of the wrong type or a record written twice is **expected input**. Nothing throws, for any input, including a container that is not an array.

`sidechain` is `false` on every event of all three: none of the three records a subagent flag the way Claude's `isSidechain` does.

## Transcript paths

A **new** session started from the app is unrenderable unless its transcript path can be computed before the rail has scanned the file. Today `session-launcher.tsx` calls `claudeTranscriptPath` unconditionally. That becomes `transcriptPathFor(agent, ...)`:

| Agent | Path | Why |
| --- | --- | --- |
| Claude | `~/.claude/projects/<cwd slug>/<id>.jsonl` | Already implemented and measured |
| Grok | `~/.grok/sessions/<percent-encoded cwd>/<id>/chat_history.jsonl` | `--session-id` measured working on Grok 1.0.25 |
| Codex | `null` | Does not accept `--session-id`; the CLI picks its own id |
| Pi | `null` | Same |

`null` here means *the path is not knowable at launch*, which is a different fact from *there is no conversation*, and the chat view already says so. The launcher's new session therefore opens on the terminal for Codex and Pi and gains its chat view when the rail next scans. `AgentKind::may_accept_session_id` in `crates/faragent-core/src/agents.rs` is the single source of that distinction, and its tests already pin all four answers.

## Pi cwd resolution (existing defect)

`crates/faragent-remote/src/remote.rs` derives the Pi `cwd_hint` as the first path segment under `~/.pi/agent/sessions`, which for the real layout is `--Users-me-code-app--` — wrapper dashes included — while `sessions.rs` hands that hint to `percent_decode`, which is the Grok rule and leaves it unchanged. The row's cwd is wrong.

The fix prefers the header over the directory name: Pi's `SessionHeader` carries `cwd` verbatim and `row_from_file` already reads the file's prefix into `jsonl_meta`, whose result it consults before the hint. Whether that suffices is settled by measurement against a real Pi session, not assumed.

## Unverified shapes

Where a shape could not be measured, it is researched in the vendor's own documentation or source before being written, and it is marked `unverified` at the field and in the fixture rather than guessed at:

| Gap | Source |
| --- | --- |
| Pi, entirely | The installed package's `docs/session-format.md`, then a real session |
| Grok `tool_result` error signal | Grok's bundled docs; the `vendor/` and `bundled/` trees under `~/.grok` |
| Codex `function_call_output` error signal | The `openai/codex` protocol and rollout type definitions |

What cannot be established falls back to the conservative value (`isError: false`) with the same `unverified` marking. This mirrors the `synthesised` marker the Claude adapter's tests already use.

## Surfaces

The adapters are pure functions over parsed records, exercised by `node --test` — the repo has decided against React renderer tests, which is why the interesting logic stays out of `use-transcript.ts`. End-to-end proof runs through the mocked helper channel (`lib/mock/channel.ts`) and, for a final check, against a real remote.

## Out of scope

Windows remotes (the framed helper channel is POSIX-only, so no chat view exists there for any agent), a chat view for an agent whose transcript cannot be read, rendering Codex reasoning that is only ever encrypted, and back-filling a Codex or Pi new session's path by scanning for the CLI's chosen id.

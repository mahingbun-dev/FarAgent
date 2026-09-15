/**
 * One line for a tool call, and one line for a run of them.
 *
 * A conversation is mostly tool calls, and drawn at full size they bury the
 * prose. Both Claude Code Desktop and this app's panel answer the same way:
 * say what happened in a sentence, and let the reader open it if they want the
 * bytes. This module is that sentence.
 *
 * ## Why the labels are translated here, not in the components
 *
 * A summary like "ran 2 commands" is a sentence with a count in it, and the app
 * is bilingual: `README.md` is not the only thing an English reader sees, so
 * the same call has to read "执行了 2 条命令" on the other table. Handing the
 * summariser a `t` function keeps this file pure — `node --test` drives it with
 * `translate("en", …)`, which is the real table, so a test asserts the actual
 * sentence a user reads rather than a stub's echo.
 *
 * ## Counts are of *things*, not of calls
 *
 * Three `Read` calls for the same file say "read one file", not "read 3 files":
 * the reader is being told what the agent did to the workspace, and reading one
 * file three times is one file read. A call whose path cannot be read has no
 * thing to contribute, so it is counted on its own — which never understates
 * what happened, and is the only honest thing left when the input is a shape
 * this model does not know.
 *
 * ## Plurals
 *
 * English has no plural rule these keys can express — the same problem
 * `git.ahead` already records in `lib/i18n.ts` — so every countable clause has
 * an explicit `…One` spelling. `1 files` is the string a count-only table would
 * print, and it is the kind of thing that makes a polished surface look
 * unfinished.
 */
import type { ToolEvent } from "./events.ts";
import { commandOf, filePathOf, searchQueryOf, webTargetOf } from "./tool-input.ts";

/** `translate` bound to a language: what every string below is fetched through. */
export type Messages = (key: string, params?: Record<string, string | number>) => string;

/** What a tool call does, as far as a one-line summary is concerned. */
export type ToolKind =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "search"
  | "fetch"
  | "webSearch"
  | "agent"
  | "todo"
  | "other";

/**
 * Tool names, by what they do.
 *
 * The names are the ones the S0 spike measured plus the obvious spellings other
 * CLIs use; an unrecognised name is `other` and still gets a row, which is what
 * keeps a new tool from being silently invisible. Matching is exact rather than
 * by substring: `Read` and `NotebookRead` are different enough to be listed,
 * and a substring rule would put `unreadable` and `Read` in the same bucket.
 */
const KIND_BY_NAME: Record<string, ToolKind> = {
  read: "read",
  Read: "read",
  ReadFile: "read",
  read_file: "read",
  NotebookRead: "read",
  view: "read",
  write: "write",
  Write: "write",
  WriteFile: "write",
  write_file: "write",
  create_file: "write",
  NotebookWrite: "write",
  edit: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  StrReplace: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  apply_patch: "edit",
  ApplyPatch: "edit",
  bash: "bash",
  Bash: "bash",
  BashOutput: "bash",
  Shell: "bash",
  shell: "bash",
  run_command: "bash",
  RunCommand: "bash",
  ExecuteCommand: "bash",
  exec: "bash",
  Glob: "search",
  Grep: "search",
  Search: "search",
  Find: "search",
  List: "search",
  LS: "search",
  list_directory: "search",
  WebFetch: "fetch",
  Fetch: "fetch",
  fetch: "fetch",
  WebSearch: "webSearch",
  Task: "agent",
  Agent: "agent",
  TaskCreate: "todo",
  TodoWrite: "todo",
  TodoRead: "todo",
  update_plan: "todo",
};

/** What a call does, by name. An unknown name is `other`, never a miss. */
export function toolKind(name: string): ToolKind {
  return KIND_BY_NAME[name] ?? "other";
}

/** The label a single call gets when its own kind cannot name one. */
function nameFallback(event: ToolEvent, t: Messages): string {
  return t("chat.tool.other", { name: event.name });
}

/**
 * One tool call as a single line: "Read src/lib/lease.ts", "Ran `npm test`".
 *
 * The placeholders are filled with a stand-in when the field is missing
 * (`a file`, `a command`), so the sentence stays grammatical for a call whose
 * input this model did not recognise — which is the normal case for a tool the
 * agent's CLI added after this file was written.
 */
export function toolLabel(event: ToolEvent, t: Messages): string {
  const input = event.input;
  switch (toolKind(event.name)) {
    case "read":
      return t("chat.tool.read", { path: filePathOf(input) ?? t("chat.tool.someFile") });
    case "write":
      return t("chat.tool.write", { path: filePathOf(input) ?? t("chat.tool.someFile") });
    case "edit":
      return t("chat.tool.edit", { path: filePathOf(input) ?? t("chat.tool.someFile") });
    case "bash":
      return t("chat.tool.bash", {
        command: commandOf(input) ?? t("chat.tool.someCommand"),
      });
    case "search":
      return t("chat.tool.search", {
        query: searchQueryOf(input) ?? t("chat.tool.something"),
      });
    case "fetch":
      return t("chat.tool.fetch", {
        url: webTargetOf(input) ?? t("chat.tool.somePage"),
      });
    case "webSearch":
      return t("chat.tool.webSearch", {
        query: webTargetOf(input) ?? t("chat.tool.something"),
      });
    case "agent":
      return t("chat.tool.agent");
    case "todo":
      return t("chat.tool.todo");
    default:
      return nameFallback(event, t);
  }
}

/** The clause key a kind contributes to a run summary: a count, or a constant. */
const RUN_KEYS: Record<ToolKind, { many: string; one: string }> = {
  read: { many: "chat.run.read", one: "chat.run.readOne" },
  write: { many: "chat.run.write", one: "chat.run.writeOne" },
  edit: { many: "chat.run.edit", one: "chat.run.editOne" },
  bash: { many: "chat.run.bash", one: "chat.run.bashOne" },
  search: { many: "chat.run.search", one: "chat.run.searchOne" },
  fetch: { many: "chat.run.fetch", one: "chat.run.fetchOne" },
  webSearch: { many: "chat.run.webSearch", one: "chat.run.webSearchOne" },
  agent: { many: "chat.run.agent", one: "chat.run.agentOne" },
  // A todo list is one list however many writes touched it; there is no count
  // to pluralise, and the same key serves both spellings.
  todo: { many: "chat.run.todo", one: "chat.run.todo" },
  other: { many: "chat.run.other", one: "chat.run.otherOne" },
};

/**
 * What a call adds to a run's tally.
 *
 * For the file-shaped kinds this is the path, so a run's count is *things*;
 * `null` means the call's path could not be read, and the caller falls back to
 * counting the call itself.
 */
function tallyKey(event: ToolEvent): string | null {
  switch (toolKind(event.name)) {
    case "read":
    case "write":
    case "edit":
      return filePathOf(event.input);
    default:
      return null;
  }
}

/**
 * Upper-case the first character of a summary's first clause.
 *
 * `tool-call.ts` builds every clause lower-case so that any of them can be the
 * second one in a list ("ran an agent, read 2 files"). The sentence is started
 * by the caller. A Chinese clause begins with a character that has no case, and
 * `toUpperCase` leaves it alone — so this is safe on both tables, which is why
 * it is not conditioned on the language.
 */
function capitalise(text: string): string {
  if (text === "") return text;
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * A run of tool calls as one line: "Ran an agent, read 2 files, ran 2 commands".
 *
 * Clauses appear in the order the kinds were *first* used, which is the order
 * the reader watched them happen, and each kind is counted once across the
 * whole run — so a burst of twelve calls reads as a sentence rather than as
 * twelve. An empty run is an empty string; the renderer never draws a row for
 * it.
 */
export function summarizeToolRun(events: readonly ToolEvent[], t: Messages): string {
  if (events.length === 0) return "";

  const order: ToolKind[] = [];
  const calls = new Map<ToolKind, number>();
  const named = new Map<ToolKind, number>();
  const things = new Map<ToolKind, Set<string>>();

  for (const event of events) {
    const kind = toolKind(event.name);
    if (!calls.has(kind)) {
      order.push(kind);
      calls.set(kind, 0);
      named.set(kind, 0);
    }
    calls.set(kind, (calls.get(kind) ?? 0) + 1);
    const key = tallyKey(event);
    if (key === null) continue;
    named.set(kind, (named.get(kind) ?? 0) + 1);
    const set = things.get(kind) ?? new Set<string>();
    set.add(key);
    things.set(kind, set);
  }

  const clauses = order.map((kind) => {
    // Distinct things, plus the calls that had no thing to name: three reads of
    // one file and one read of an unreadable file together say "read 2 files".
    const total = calls.get(kind) ?? 0;
    const count = (things.get(kind)?.size ?? 0) + (total - (named.get(kind) ?? 0));
    const keys = RUN_KEYS[kind];
    return t(count === 1 ? keys.one : keys.many, { count });
  });

  // Every clause is lower-case except, on the way out, the first — and the
  // separator is the table's own, because a Chinese sentence joins with a
  // full-width comma and an English one with a space after the comma.
  return capitalise(clauses.join(t("chat.run.sep")));
}

/**
 * The one line a tool row shows: the call itself when there is one, the run's
 * sentence when there are several.
 *
 * A single call gets its own label rather than a summary because "Read
 * src/lib/lease.ts" says more than "Read one file" — the file is the thing the
 * reader wants to know.
 */
export function toolRunLine(events: readonly ToolEvent[], t: Messages): string {
  if (events.length === 1) return toolLabel(events[0], t);
  return summarizeToolRun(events, t);
}

/**
 * The composer: a second way to say something to a session.
 *
 * Everything here writes through the tab's **one** attach (`lib/tab-attach.ts`),
 * which is the same door the terminal's keystrokes go through. The remote
 * agent's TUI is still the receiver and still the thing that keeps the session
 * alive; this pane does not speak to it in any other language than the one a
 * keyboard speaks. See `lib/chat/composer.ts` for that contract's details (the
 * Enter/Shift+Enter rule, the bytes a message becomes) and `lib/chat/echo.ts`
 * for the optimistic echo, which is the reason pressing Enter shows anything at
 * all before the agent has written the record.
 *
 * ## What this does not do
 *
 * - **It does not switch the permission mode.** The mode is read
 *   (`get_full_permissions`) and shown, because a reader about to type into an
 *   agent that will act without asking should be able to see that. Changing it
 *   decides how a session *starts* and belongs with the session launcher, not
 *   here.
 * - **It does not pretend to know what the remote accepts.** The slash table is
 *   static and offered as completion only; anything typed is sent.
 * - **It does not replace the terminal.** A permission prompt and a
 *   slash-command UI are drawn by the remote's TUI and have no transcript to be
 *   read from — the switch back to the terminal is still the only way to answer
 *   them, which is why that view is never unmounted.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { composerAction, commandsFor, slashMatches } from "@/lib/chat/composer";
import type { AgentKind } from "@/lib/agents";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useT } from "@/state";

/** How tall the field grows before it scrolls instead. */
const MAX_FIELD_HEIGHT = 160;

export function Composer({
  agent,
  onSend,
}: {
  agent: AgentKind;
  /** Hand the message to the conversation, which writes it and echoes it. */
  onSend: (text: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [highlight, setHighlight] = useState(0);
  /** The value whose menu the reader dismissed with Escape; the menu stays shut until it changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [fullPerms, setFullPerms] = useState<boolean | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // Ids for the completion list, so the field can point at it. Focus never
  // leaves the field while the menu is open, so the relationship has to be said
  // in ARIA rather than carried by focus.
  const menu = useId();
  const listId = `${menu}-list`;
  const labelId = `${menu}-label`;
  const optionId = (index: number) => `${menu}-option-${index}`;

  const commands = useMemo(() => commandsFor(agent), [agent]);
  const suggestions = useMemo(() => slashMatches(value, commands), [value, commands]);
  const menuOpen = suggestions.length > 0 && dismissed !== value;
  // Clamped: the highlight is reset on the next effect, so for one render after
  // the list shrinks it can point past the end.
  const activeIndex = suggestions.length === 0 ? -1 : Math.min(highlight, suggestions.length - 1);
  const active = activeIndex === -1 ? null : suggestions[activeIndex];

  /**
   * The permission mode, as it is. Read once — it is a setting of how sessions
   * start, so it does not change under this pane. An unknown answer shows
   * nothing rather than a guess: claiming "asks for permission" over an agent
   * that will not ask is exactly the kind of quiet lie this pane exists to avoid.
   */
  useEffect(() => {
    let alive = true;
    ipc
      .getFullPermissions()
      .then((on) => {
        if (alive) setFullPerms(on);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Grow with the message, up to a cap. Reset first so a deletion shrinks it
  // too — `scrollHeight` never reports less than the height already set.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_HEIGHT)}px`;
  }, [value]);

  // A new prefix is a new list, so the old highlight means nothing.
  useEffect(() => setHighlight(0), [value]);

  const send = () => {
    if (value.trim() === "") return;
    onSend(value);
    setValue("");
    field.current?.focus();
  };

  const accept = (command: string) => {
    setValue(command);
    // The menu closes because the field now equals the value it was dismissed
    // at. Appending a space to close it — the obvious trick — would put a byte
    // in the message that the transcript's record will never carry, which is a
    // guaranteed duplicate on screen. The reader types their own space when the
    // command takes an argument.
    setDismissed(command);
    field.current?.focus();
  };

  return (
    <div className="shrink-0 border-t border-border px-2 pb-2 pt-1.5">
      {menuOpen ? (
        <div className="mx-auto mb-1 w-full max-w-content overflow-hidden rounded-md border border-border bg-surface-raised">
          {/*
            The heading is a *sibling* of the listbox, not a child of it: a
            `role="listbox"` may contain nothing but options, and a heading
            inside it is a structural violation the field would then be pointing
            at. It labels the list from outside instead.
          */}
          <p
            id={labelId}
            className="border-b border-border px-2 py-1 text-micro text-muted-foreground"
          >
            {t("chat.slashCommands")}
          </p>
          <div id={listId} role="listbox" aria-labelledby={labelId}>
            {suggestions.map((command, index) => (
              <button
                key={command}
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={index === highlight}
                // Mouse down, not click: the field must not lose focus to the
                // button before the value is set, or the reader's next keystroke
                // lands nowhere.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(command);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "block w-full px-2 py-1 text-left font-mono text-xs transition-colors",
                  index === highlight ? "bg-surface-selected" : "hover:bg-surface-hover",
                )}
              >
                {command}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/*
        The menu opening, and the highlighted command, said out loud. A reader
        who cannot see it is not told by `aria-activedescendant` alone — the
        field keeps focus, so nothing is re-announced until the value changes.
        Empty when the menu is shut, so it is silent otherwise.
      */}
      <div role="status" aria-live="polite" className="sr-only">
        {menuOpen && active !== null
          ? t("chat.slashMenuStatus", { count: suggestions.length, command: active })
          : ""}
      </div>

      <div className="mx-auto flex w-full max-w-content items-end gap-2">
        <Textarea
          ref={field}
          rows={1}
          value={value}
          placeholder={t("chat.composerPlaceholder")}
          aria-label={t("chat.composerPlaceholder")}
          /*
            The field is what opens the list and what the arrow keys move
            through, so the relationship is stated here: `aria-haspopup` (a
            global attribute, so valid on a textbox), `aria-controls` pointing at
            the list only while it exists, and `aria-activedescendant` naming the
            highlighted option. Deliberately *not* `aria-expanded`: a textbox
            does not support it (ARIA's supported states for `textbox` list
            `aria-haspopup` and `aria-activedescendant`, not `aria-expanded`),
            so it would be a new violation rather than a fix — the open state is
            announced by the status line below instead.
          */
          aria-haspopup="listbox"
          aria-controls={menuOpen ? listId : undefined}
          aria-activedescendant={
            menuOpen && activeIndex !== -1 ? optionId(activeIndex) : undefined
          }
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            const action = composerAction({
              key: e.key,
              shiftKey: e.shiftKey,
              // Read off the native event: React's synthetic `KeyboardEvent` type
              // does not declare `isComposing`, and assuming `false` would submit
              // the Return that confirms an IME candidate.
              isComposing: e.nativeEvent.isComposing,
            });
            if (action === "send") {
              e.preventDefault();
              send();
              return;
            }
            // A newline is the field's own business: `preventDefault` is
            // deliberately not called.
            if (action === "newline") return;

            if (menuOpen && suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => (h + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                accept(suggestions[Math.min(highlight, suggestions.length - 1)]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(value);
                return;
              }
            }
          }}
          className="max-h-40 min-h-9 flex-1 py-2"
        />
        <Button
          size="icon"
          title={t("chat.composerSend")}
          aria-label={t("chat.composerSend")}
          disabled={value.trim() === ""}
          onClick={send}
        >
          <Send />
        </Button>
      </div>

      <div className="mx-auto mt-1 flex w-full max-w-content items-center gap-2 text-micro text-muted-foreground">
        <span>{t("chat.composerHint")}</span>
        {fullPerms === null ? null : (
          <span className="ml-auto shrink-0">
            {t(fullPerms ? "chat.permissionsFull" : "chat.permissionsAsk")}
          </span>
        )}
      </div>
    </div>
  );
}

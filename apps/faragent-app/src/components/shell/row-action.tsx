import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Whether these children carry a name of their own — text, or something whose
 * own accessible name is text (a nested element is not walked: a lucide icon has
 * no text in it, so `<X />` counts as nameless and `"Upgrade"` does not).
 */
function hasOwnText(children: ReactNode): boolean {
  if (typeof children === "string") return children.trim() !== "";
  if (typeof children === "number") return true;
  if (Array.isArray(children)) return children.some(hasOwnText);
  return false;
}

/**
 * A secondary click target inside a row.
 *
 * The host and agent switchers hang their per-row actions (cycle auth, sync
 * GitHub, upgrade, uninstall) off a `DropdownMenuItem`, which is already a
 * `<button>` — a real nested button would be invalid HTML and would swallow
 * the outer click in some browsers. This is a span wearing button semantics:
 * it stops propagation so the row's own action does not also fire, and it
 * answers Enter/Space so keyboard users are not locked out of it.
 *
 * ## What names the control
 *
 * It used to set `aria-label={title}` unconditionally, which gave the auth-mode
 * pill — its visible text is `[password]` — the *hint* as its accessible name
 * ("click to probe · click the tag to cycle auth"), so a screen reader never
 * heard what the control actually says. The name now comes from the children
 * when they carry text, and `title` stays what it always was: the tooltip, which
 * assistive tech reads as the *description* behind a name it did not supply.
 *
 * A control whose children are an icon and no text has no name of its own, so
 * there `title` still names it — `workspace-tabs.tsx`'s close button is the one
 * in this codebase, and it is not this file's to change. `label` overrides both.
 */
export function RowAction({
  children,
  onActivate,
  title,
  label,
  disabled,
  className,
}: {
  children: ReactNode;
  onActivate: () => void;
  title?: string;
  /** The accessible name, for a control whose children cannot supply one. */
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const activate = () => {
    if (!disabled) onActivate();
  };

  const stop = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
  };

  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={label ?? (hasOwnText(children) ? undefined : title)}
      title={title}
      onClick={(event) => {
        stop(event);
        activate();
      }}
      onKeyDown={(event) => {
        stop(event);
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-micro font-medium text-muted-foreground whitespace-nowrap transition-colors",
        "hover:bg-surface-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      {children}
    </span>
  );
}

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A secondary click target inside a row.
 *
 * The host and agent switchers hang their per-row actions (cycle auth, sync
 * GitHub, upgrade, uninstall) off a `DropdownMenuItem`, which is already a
 * `<button>` — a real nested button would be invalid HTML and would swallow
 * the outer click in some browsers. This is a span wearing button semantics:
 * it stops propagation so the row's own action does not also fire, and it
 * answers Enter/Space so keyboard users are not locked out of it.
 */
export function RowAction({
  children,
  onActivate,
  title,
  disabled,
  className,
}: {
  children: ReactNode;
  onActivate: () => void;
  title?: string;
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
      aria-label={title}
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

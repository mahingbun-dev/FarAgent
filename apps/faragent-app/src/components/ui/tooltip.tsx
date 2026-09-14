import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tooltip, themed by our tokens (see src/index.css).
 *
 * Pure CSS on purpose — hover/focus on the wrapper drives it, so there is no
 * state, no timer and nothing to clean up. The trade-off is that it is clipped
 * by an `overflow-hidden` ancestor and always renders above the trigger in the
 * stacking order of its own context.
 */
const SIDE_CLASS = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
} as const;

export interface TooltipProps {
  /** The tooltip body. Nothing renders when this is empty. */
  content?: React.ReactNode;
  side?: keyof typeof SIDE_CLASS;
  className?: string;
  children?: React.ReactNode;
}

export function Tooltip({
  content,
  side = "top",
  className,
  children,
}: TooltipProps) {
  const [id] = React.useState(
    () => `fg-tooltip-${Math.random().toString(36).slice(2, 8)}`,
  );

  if (!content) return <>{children}</>;

  const trigger = React.isValidElement(children)
    ? React.cloneElement(
        children as React.ReactElement<{ "aria-describedby"?: string }>,
        { "aria-describedby": id },
      )
    : children;

  return (
    <span className="group/tooltip relative inline-flex">
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 rounded-md border border-border bg-surface-raised px-2 py-1 text-micro whitespace-nowrap text-foreground shadow-md",
          "opacity-0 transition-opacity duration-fast",
          "group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100",
          SIDE_CLASS[side],
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}

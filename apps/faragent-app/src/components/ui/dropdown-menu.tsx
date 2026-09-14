import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Dropdown menu, themed by our tokens (see src/index.css).
 *
 * Deliberately dependency-free: the app has no component library and this is
 * the small slice of Radix's behaviour the shell actually needs — open/close,
 * click-outside, Escape, and arrow-key roving focus. The panel is positioned
 * against its trigger rather than portalled, so it inherits the trigger's
 * stacking context; keep menus out of `overflow-hidden` ancestors.
 */
type DropdownMenuContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerId: string;
  contentId: string;
  /** Mounted only while open; the trigger uses it to hand focus to the items. */
  contentRef: React.RefObject<HTMLDivElement | null>;
};

function menuItems(content: HTMLDivElement | null): HTMLElement[] {
  return Array.from(
    content?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    ) ?? [],
  );
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | null>(
  null,
);

function useDropdownMenu(component: string): DropdownMenuContextValue {
  const ctx = React.useContext(DropdownMenuContext);
  if (!ctx) throw new Error(`${component} must be used inside <DropdownMenu>`);
  return ctx;
}

export interface DropdownMenuProps {
  children?: React.ReactNode;
  /** Hooks the panel is positioned against; override for a block-level menu. */
  className?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function DropdownMenu({
  children,
  className,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
}: DropdownMenuProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const [ids] = React.useState(() => ({
    triggerId: `fg-menu-trigger-${Math.random().toString(36).slice(2, 8)}`,
    contentId: `fg-menu-content-${Math.random().toString(36).slice(2, 8)}`,
  }));
  const contentRef = React.useRef<HTMLDivElement>(null);

  const rootRef = React.useRef<HTMLDivElement>(null);
  const setOpen = React.useCallback(
    (next: boolean) => {
      setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);

  return (
    <DropdownMenuContext.Provider
      value={{
        open,
        setOpen,
        triggerId: ids.triggerId,
        contentId: ids.contentId,
        contentRef,
      }}
    >
      <div ref={rootRef} className={cn("relative inline-flex", className)}>
        {children}
      </div>
    </DropdownMenuContext.Provider>
  );
}

export function DropdownMenuTrigger({
  className,
  onClick,
  onKeyDown,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { open, setOpen, triggerId, contentId, contentRef } = useDropdownMenu(
    "DropdownMenuTrigger",
  );
  return (
    <button
      type="button"
      id={triggerId}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? contentId : undefined}
      data-state={open ? "open" : "closed"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !open) return;
        // Focus lives on the trigger while the menu is open (the panel is not
        // portalled and must not steal focus on a mouse click): hand it to the
        // items on the first arrow press.
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const all = menuItems(contentRef.current);
        if (all.length === 0) return;
        event.preventDefault();
        (event.key === "ArrowDown" ? all[0] : all[all.length - 1])?.focus();
      }}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md text-sm transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

const SIDE_CLASS = {
  bottom: "top-full mt-1",
  top: "bottom-full mb-1",
} as const;

const ALIGN_CLASS = {
  start: "left-0",
  end: "right-0",
  center: "left-1/2 -translate-x-1/2",
} as const;

export interface DropdownMenuContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  side?: keyof typeof SIDE_CLASS;
  align?: keyof typeof ALIGN_CLASS;
}

export function DropdownMenuContent({
  className,
  side = "bottom",
  align = "start",
  onKeyDown,
  ...props
}: DropdownMenuContentProps) {
  const { open, triggerId, contentId, contentRef } = useDropdownMenu(
    "DropdownMenuContent",
  );

  if (!open) return null;

  return (
    <div
      ref={contentRef}
      id={contentId}
      role="menu"
      aria-labelledby={triggerId}
      data-state="open"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        const all = menuItems(contentRef.current);
        if (all.length === 0) return;
        const index = all.indexOf(document.activeElement as HTMLElement);
        if (event.key === "ArrowDown") {
          event.preventDefault();
          all[index === -1 || index + 1 >= all.length ? 0 : index + 1]?.focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          all[index <= 0 ? all.length - 1 : index - 1]?.focus();
        } else if (event.key === "Home") {
          event.preventDefault();
          all[0]?.focus();
        } else if (event.key === "End") {
          event.preventDefault();
          all[all.length - 1]?.focus();
        }
      }}
      className={cn(
        "animate-pop-in absolute z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-surface-raised p-1 text-foreground shadow-md outline-none",
        SIDE_CLASS[side],
        ALIGN_CLASS[align],
        className,
      )}
      {...props}
    />
  );
}

export interface DropdownMenuItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSelect"> {
  /** Called on activation; the menu closes afterwards. */
  onSelect?: () => void;
}

export function DropdownMenuItem({
  className,
  onSelect,
  onClick,
  disabled,
  ...props
}: DropdownMenuItemProps) {
  const { setOpen } = useDropdownMenu("DropdownMenuItem");
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      disabled={disabled}
      tabIndex={-1}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        onSelect?.();
        setOpen(false);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors outline-none",
        "hover:bg-surface-hover focus-visible:bg-surface-hover",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("px-2 py-1 text-micro text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

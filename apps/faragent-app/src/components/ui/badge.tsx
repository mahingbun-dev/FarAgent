import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Small status/label pill, themed by our tokens (see src/index.css).
 * Tinted variants use the token at low alpha, so they stay legible on both the
 * canvas and a raised card.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-medium whitespace-nowrap leading-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        primary: "border-transparent bg-primary/15 text-primary",
        link: "border-transparent bg-link/15 text-link",
        success: "border-transparent bg-success/15 text-success",
        warning: "border-transparent bg-warning/15 text-warning",
        danger: "border-transparent bg-danger/15 text-danger",
        live: "border-transparent bg-mark-live/15 text-mark-live",
        running: "border-transparent bg-mark-running/15 text-mark-running",
        idle: "border-transparent bg-mark-idle/20 text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props} />
  );
}

export { badgeVariants };

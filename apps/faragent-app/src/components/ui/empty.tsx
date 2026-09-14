import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

/**
 * The two "there is nothing here yet" shapes the app keeps reaching for,
 * extracted from the old page shell so every region can use the same ones.
 */

/** An inline "working on it" row. */
export function Spinner({ label }: { label?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

/** The dashed "nothing here" box. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

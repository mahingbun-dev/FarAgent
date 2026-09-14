import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tabs, themed by our tokens (see src/index.css). Two looks are needed: the
 * segmented control (`list="segmented"`, the reference's Cowork|Code pill) and
 * an underline list for panel headers (`list="underline"`).
 *
 * Uncontrolled by default; pass `value` + `onValueChange` to drive it.
 */
type TabsContextValue = {
  value: string;
  setValue: (value: string) => void;
  list: "segmented" | "underline";
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`${component} must be used inside <Tabs>`);
  return ctx;
}

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  list?: "segmented" | "underline";
}

export function Tabs({
  className,
  value: valueProp,
  defaultValue = "",
  onValueChange,
  list = "segmented",
  ...props
}: TabsProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const value = valueProp ?? uncontrolled;
  const setValue = React.useCallback(
    (next: string) => {
      setUncontrolled(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  return (
    <TabsContext.Provider value={{ value, setValue, list }}>
      <div className={cn("flex min-h-0 flex-col", className)} {...props} />
    </TabsContext.Provider>
  );
}

export function TabsList({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { list } = useTabs("TabsList");
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center",
        list === "segmented"
          ? // hugs its triggers even inside a column flex parent
            "w-fit gap-0.5 rounded-lg bg-muted p-0.5"
          : "gap-3 border-b border-border",
        className,
      )}
      {...props}
    />
  );
}

export interface TabsTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({
  className,
  value,
  ...props
}: TabsTriggerProps) {
  const { value: current, setValue, list } = useTabs("TabsTrigger");
  const active = current === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-state={active ? "active" : "inactive"}
      onClick={() => setValue(value)}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        list === "segmented"
          ? cn(
              "h-7 rounded-md px-2.5",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )
          : cn(
              "-mb-px h-8 border-b-2 px-0.5",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ),
        className,
      )}
      {...props}
    />
  );
}

export interface TabsContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({
  className,
  value,
  ...props
}: TabsContentProps) {
  const { value: current } = useTabs("TabsContent");
  if (current !== value) return null;
  return (
    <div
      role="tabpanel"
      className={cn("min-h-0 flex-1 outline-none", className)}
      {...props}
    />
  );
}

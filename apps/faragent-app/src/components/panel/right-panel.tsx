/**
 * The right-hand panel: one tab shell, three read-only views.
 *
 * Four things this file owns, and nothing else does:
 *
 * 1. **The width.** Draggable by its left edge, clamped to `PANEL` (never a
 *    literal pixel figure), and snapped shut when released below
 *    `PANEL.snapClose` — the one gesture that collapses the panel. The width
 *    lives in the tab's `panel` state and is written through `setPanel`, so it
 *    survives a tab switch; during a drag it is held in local state instead,
 *    because a store write per pointermove would re-render every mounted
 *    terminal on the way past.
 * 2. **The root.** The tree, the changes list and the git view are all rooted at
 *    the session's cwd (`tab.cwd`), which is what makes the panel show the code
 *    the session is actually working in. A tab with no cwd — a login or install
 *    tab — falls back to the host's home once the probe answers. The root is
 *    shown and is typeable, and ".." from the tree walks up.
 * 3. **The connection's state.** Connecting, failed and closed each get their
 *    own sentence instead of a spinner that never resolves.
 * 4. **Which tab is open**, which is `panel.tab` in the store.
 *
 * Everything below the header is read-only; there is no save, no stage, no
 * commit and no branch switch anywhere under this component.
 */
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, FolderTree, PanelRightClose, Pencil, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, Spinner } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChangesPanel } from "@/components/panel/changes-panel";
import { FilePreview } from "@/components/panel/file-preview";
import { FileTree } from "@/components/panel/file-tree";
import { GitPanel } from "@/components/panel/git-panel";
import { PanelHelperProvider, usePanelHelper } from "@/components/panel/helper-context";
import { PanelWatch } from "@/components/panel/panel-watch";
import { useProbe } from "@/components/shell/use-shell-data";
import { useQueryClient } from "@tanstack/react-query";
import { PANEL } from "@/design";
import { helperErrorText } from "@/lib/helper";
import { normalizePath } from "@/lib/panel/paths";
import { cn } from "@/lib/utils";
import { useStore, useT, type PanelState, type Tab } from "@/state";

/** Arrow-key resize step, for the handle's keyboard path. */
const RESIZE_STEP = 24;

function clampWidth(width: number): number {
  return Math.max(PANEL.minWidth, Math.min(PANEL.maxWidth, width));
}

export function RightPanel({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const t = useT();
  const setPanel = useStore((s) => s.setPanel);
  const panel = tab.panel;

  // The probe is only needed for the fallback root, and only for a tab whose
  // session has no cwd of its own.
  const probe = useProbe(tab.cwd === null ? tab.host : null);
  const home = probe.data?.home ?? "";

  /** A root the user typed. `null` means "follow the session". */
  const [override, setOverride] = useState<string | null>(null);
  const root = override ?? tab.cwd ?? home;

  const [dragging, setDragging] = useState<number | null>(null);
  const width = dragging ?? panel.width;

  const [selected, setSelected] = useState<string | null>(null);
  const [editingRoot, setEditingRoot] = useState(false);
  const [draft, setDraft] = useState("");
  const queryClient = useQueryClient();

  const applyWidth = (next: number) => {
    if (next <= PANEL.snapClose) {
      // Collapsed by gesture. The stored width is left alone so re-opening
      // restores the size the user had before they dragged it shut.
      setPanel(tab.id, { open: false });
      return;
    }
    setPanel(tab.id, { width: clampWidth(next) });
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.width;
    setDragging(startWidth);

    const move = (ev: PointerEvent) => {
      const next = startWidth + (startX - ev.clientX);
      setDragging(Math.max(0, Math.min(PANEL.maxWidth, next)));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
      applyWidth(startWidth + (startX - ev.clientX));
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const refresh = () => {
    // Everything the panel has read for this connection, including the tree and
    // the log pages already fetched.
    void queryClient.invalidateQueries({ queryKey: ["panel"] });
  };

  const commitRoot = () => {
    const next = normalizePath(draft.trim() || root);
    setOverride(next);
    setSelected(null);
    setEditingRoot(false);
  };

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-sidebar-border bg-background"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.resize")}
        title={t("panel.resize")}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") applyWidth(width + RESIZE_STEP);
          if (event.key === "ArrowRight") applyWidth(width - RESIZE_STEP);
        }}
        className={cn(
          "absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize",
          "hover:bg-link/40 focus-visible:bg-link/40 focus-visible:outline-none",
          dragging !== null && "bg-link/40",
        )}
      />

      <PanelHelperProvider host={tab.host}>
        {/*
          The push channel, mounted once for the panel and rendering nothing.
          It sits inside the provider because it needs the connection, and
          outside the tabs because the watch is on the panel's root rather than
          on any one tab — see the file's own note on why a tab switch does not
          drop it.
        */}
        <PanelWatch root={root} />
        <Tabs
          value={panel.tab}
          onValueChange={(value) =>
            setPanel(tab.id, { tab: value as PanelState["tab"] })
          }
          className="min-h-0 flex-1"
        >
          <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
            <TabsList className="mr-auto">
              <TabsTrigger value="files">{t("panel.files")}</TabsTrigger>
              <TabsTrigger value="changes">{t("panel.changes")}</TabsTrigger>
              <TabsTrigger value="git">{t("panel.git")}</TabsTrigger>
            </TabsList>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title={t("panel.refresh")}
              aria-label={t("panel.refresh")}
              onClick={refresh}
            >
              <RefreshCw />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title={t("panel.collapse")}
              aria-label={t("panel.collapse")}
              aria-expanded
              onClick={onClose}
            >
              <PanelRightClose />
            </Button>
          </header>

          <RootBar
            root={root}
            editing={editingRoot}
            draft={draft}
            onDraft={setDraft}
            onStart={() => {
              setDraft(root);
              setEditingRoot(true);
            }}
            onCommit={commitRoot}
            onCancel={() => setEditingRoot(false)}
          />

          <Notice />

          <PanelBody
            root={root}
            selected={selected}
            onSelect={setSelected}
            onRootChange={(next) => {
              setOverride(next);
              setSelected(null);
              setEditingRoot(false);
            }}
          />
        </Tabs>
      </PanelHelperProvider>
    </aside>
  );
}

/**
 * The root the three views are reading, and the way to change it. Editable
 * because a session's cwd is a *starting point*: the reason to open the panel is
 * usually to look somewhere the session is not.
 */
function RootBar({
  root,
  editing,
  draft,
  onDraft,
  onStart,
  onCommit,
  onCancel,
}: {
  root: string;
  editing: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onStart: () => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-2">
      <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {editing ? (
        <>
          <Input
            value={draft}
            autoFocus
            spellCheck={false}
            aria-label={t("panel.rootSwitch")}
            className="h-6 min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommit();
              if (event.key === "Escape") onCancel();
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t("panel.rootApply")}
            aria-label={t("panel.rootApply")}
            onClick={onCommit}
          >
            <Check />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={onCancel}
          >
            <X />
          </Button>
        </>
      ) : (
        <button
          type="button"
          title={root}
          onClick={onStart}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-surface-hover"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{root}</span>
          <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}

/** The fallback notice, if the remote is not running the native helper. */
function Notice() {
  const { notice } = usePanelHelper();
  if (!notice) return null;
  return (
    <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-warning">
      {notice}
    </p>
  );
}
function PanelBody({
  root,
  selected,
  onSelect,
  onRootChange,
}: {
  root: string;
  selected: string | null;
  onSelect: (path: string) => void;
  onRootChange: (path: string) => void;
}) {
  const t = useT();
  const { status, error, retry } = usePanelHelper();
  const lang = useStore((s) => s.lang);

  if (status === "connecting") {
    return (
      <div className="p-2">
        <Spinner label={t("panel.connecting")} />
      </div>
    );
  }

  if (status === "error" || status === "closed") {
    return (
      <div className="p-2">
        <Empty>
          <p className="text-foreground">
            {status === "closed" ? t("panel.closed") : t("panel.error")}
          </p>
          <p className="mt-1 break-all text-xs">
            {status === "closed"
              ? t("panel.closedHint")
              : helperErrorText(error, lang)}
          </p>
          <Button size="sm" variant="outline" className="mt-3" onClick={retry}>
            {t("common.retry")}
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <>
      <TabsContent value="files" className="flex flex-col">
        {/*
          `flex min-h-0 flex-col overflow-hidden`, not a plain block: the tree
          inside is a `flex-1 overflow-auto` child, and without a flex parent
          with a bounded height its `flex-1` is inert and the list grows past
          its half and paints over the preview below it.
        */}
        <div
          className={cn(
            "flex min-h-0 flex-col overflow-hidden",
            selected ? "flex-[45]" : "flex-1",
          )}
        >
          <FileTree
            root={root}
            selected={selected}
            onSelect={onSelect}
            onRootChange={onRootChange}
          />
        </div>
        {selected ? (
          <div className="flex min-h-0 flex-[55] flex-col overflow-hidden border-t border-border">
            <FilePreview path={selected} />
          </div>
        ) : (
          <p className="shrink-0 border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
            {t("file.empty")}
          </p>
        )}
      </TabsContent>

      <TabsContent value="changes" className="flex flex-col">
        <ChangesPanel root={root} />
      </TabsContent>

      <TabsContent value="git" className="flex flex-col">
        <GitPanel root={root} />
      </TabsContent>
    </>
  );
}

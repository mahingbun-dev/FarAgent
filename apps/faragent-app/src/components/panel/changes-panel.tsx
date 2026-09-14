/**
 * The Changes tab: the working tree, grouped by which side of the index each
 * file's change is on.
 *
 * Read-only throughout — there is no stage, no unstage and no discard, and no
 * code path to `git add`: the protocol this panel speaks has no write op, so a
 * button here could not be built even by mistake.
 *
 * Patches are always fetched per file, never for the whole repository. That is
 * the same rule the remote enforces with `files_only` (its 6 MiB patch budget),
 * just applied one step earlier: a 600-file change set costs one `git.status`
 * and one `git diff` per file the user actually opens, instead of a patch the
 * remote would have to cut off.
 */
import { Empty, Spinner } from "@/components/ui/empty";
import { ChangeRow } from "@/components/panel/changed-file-row";
import {
  usePanelDiscover,
  usePanelGitStatus,
} from "@/components/panel/queries";
import { usePanelHelper } from "@/components/panel/helper-context";
import {
  decodeText,
  helperErrorText,
  HelperError,
  type GitStatusFile,
} from "@/lib/helper";
import { shouldListOnly } from "@/lib/panel/diff";
import { useStore, useT } from "@/state";

export function ChangesPanel({ root }: { root: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const { connection } = usePanelHelper();
  const discover = usePanelDiscover(connection, root);

  if (!connection || discover.isLoading) return <Spinner label={t("file.loading")} />;

  if (discover.error) {
    const code = HelperError.from(discover.error).errorCode;
    return (
      <div className="p-2">
        <Empty>
          {code === "not_a_repo"
            ? t("changes.notRepo")
            : t("git.error", { message: helperErrorText(discover.error, lang) })}
        </Empty>
      </div>
    );
  }

  if (!discover.data) return <Spinner label={t("file.loading")} />;

  return <ChangesBody repo={decodeText(discover.data.root)} />;
}

function ChangesBody({ repo }: { repo: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const { connection, capabilities } = usePanelHelper();
  const status = usePanelGitStatus(connection, repo);

  if (status.isLoading) return <Spinner label={t("file.loading")} />;

  if (status.error) {
    return (
      <div className="p-2">
        <Empty>{t("git.error", { message: helperErrorText(status.error, lang) })}</Empty>
      </div>
    );
  }

  const files = status.data?.files ?? [];
  const truncated = status.data?.truncated ?? false;

  if (files.length === 0) {
    return (
      <div className="p-2">
        <Empty>{t("changes.clean")}</Empty>
      </div>
    );
  }

  // The panel fetches one file at a time, so it never renders a repository-wide
  // patch; the cap says so out loud instead of leaving the reader wondering why
  // the diffs are not already open.
  const listOnly = shouldListOnly({
    filesOnly: false,
    truncated,
    fileCount: files.length,
  });

  const staged = files.filter((file) => file.staged);
  const unstaged = files.filter((file) => !file.staged);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <p className="border-b border-border px-2 py-1.5 text-xs text-muted-foreground">
        {t("changes.count", { count: files.length })}
        {" · "}
        {t("git.branch")} {status.data?.branch ? decodeText(status.data.branch) : "—"}
      </p>
      {/*
        Three reasons the diffs are not open, and the first is the strongest: a
        fallback remote has no `git.diff` at all, so no row can expand and the
        reason is about the remote rather than about this change set. Its rows
        render unexpandable (`changed-file-row.tsx`), which without this sentence
        would look like a list that simply does nothing when clicked.
      */}
      {!capabilities.diff ? (
        <p className="border-b border-border px-2 py-1.5 text-xs text-warning">
          {t("changes.noDiffOp")}
        </p>
      ) : listOnly ? (
        <p className="border-b border-border px-2 py-1.5 text-xs text-warning">
          {truncated
            ? t("changes.truncated", { count: files.length })
            : t("changes.listOnly")}
        </p>
      ) : null}
      {staged.length > 0 ? (
        <Group title={t("changes.staged")} files={staged} repo={repo} />
      ) : null}
      {unstaged.length > 0 ? (
        <Group title={t("changes.unstaged")} files={unstaged} repo={repo} />
      ) : null}
    </div>
  );
}

function Group({
  title,
  files,
  repo,
}: {
  title: string;
  files: GitStatusFile[];
  repo: string;
}) {
  return (
    <div>
      <p className="sticky top-0 bg-surface-raised px-2 py-1 text-micro font-medium uppercase tracking-wide text-muted-foreground">
        {title} · {files.length}
      </p>
      {files.map((file) => (
        <ChangeRow
          key={`${file.staged ? "s" : "w"}:${decodeText(file.path)}`}
          file={file}
          repo={repo}
        />
      ))}
    </div>
  );
}

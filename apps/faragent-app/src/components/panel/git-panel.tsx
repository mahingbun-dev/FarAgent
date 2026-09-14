/**
 * The Git tab: what repository this session is in, and what is in it.
 *
 * Read-only, and structurally so: every control here either expands something
 * (a file's patch, another page of the log) or does nothing at all. There is no
 * checkout, no stage and no commit — branches are *listed* and are not buttons,
 * because "click the branch to switch" is the exact affordance this task was
 * told not to build.
 *
 * The repository is found by asking `git.discover` from the panel's root, which
 * walks up: a session whose cwd is `/srv/app/faragent` (no `.git` of its own)
 * still lands on the repository at `/srv/app`, and a directory with no
 * repository above it gets the empty state rather than an error.
 */
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GitBranch as BranchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Empty, Spinner } from "@/components/ui/empty";
import { ChangeRow } from "@/components/panel/changed-file-row";
import {
  usePanelDiscover,
  usePanelGitBranches,
  usePanelGitLog,
  usePanelGitStatus,
} from "@/components/panel/queries";
import { usePanelHelper } from "@/components/panel/helper-context";
import { decodeText, helperErrorText, HelperError } from "@/lib/helper";
import { basename } from "@/lib/panel/paths";
import { useStore, useT } from "@/state";

/** Rows rendered per list before a "show more" button. Matches the tree's. */
const LIST_PAGE_SIZE = 100;

export function GitPanel({ root }: { root: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const { connection } = usePanelHelper();
  const discover = usePanelDiscover(connection, root);

  if (!connection || discover.isLoading) return <Spinner label={t("git.discover")} />;

  if (discover.error) {
    const code = HelperError.from(discover.error).errorCode;
    return (
      <div className="p-2">
        {code === "not_a_repo" ? (
          <Empty>
            <p className="text-foreground">{t("git.notRepo")}</p>
            <p className="mt-1 break-all font-mono text-xs">
              {t("git.notRepoHint", { path: root })}
            </p>
          </Empty>
        ) : (
          <Empty>{t("git.error", { message: helperErrorText(discover.error, lang) })}</Empty>
        )}
      </div>
    );
  }

  if (!discover.data) return <Spinner label={t("git.discover")} />;

  return <GitBody root={decodeText(discover.data.root)} />;
}

/** A section heading, repeated four times below. */
function Section({ title, aside, children }: {
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border last:border-b-0">
      <p className="sticky top-0 z-10 flex items-center gap-2 bg-surface-raised px-2 py-1 text-micro font-medium uppercase tracking-wide text-muted-foreground">
        <span className="flex-1">{title}</span>
        {aside ? <span className="shrink-0 normal-case">{aside}</span> : null}
      </p>
      {children}
    </section>
  );
}

function GitBody({ root }: { root: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const { connection } = usePanelHelper();
  const status = usePanelGitStatus(connection, root);
  const branches = usePanelGitBranches(connection, root);
  const log = usePanelGitLog(connection, root);

  const [shownFiles, setShownFiles] = useState(LIST_PAGE_SIZE);

  if (status.isLoading) return <Spinner label={t("file.loading")} />;

  if (status.error) {
    return (
      <div className="p-2">
        <Empty>{t("git.error", { message: helperErrorText(status.error, lang) })}</Empty>
      </div>
    );
  }

  const data = status.data;
  if (!data) return <Spinner label={t("file.loading")} />;

  const files = data.files;
  const visibleFiles = files.slice(0, shownFiles);
  const commits = (log.data?.pages ?? []).flatMap((page) => page.commits);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Section title={t("git.repo")} aside={basename(root)}>
        <div className="flex flex-wrap items-center gap-1.5 px-2 py-2">
          <span className="min-w-0 flex-1 break-all font-mono text-xs" title={root}>
            {root}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
          <BranchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {data.detached ? (
            <Badge variant="warning">{t("git.detached")}</Badge>
          ) : data.initial || data.branch === null ? (
            <Badge variant="outline">{t("git.initial")}</Badge>
          ) : (
            <Badge variant="link">{decodeText(data.branch)}</Badge>
          )}

          {data.ahead > 0 ? (
            <Badge variant="default" className="gap-0.5">
              <ArrowUp className="h-2.5 w-2.5" />
              {t("git.ahead", { count: data.ahead })}
            </Badge>
          ) : null}
          {data.behind > 0 ? (
            <Badge variant="default" className="gap-0.5">
              <ArrowDown className="h-2.5 w-2.5" />
              {t("git.behind", { count: data.behind })}
            </Badge>
          ) : null}
          {data.ahead === 0 && data.behind === 0 && data.upstream ? (
            <span className="text-xs text-muted-foreground">{t("git.inSync")}</span>
          ) : null}
        </div>
        {data.upstream ? (
          <p className="px-2 pb-2 font-mono text-micro text-muted-foreground">
            {t("git.upstream", { name: decodeText(data.upstream) })}
          </p>
        ) : null}
      </Section>

      <Section
        title={t("changes.title")}
        aside={files.length === 0 ? undefined : t("changes.count", { count: files.length })}
      >
        {files.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t("git.clean")}</p>
        ) : (
          <>
            {data.truncated ? (
              <p className="px-2 py-1 text-xs text-warning">
                {t("changes.truncated", { count: files.length })}
              </p>
            ) : null}
            {visibleFiles.map((file) => (
              <ChangeRow
                key={`${file.staged ? "s" : "w"}:${decodeText(file.path)}`}
                file={file}
                repo={root}
              />
            ))}
            {files.length > shownFiles ? (
              <button
                type="button"
                className="w-full py-1 text-left text-xs text-link hover:bg-surface-hover"
                style={{ paddingLeft: 8 }}
                onClick={() => setShownFiles((n) => n + LIST_PAGE_SIZE)}
              >
                {t("tree.showMore", {
                  count: Math.min(LIST_PAGE_SIZE, files.length - shownFiles),
                })}
              </button>
            ) : null}
          </>
        )}
      </Section>

      <Section
        title={t("git.branches")}
        aside={
          branches.data ? String(branches.data.branches.length) : undefined
        }
      >
        {branches.isLoading ? (
          <Spinner label={t("file.loading")} />
        ) : branches.error ? (
          <p className="px-2 py-1 text-xs text-danger">
            {t("git.error", { message: helperErrorText(branches.error, lang) })}
          </p>
        ) : (branches.data?.branches.length ?? 0) === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {t("git.branchesEmpty")}
          </p>
        ) : (
          // Deliberately not a button: this panel does not switch branches.
          (branches.data?.branches ?? []).map((branch) => (
            <div
              key={decodeText(branch.full)}
              className="flex items-center gap-2 px-2 py-1 text-xs"
              title={decodeText(branch.full)}
            >
              <BranchIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono">
                {decodeText(branch.name)}
              </span>
              {branch.current ? (
                <Badge variant="success">{t("git.current")}</Badge>
              ) : null}
              {branch.remote ? (
                <Badge variant="outline">{t("git.remoteBranch")}</Badge>
              ) : null}
            </div>
          ))
        )}
      </Section>

      <Section
        title={t("git.log")}
        aside={commits.length === 0 ? undefined : String(commits.length)}
      >
        {log.isLoading ? (
          <Spinner label={t("file.loading")} />
        ) : log.error ? (
          <p className="px-2 py-1 text-xs text-danger">
            {t("git.error", { message: helperErrorText(log.error, lang) })}
          </p>
        ) : commits.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t("git.logEmpty")}</p>
        ) : (
          <>
            {commits.map((commit) => (
              <div key={commit.hash} className="px-2 py-1" title={commit.hash}>
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-micro text-muted-foreground">
                    {commit.short}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {decodeText(commit.subject)}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 pl-0 text-micro text-muted-foreground">
                  <span className="truncate">{decodeText(commit.author)}</span>
                  <span className="shrink-0">{commit.authorDate.slice(0, 10)}</span>
                  {commit.refs ? (
                    <span className="min-w-0 truncate text-link">
                      {decodeText(commit.refs)}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
            {log.hasNextPage ? (
              <button
                type="button"
                className="w-full py-1.5 text-xs text-link hover:bg-surface-hover disabled:text-muted-foreground"
                disabled={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
              >
                {t("git.logMore")}
              </button>
            ) : null}
          </>
        )}
      </Section>
    </div>
  );
}

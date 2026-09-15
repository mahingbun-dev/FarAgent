/**
 * Markdown, rendered.
 *
 * A turn's prose arrives as Markdown — that is what the agent wrote, not a
 * format this app chose — and the reference UI shows it as such: headings,
 * lists, tables, inline code and fenced blocks. So this is the one place the
 * conversation's text becomes elements.
 *
 * ## Why a library, and why not `dangerouslySetInnerHTML`
 *
 * The brief rules out a hand-rolled parser and rules out
 * `dangerouslySetInnerHTML`, and both are the same point. The transcript is **a
 * file written by a program running on a remote machine**: its content is
 * untrusted by construction, and the two failure modes of doing this by hand are
 * a parser that gets nesting subtly wrong on the day a model writes an
 * unterminated fence, and an XSS surface if any of it is handed to the DOM as
 * HTML. `react-markdown` parses to a syntax tree and renders it as **React
 * elements** — there is no `innerHTML` anywhere in the path, so a `<script>` in a
 * turn is a paragraph containing that text, not a script. `remark-gfm` adds the
 * tables and strikethrough Claude actually writes. (`lib/panel/highlight.ts` is
 * hand-rolled for the opposite reason: it scans code, there is no HTML to
 * produce, and its output is spans this app constructs.)
 *
 * Links are the one thing worth a second look: a transcript can contain a
 * `javascript:` URL, and `react-markdown` does not sanitise by default. The `a`
 * override below pins `rel` and `target`, and React itself refuses a
 * `javascript:` `href` on an element it creates — so the remaining exposure is a
 * link the reader would have to click knowingly, which is the same exposure the
 * terminal already has. That is the honest bound, not an absolute.
 *
 * ## What it reuses
 *
 * A fenced block renders through the panel's `CodeBlock`, so a code block in a
 * conversation is the same component, the same highlighter and the same colours
 * as the same code in the panel — one code renderer in the app, not two.
 */
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/panel/code";

/**
 * Markdown fence names → the highlighter's languages.
 *
 * `lib/panel/highlight.ts` knows js, rust, py, sh, go, json, yaml, toml, sql,
 * css and html, and answers `plain` for anything else — which is the right
 * default, because an unrecognised fence should read as text rather than as
 * mis-coloured code. The names below are the spellings models actually write,
 * including the ones (`typescript`, `shell`, `bash`) that are not the
 * highlighter's own.
 */
const FENCE_LANGUAGE: Record<string, string> = {
  js: "js",
  jsx: "js",
  javascript: "js",
  ts: "js",
  tsx: "js",
  typescript: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "js",
  sh: "sh",
  shell: "sh",
  bash: "sh",
  zsh: "sh",
  console: "sh",
  rs: "rust",
  rust: "rust",
  py: "py",
  python: "py",
  go: "go",
  sql: "sql",
  css: "css",
  scss: "css",
  html: "html",
  xml: "html",
  svg: "html",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "toml",
};

/**
 * The rendering rules, as child selectors on one class.
 *
 * ## Why the prose width is on the elements and not on the container
 *
 * A conversation is read at `CONTENT_WIDTH.prose`, but a **fence is not prose**:
 * it is monospace, it does not wrap, and at the reading width a real one clipped
 * characters off its right edge — into a horizontal overflow that macOS scrolls
 * with a scrollbar it never draws, so the rest of the line was simply gone. The
 * cap is therefore on the block elements that are prose (and on tables, which
 * were already this width) rather than on the wrapping `div`, which leaves the
 * block-level `CodeBlock` free to use the content width.
 *
 * The caveat that survives: a line wider than the content column can still only
 * be reached by scrolling, and on macOS nothing draws the scrollbar that would
 * say so. That is the panel's behaviour too (`components/panel/code.tsx`) and
 * making the affordance visible is an app-wide decision, not this view's.
 */
const CLASS = [
  "text-sm leading-prose text-foreground",
  "[&_a]:text-link [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-2 [&_blockquote]:max-w-prose [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_code]:font-mono",
  "[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:max-w-prose [&_h1]:font-display [&_h1]:text-lg",
  "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:max-w-prose [&_h2]:font-display [&_h2]:text-base",
  "[&_h3]:mt-4 [&_h3]:mb-1 [&_h3]:max-w-prose [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:max-w-prose [&_h4]:text-sm [&_h4]:font-medium",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_li]:my-0.5",
  "[&_ol]:my-2 [&_ol]:max-w-prose [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_p]:my-2 [&_p]:max-w-prose",
  "[&_table]:my-2 [&_table]:w-full [&_table]:max-w-prose [&_table]:text-xs",
  "[&_td]:border-b [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
  "[&_ul]:my-2 [&_ul]:max-w-prose [&_ul]:list-disc [&_ul]:pl-5",
].join(" ");

/**
 * A fenced block is drawn by `code`, which is where the fence's language is, and
 * `pre` is then reduced to a pass-through so it does not wrap that block in a
 * second, unstyled `<pre>`.
 *
 * `code` without a `language-…` class is inline code — the same element, told
 * apart by the class remark puts on a fence and never on a span.
 *
 * The fence's own box is a `div`, not a `pre`: `CodeBlock` renders block-level
 * `div`s, and `pre`'s content model is phrasing content, so a `pre` here is
 * invalid nesting that only works because React builds elements rather than
 * parsing HTML. Nothing is lost by dropping it — the whitespace that mattered is
 * already `whitespace-pre` on `CodeBlock`'s lines.
 */
const COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const fence = /language-([\w-]+)/.exec(className ?? "");
    if (!fence) {
      return (
        <code className="rounded bg-code-bg px-1 py-0.5 font-mono text-xs">
          {children}
        </code>
      );
    }
    const text = typeof children === "string" ? children : String(children ?? "");
    return (
      <div className="my-2 overflow-x-auto rounded-md border border-border bg-code-bg px-3">
        <CodeBlock
          lines={text.replace(/\n$/, "").split("\n")}
          language={FENCE_LANGUAGE[fence[1].toLowerCase()] ?? "plain"}
        />
      </div>
    );
  },
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-link underline underline-offset-2"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-xs">{children}</table>
    </div>
  ),
};

/**
 * A Markdown string as elements.
 *
 * `remarkPlugins` is rebuilt per call, but a plugin list is a value
 * `react-markdown` compares structurally — and this is not a hot path (a turn
 * renders once, and the list is virtualised). Hoisting it would buy nothing and
 * would put a mutable array in module scope.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className={CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

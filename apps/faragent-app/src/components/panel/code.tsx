/**
 * The panel's code renderer.
 *
 * `lib/panel/highlight.ts` is the scanner (pure, tested, dependency-free); this
 * is the two lines that turn its tokens into spans. Both the file preview and
 * the diff view render through here so a patch reads in the same colours as the
 * file it came from.
 *
 * Colours are picked from the existing theme tokens rather than new ones:
 * comments muted, strings green, numbers amber, keywords blue, and a type name
 * standing out by weight instead of by a fifth hue. That leaves the panel with
 * no colour a diff can be confused by — red and green stay reserved for
 * removed and added lines.
 */
import { tokenizeLine, type TokenType } from "@/lib/panel/highlight";

const TOKEN_CLASS: Record<TokenType, string> = {
  plain: "text-foreground",
  comment: "text-muted-foreground italic",
  string: "text-success",
  number: "text-warning",
  keyword: "text-link",
  type: "text-foreground font-medium",
};

/** One line's tokens, as spans. Concatenated, they are the line exactly. */
export function CodeText({ text, language }: { text: string; language: string }) {
  const tokens = tokenizeLine(text, language);
  return (
    <>
      {tokens.map((token, i) => (
        <span key={i} className={TOKEN_CLASS[token.type]}>
          {token.text}
        </span>
      ))}
    </>
  );
}

/**
 * Lines with a gutter. The whole block is `min-w-fit` inside a scrolling
 * parent, so a long line widens the block instead of wrapping: a wrapped line
 * in a preview is worse than a horizontal scrollbar, because the reader loses
 * the line numbers they were reading against.
 */
export function CodeBlock({
  lines,
  language,
  startLine = 1,
}: {
  lines: string[];
  language: string;
  startLine?: number;
}) {
  return (
    <div className="min-w-fit py-1 font-mono text-xs leading-5">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span
            aria-hidden="true"
            className="w-11 shrink-0 select-none pr-3 text-right text-muted-foreground/50 tabular-nums"
          >
            {startLine + i}
          </span>
          <span className="whitespace-pre">
            <CodeText text={line} language={language} />
          </span>
        </div>
      ))}
    </div>
  );
}

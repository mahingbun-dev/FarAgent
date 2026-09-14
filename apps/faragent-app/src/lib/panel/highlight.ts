/**
 * A small, dependency-free syntax highlighter.
 *
 * The project has no highlighting library and this task deliberately does not
 * add one: the preview is read-only, capped at 1 MiB and at 2000 rendered
 * lines, and a full editor grammar (or a 1 MB grammar table) would be weight
 * bought for a view that never edits. What a reader needs from a preview is
 * the shape of the code — comments, strings, keywords and numbers told apart —
 * and that is what this scanner produces.
 *
 * Two honest limits, both deliberate:
 *
 * - **Line at a time.** A string or block comment that runs past the end of
 *   its line is closed at the newline rather than carried into the next line.
 *   Tracking it across lines would need the whole file's state in the scanner
 *   for a case that a code preview rarely has (and gets wrong quietly when it
 *   does).
 * - **No semantics.** Every capitalised identifier is painted as a type name.
 *   That is a heuristic, but a stable and cheap one, and wrong about `Foo` in
 *   `Foo()` being a function rather than a type is a colour, not a bug.
 *
 * Pure: no DOM, no imports. The component turns tokens into `<span>`s.
 */

export type TokenType = "plain" | "comment" | "string" | "number" | "keyword" | "type";

export interface Token {
  text: string;
  type: TokenType;
}

interface LangSpec {
  keywords: Set<string>;
  /** Markers that comment out the rest of the line. */
  lineComment: string[];
  /** A single-line-only block comment pair, or `null`. */
  blockComment: [string, string] | null;
  /** Quote characters that open a string. */
  strings: string[];
  /**
   * `SQL` is the one language here whose keywords are written in either case,
   * so its keyword test folds case. Everywhere else folding would turn a
   * capitalised *type* into a keyword (`Type`, `Class`, `New`), which is the
   * wrong colour and the reason this is a per-language flag.
   */
  foldKeywordCase?: boolean;
}

function words(list: string): Set<string> {
  return new Set(list.split(" ").filter(Boolean));
}

const JS_KEYWORDS = words(
  "import export from default const let var function return if else for while do switch case break continue new typeof instanceof await async class extends implements interface type enum throw try catch finally delete in of yield as satisfies readonly public private protected static get set void",
);
const RUST_KEYWORDS = words(
  "fn let mut const static struct enum impl trait for while loop if else match return use mod pub crate self super as where async await move ref dyn box unsafe extern type in",
);
const PY_KEYWORDS = words(
  "def class return if elif else for while import from as with try except finally raise yield lambda pass break continue global nonlocal assert del in is not and or None True False async await self",
);
const SH_KEYWORDS = words(
  "if then else elif fi for while do done case esac function return local export readonly set unset echo cd exit source trap in",
);
const GO_KEYWORDS = words(
  "package import func var const type struct interface map chan go defer return if else for range switch case break continue select nil true false",
);
const SQL_KEYWORDS = words(
  "select from where join left right inner outer on group by order limit offset insert update delete create table index drop alter into values set as and or not null",
);

/** Extension (lower-case, no dot) → the language the scanner uses. */
const BY_EXTENSION: Record<string, string> = {
  ts: "js",
  tsx: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  mts: "js",
  cts: "js",
  json: "json",
  jsonc: "js",
  rs: "rust",
  py: "py",
  pyi: "py",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  go: "go",
  sql: "sql",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "toml",
  conf: "toml",
  md: "md",
  markdown: "md",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  hpp: "c",
  java: "c",
  kt: "c",
  swift: "c",
  rb: "sh",
  lua: "sh",
  dockerfile: "sh",
  makefile: "sh",
};

const SPECS: Record<string, LangSpec> = {
  js: {
    keywords: JS_KEYWORDS,
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: ['"', "'", "`"],
  },
  rust: {
    keywords: RUST_KEYWORDS,
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: ['"'],
  },
  py: {
    keywords: PY_KEYWORDS,
    lineComment: ["#"],
    blockComment: null,
    strings: ['"', "'"],
  },
  sh: {
    keywords: SH_KEYWORDS,
    lineComment: ["#"],
    blockComment: null,
    strings: ['"', "'"],
  },
  go: {
    keywords: GO_KEYWORDS,
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: ['"', "`"],
  },
  json: {
    keywords: words("true false null"),
    lineComment: [],
    blockComment: null,
    strings: ['"'],
  },
  yaml: {
    keywords: words("true false null yes no"),
    lineComment: ["#"],
    blockComment: null,
    strings: ['"', "'"],
  },
  toml: {
    keywords: words("true false"),
    lineComment: ["#"],
    blockComment: null,
    strings: ['"', "'"],
  },
  md: {
    keywords: words(""),
    lineComment: ["#"],
    blockComment: null,
    strings: ["`"],
  },
  css: {
    keywords: words(""),
    lineComment: [],
    blockComment: ["/*", "*/"],
    strings: ['"', "'"],
  },
  html: {
    keywords: words(""),
    lineComment: [],
    blockComment: ["<!--", "-->"],
    strings: ['"', "'"],
  },
  sql: {
    keywords: SQL_KEYWORDS,
    lineComment: ["--"],
    blockComment: ["/*", "*/"],
    strings: ["'", '"'],
    foldKeywordCase: true,
  },
  c: {
    keywords: words(
      "int char long short float double void unsigned signed struct enum union typedef const static extern return if else for while do switch case break continue sizeof goto class public private protected namespace using template new delete nullptr true false",
    ),
    lineComment: ["//"],
    blockComment: ["/*", "*/"],
    strings: ['"', "'"],
  },
  plain: {
    keywords: words(""),
    lineComment: [],
    blockComment: null,
    strings: ['"', "'"],
  },
};

/**
 * The language for a path, by its extension or its whole basename
 * (`Dockerfile`, `Makefile`). Unknown → `plain`, which still gets strings.
 */
export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const direct = BY_EXTENSION[name];
  if (direct) return direct;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const ext = name.slice(dot + 1);
    const byExt = BY_EXTENSION[ext];
    if (byExt) return byExt;
  }
  return "plain";
}

/** Tokens for one line. Concatenating their text reproduces the line exactly. */
export function tokenizeLine(line: string, language: string): Token[] {
  const spec = SPECS[language] ?? SPECS.plain;
  const out: Token[] = [];
  let plain = "";
  let i = 0;

  const flush = () => {
    if (plain !== "") {
      out.push({ text: plain, type: "plain" });
      plain = "";
    }
  };

  while (i < line.length) {
    const macro = spec.lineComment.find((marker) => line.startsWith(marker, i));
    if (macro !== undefined) {
      flush();
      out.push({ text: line.slice(i), type: "comment" });
      break;
    }

    if (spec.blockComment && line.startsWith(spec.blockComment[0], i)) {
      const closeAt = line.indexOf(
        spec.blockComment[1],
        i + spec.blockComment[0].length,
      );
      const stop =
        closeAt === -1 ? line.length : closeAt + spec.blockComment[1].length;
      flush();
      out.push({ text: line.slice(i, stop), type: "comment" });
      i = stop;
      continue;
    }

    const ch = line.charAt(i);
    if (spec.strings.includes(ch)) {
      let j = i + 1;
      while (j < line.length) {
        if (line.charAt(j) === "\\") {
          j += 2;
          continue;
        }
        if (line.charAt(j) === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      const stop = Math.min(j, line.length);
      flush();
      out.push({ text: line.slice(i, stop), type: "string" });
      i = stop;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxXoObB._]/.test(line.charAt(j))) j += 1;
      flush();
      out.push({ text: line.slice(i, j), type: "number" });
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[\w$]/.test(line.charAt(j))) j += 1;
      const word = line.slice(i, j);
      const isKeyword =
        spec.keywords.has(word) ||
        (spec.foldKeywordCase === true && spec.keywords.has(word.toLowerCase()));
      if (isKeyword) {
        flush();
        out.push({ text: word, type: "keyword" });
      } else if (/^[A-Z]/.test(word)) {
        flush();
        out.push({ text: word, type: "type" });
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flush();
  return out;
}

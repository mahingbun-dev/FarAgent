/**
 * `highlight.ts` — the tokenizer's contract.
 *
 * The one invariant that matters is lossless-ness: concatenating a line's
 * tokens must reproduce the line byte for byte. If a tokenizer drops a quote
 * or eats a comment marker, the preview is not a preview of the file any more —
 * and nobody would notice from a screenshot. The rest pins the four colours the
 * reader actually uses (comment, string, number, keyword) and the extension
 * map.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { languageForPath, tokenizeLine } from "./highlight.ts";

function joined(line: string, lang: string): string {
  return tokenizeLine(line, lang)
    .map((t) => t.text)
    .join("");
}

function typesOf(line: string, lang: string): Array<[string, string]> {
  return tokenizeLine(line, lang).map((t) => [t.type, t.text]);
}

test("tokenizing is lossless for every language in the map", () => {
  const samples: Array<[string, string]> = [
    ['const x = "a\\"b"; // c', "js"],
    ["let mut n: u32 = 0x1f; /* hi */", "rust"],
    ["def f(a=1):  # note", "py"],
    ["if [ -f x ]; then echo \"$x\"; fi", "sh"],
    ["func main() { fmt.Println(\"hi\") }", "go"],
    ['{"a": [1, true, null]}', "json"],
    ["key: 'value'  # yaml", "yaml"],
    ["[table]\nn = 1", "toml"],
    ["# Title\n\n`code`", "md"],
    ["/* c */ .a { color: #fff; }", "css"],
    ["<!-- c --> <a href=\"x\">y</a>", "html"],
    ["SELECT * FROM t WHERE a = 'b' -- c", "sql"],
    ["int main(void) { return 0; }", "c"],
    ["plain text with 'quotes' and 42", "plain"],
    ["tab\tseparated\tvalues", "plain"],
  ];
  for (const [line, lang] of samples) {
    assert.equal(joined(line, lang), line, `${lang}: ${line}`);
  }
});

test("comments, strings, numbers and keywords get their own token types", () => {
  assert.deepEqual(typesOf("let x = 42; // note", "rust"), [
    ["keyword", "let"],
    ["plain", " x = "],
    ["number", "42"],
    ["plain", "; "],
    ["comment", "// note"],
  ]);

  assert.deepEqual(typesOf('const s = "hi";', "js"), [
    ["keyword", "const"],
    ["plain", " s = "],
    ["string", '"hi"'],
    ["plain", ";"],
  ]);

  // `#` comments the rest of the line in both shells and Python.
  assert.deepEqual(typesOf("x=1  # why", "py"), [
    ["plain", "x="],
    ["number", "1"],
    ["plain", "  "],
    ["comment", "# why"],
  ]);

  // A capitalised word reads as a type name.
  assert.deepEqual(typesOf("Foo::bar", "rust"), [
    ["type", "Foo"],
    ["plain", "::bar"],
  ]);
});

test("an unterminated string or block comment stops at the line's end", () => {
  // The scanner is line-at-a-time by design; it must not lose the tail.
  assert.equal(joined('let s = "open', "rust"), 'let s = "open');
  assert.equal(
    tokenizeLine('let s = "open', "rust").at(-1)?.type,
    "string",
  );
  assert.equal(joined("/* open", "js"), "/* open");
  assert.equal(tokenizeLine("/* open", "js").at(-1)?.type, "comment");
});

test("a string's escape does not end it early", () => {
  const tokens = tokenizeLine('"a\\"b" + c', "js");
  assert.equal(tokens[0].type, "string");
  assert.equal(tokens[0].text, '"a\\"b"');
  assert.equal(joined('"a\\"b" + c', "js"), '"a\\"b" + c');
});

test("languageForPath maps extensions and bare tool names", () => {
  assert.equal(languageForPath("/srv/app/src/main.rs"), "rust");
  assert.equal(languageForPath("apps/faragent-app/src/app.tsx"), "js");
  assert.equal(languageForPath("docs/en/notes.md"), "md");
  assert.equal(languageForPath("Dockerfile"), "sh");
  assert.equal(languageForPath("a/Makefile"), "sh");
  assert.equal(languageForPath("data.yml"), "yaml");
  assert.equal(languageForPath("Cargo.toml"), "toml");
  assert.equal(languageForPath("package.json"), "json");
  // Unknown and extension-less names still tokenize (as `plain`).
  assert.equal(languageForPath("LICENSE"), "plain");
  assert.equal(languageForPath("x.unknownext"), "plain");
  assert.equal(languageForPath("/"), "plain");
  // Case-insensitive on the extension.
  assert.equal(languageForPath("README.MD"), "md");
});

/**
 * `paths.ts` — the panel's path arithmetic.
 *
 * The three functions the panel builds on are `joinPath` (the tree's child
 * rows), `parentPath` (the ".." row and the git walk-up's starting point) and
 * `normalizePath` (what a typed root becomes before it goes on the wire). The
 * remote normalises identically — `src/lib/mock/helper.ts::normalise` is the
 * same algorithm — so a divergence here would show as a path the remote calls
 * `not_found`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ancestors,
  basename,
  isRoot,
  joinPath,
  normalizePath,
  parentPath,
} from "./paths.ts";

test("normalizePath collapses . and .., duplicate and trailing slashes", () => {
  assert.equal(normalizePath("/srv/app"), "/srv/app");
  assert.equal(normalizePath("/srv//app///src/"), "/srv/app/src");
  assert.equal(normalizePath("/srv/./app"), "/srv/app");
  assert.equal(normalizePath("/srv/app/../docs"), "/srv/docs");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("//"), "/");
  assert.equal(normalizePath(""), "/");
  assert.equal(normalizePath("."), "/");
  // `..` past the root stops at the root rather than escaping it.
  assert.equal(normalizePath("/../etc"), "/etc");
  assert.equal(normalizePath("/a/b/../../.."), "/");
});

test("parentPath is the .. of a path, and the root is its own parent", () => {
  assert.equal(parentPath("/srv/app/src"), "/srv/app");
  assert.equal(parentPath("/srv"), "/");
  assert.equal(parentPath("/"), "/");
  // Trailing slash and `..` normalise first, so `/srv/app/` has the same
  // parent as `/srv/app`.
  assert.equal(parentPath("/srv/app/"), "/srv");
  // `..` normalises first, so the parent is the parent of the collapsed path.
  assert.equal(parentPath("/srv/app/.."), "/");
  assert.equal(parentPath(""), "/");
});

test("joinPath appends a name, and an absolute name replaces the base", () => {
  assert.equal(joinPath("/srv/app", "src"), "/srv/app/src");
  assert.equal(joinPath("/", "srv"), "/srv");
  // The root is the one base that must not produce a double slash.
  assert.equal(joinPath("/", "README.md"), "/README.md");
  assert.equal(joinPath("/srv/app/", "src"), "/srv/app/src");
  assert.equal(joinPath("/srv/app", "../docs"), "/srv/docs");
  // A typed absolute path is a root change, not a child.
  assert.equal(joinPath("/srv/app", "/var/log"), "/var/log");
  assert.equal(joinPath("/srv/app", ""), "/srv/app");
});

test("basename is the last segment, and / for the root", () => {
  assert.equal(basename("/srv/app/faragent"), "faragent");
  assert.equal(basename("/srv/app/"), "app");
  assert.equal(basename("/"), "/");
});

test("ancestors lists every parent, outermost first, excluding the path", () => {
  assert.deepEqual(ancestors("/srv/app/faragent"), ["/", "/srv", "/srv/app"]);
  assert.deepEqual(ancestors("/srv"), ["/"]);
  assert.deepEqual(ancestors("/"), []);
  assert.equal(isRoot("/"), true);
  assert.equal(isRoot("/srv"), false);
});

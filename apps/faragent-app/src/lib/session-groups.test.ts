import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_PAGE,
  allCollapsed,
  budgetGroups,
  groupByWorkspace,
  lastPathSegment,
  setGroupsCollapsed,
  sortSessions,
} from "./session-groups.ts";
import type { Session } from "@/lib/ipc";

function session(id: string, cwd: string | null, mtime: number): Session {
  return { id, agent: "claude", title: id, cwd, mtime, live: false, running: false };
}

test("sortSessions puts the newest first and breaks ties on id", () => {
  const sorted = sortSessions([
    session("b", "/w", 10),
    session("older", "/w", 5),
    session("a", "/w", 10),
  ]);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ["a", "b", "older"],
  );
});

test("groupByWorkspace buckets by cwd with the newest workspace first", () => {
  const groups = groupByWorkspace([
    session("old-a", "/old", 1),
    session("new-b", "/new", 30),
    session("new-a", "/new", 20),
    session("mid", "/mid", 10),
  ]);
  assert.deepEqual(
    groups.map((g) => g.cwd),
    ["/new", "/mid", "/old"],
  );
  assert.deepEqual(
    groups[0].sessions.map((s) => s.id),
    ["new-b", "new-a"],
  );
});

test("groupByWorkspace collects sessions with no cwd into one group", () => {
  const groups = groupByWorkspace([
    session("a", null, 3),
    session("b", "   ", 2),
    session("c", "/w", 1),
  ]);
  const noCwd = groups.find((g) => g.cwd === null);
  assert.deepEqual(
    noCwd?.sessions.map((s) => s.id),
    ["a", "b"],
  );
});

test("budgetGroups cuts mid-group and reports the rest as hidden", () => {
  const groups = groupByWorkspace([
    session("a1", "/a", 30),
    session("a2", "/a", 29),
    session("a3", "/a", 28),
    session("b1", "/b", 20),
    session("b2", "/b", 19),
  ]);
  const { groups: visible, hidden } = budgetGroups(groups, 4);
  assert.deepEqual(
    visible.map((g) => [g.cwd, g.sessions.length]),
    [
      ["/a", 3],
      ["/b", 1],
    ],
  );
  assert.equal(hidden, 1);
});

test("budgetGroups over the whole list hides nothing", () => {
  const sessions = Array.from({ length: 25 }, (_, i) =>
    session(`s${String(i).padStart(2, "0")}`, "/w", 100 - i),
  );
  const groups = groupByWorkspace(sessions);

  const page = budgetGroups(groups, SESSION_PAGE);
  assert.equal(SESSION_PAGE, 20);
  assert.equal(page.hidden, 5);
  assert.equal(page.groups[0].sessions.length, 20);

  const all = budgetGroups(groups, 100);
  assert.equal(all.hidden, 0);
  assert.equal(all.groups[0].sessions.length, 25);
});

test("lastPathSegment keeps only the final segment of a posix path", () => {
  assert.equal(lastPathSegment("/srv/app/faragent"), "faragent");
  assert.equal(lastPathSegment("/srv/app/faragent/"), "faragent");
  assert.equal(lastPathSegment("/srv/app///"), "app");
  assert.equal(lastPathSegment("app"), "app");
});

test("lastPathSegment returns a root whole, since it has no last segment", () => {
  assert.equal(lastPathSegment("/"), "/");
  assert.equal(lastPathSegment(""), "");
  assert.equal(lastPathSegment("///"), "///");
});

test("lastPathSegment reads a windows path without mangling it", () => {
  // A Windows remote reports `cwd` this way, and @/lib/panel/paths.ts's
  // `basename` is deliberately not used here: it normalises to a posix root
  // first, which would hand back a path the remote never named.
  assert.equal(lastPathSegment("C:\\Users\\me\\app"), "app");
  assert.equal(lastPathSegment("C:\\Users\\me\\app\\"), "app");
  assert.equal(lastPathSegment("C:/Users/me/app"), "app");
  assert.equal(lastPathSegment("C:\\"), "C:");
});

test("allCollapsed is false for an empty rail and for any expanded group", () => {
  assert.equal(allCollapsed([], {}), false);
  assert.equal(allCollapsed([], { a: true }), false);
  assert.equal(allCollapsed(["a", "b"], { a: true, b: true }), true);
  assert.equal(allCollapsed(["a", "b"], { a: true, b: false }), false);
  // A key the rail has never seen is not collapsed, so the control offers to
  // collapse rather than to expand.
  assert.equal(allCollapsed(["a", "b"], { a: true }), false);
});

test("setGroupsCollapsed rebuilds the record instead of merging into it", () => {
  const stale = { "\0scheduled": true, "old/host": true };
  assert.deepEqual(setGroupsCollapsed(["a", "b"], true), { a: true, b: true });
  assert.deepEqual(setGroupsCollapsed(["a"], false), { a: false });
  // Every key the caller named is present; nothing else survives.
  const next = setGroupsCollapsed(["a", "b"], true);
  assert.equal(next["\0scheduled"], undefined);
  assert.equal(next["old/host"], undefined);
  assert.equal(Object.keys(stale).length, 2);
});

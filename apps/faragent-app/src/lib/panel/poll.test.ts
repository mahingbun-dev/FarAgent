/**
 * `poll.ts` — when the left rail's session poll runs and when it is paused.
 *
 * The brief asks for a 30s poll that pauses while the window is hidden or
 * unfocused. The whole decision is two booleans, so it is tested as a table
 * rather than through a mounted component: the value of the test is that every
 * combination is pinned, including the one that is easy to get wrong — a window
 * on a second monitor is unfocused but still *visible*, and still paused.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_POLL_MS, sessionPollInterval } from "./poll.ts";

test("a visible, focused window polls every 30 seconds", () => {
  assert.equal(sessionPollInterval({ hidden: false, focused: true }), 30_000);
  assert.equal(SESSION_POLL_MS, 30_000);
});

test("a hidden window does not poll", () => {
  // Minimised, or on another desktop. An app left open overnight would
  // otherwise ask the remote 2,880 times for a list nobody is looking at.
  assert.equal(sessionPollInterval({ hidden: true, focused: true }), false);
});

test("an unfocused window does not poll", () => {
  assert.equal(sessionPollInterval({ hidden: false, focused: false }), false);
});

test("hidden and unfocused is still no poll", () => {
  assert.equal(sessionPollInterval({ hidden: true, focused: false }), false);
});

test("the pause is a table over both flags, with one polling row", () => {
  const rows: Array<[{ hidden: boolean; focused: boolean }, number | false]> = [
    [{ hidden: false, focused: true }, SESSION_POLL_MS],
    [{ hidden: true, focused: true }, false],
    [{ hidden: false, focused: false }, false],
    [{ hidden: true, focused: false }, false],
  ];
  for (const [activity, expected] of rows) {
    assert.equal(
      sessionPollInterval(activity),
      expected,
      `hidden=${activity.hidden} focused=${activity.focused}`,
    );
  }
});

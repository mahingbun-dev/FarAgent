/**
 * The left rail's fallback poll.
 *
 * Sessions are cross-session information: the helper's pushes are per-remote and
 * per-subscription, and a session another person starts on the remote — or one
 * started by a `codex exec` schedule — is not a filesystem event under any panel
 * root. So the rail cannot ride the push channel, and it polls instead:
 *
 * - fresh on mount, so opening the rail (or switching host or agent) always asks;
 * - every [`SESSION_POLL_MS`] afterwards, which also covers a helper that died
 *   without telling anyone;
 * - **paused** while the window is hidden or unfocused. A poll nobody can see is
 *   a poll that spends the remote's CPU and the user's battery for nothing, and
 *   an app left open overnight would otherwise ask 2,880 times.
 *
 * Pure: the decision is a function of two booleans, so `node --test` pins the
 * table rather than a component's behaviour.
 */

/** How long between fallback polls while the window is visible and focused. */
export const SESSION_POLL_MS = 30_000;

/** What the browser knows about the window, as two plain booleans. */
export interface WindowActivity {
  /** `document.visibilityState === "hidden"`. */
  hidden: boolean;
  /** `document.hasFocus()`. */
  focused: boolean;
}

/**
 * The interval for a session-list poll, or `false` to pause it.
 *
 * Hidden *or* unfocused pauses: a backgrounded app is hidden on some platforms
 * and merely unfocused on others, and the brief asks for both. The two are not
 * redundant — a window on a second monitor is unfocused but still visible.
 */
export function sessionPollInterval(activity: WindowActivity): number | false {
  if (activity.hidden || !activity.focused) return false;
  return SESSION_POLL_MS;
}

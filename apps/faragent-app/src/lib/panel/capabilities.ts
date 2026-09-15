/**
 * What the connected remote can actually do.
 *
 * `helper_open` answers with a *mode* — native helper, or the bash fallback —
 * but the mode is a label, not a capability list, and the two are not the same
 * question. The fallback is a seven-op shell script
 * (`crates/faragent-remote/src/fs.rs`, its own `ping` reply lists them) while the
 * native helper speaks twelve, and the difference is exactly the three panel
 * features that need more than the fallback has:
 *
 * | panel feature              | op                |
 * |----------------------------|-------------------|
 * | a file's patch             | `git.diff`        |
 * | the branch list            | `git.branches`    |
 * | live refresh on a push     | `watch.subscribe` |
 *
 * The one thing that answers the question is `ping`'s own `ops` array, and
 * nothing called it. On a fallback host that left three failures the user could
 * not read: the Changes tab died with `unknown op \`git.diff\``, the branch list
 * showed nothing but a red `unknown op \`git.branches\`` (which says what broke,
 * not what the remote can do), and live refresh never happened at all — a failed
 * subscribe is dropped by design in `lib/panel/watch.ts`, so of the three only
 * the first two even looked like failures.
 *
 * This module is that decision, kept pure: given the op list, which features are
 * on. The panel renders the reason in place of the feature it cannot use
 * (`lib/i18n.ts`'s `changes.noDiffOp` / `git.branchesUnsupported` /
 * `panel.watchUnsupported`), so the shortfall is stated rather than silently
 * suffered.
 */

/** The panel features that need an op the fallback does not have. */
export interface PanelCapabilities {
  /** Per-file patches — the Changes tab's expandable rows. */
  diff: boolean;
  /** The Git tab's branch list. */
  branches: boolean;
  /** `watch.subscribe`: a remote change refreshing the panel on its own. */
  watch: boolean;
}

/** The op behind each feature. Named so the reason texts and this agree. */
export const CAPABILITY_OPS = {
  diff: "git.diff",
  branches: "git.branches",
  watch: "watch.subscribe",
} as const;

/**
 * Everything on — what the panel assumes until the remote has answered.
 *
 * Optimistic on purpose. The alternative, all-off until proven otherwise, would
 * flash a disabled Changes tab and a "no live refresh" banner on every native
 * host for the one round trip `ping` takes, and the native helper is the common
 * case. Being wrong in this direction costs a request that fails with its own
 * error; being wrong in the other direction costs a panel that looks broken.
 */
export const OPTIMISTIC: PanelCapabilities = { diff: true, branches: true, watch: true };

/**
 * Decide from a `ping` reply's `ops`.
 *
 * `null` means "no answer" — see [`OPTIMISTIC`]. Anything else is exact: an op
 * the list does not name is an op the remote will refuse with `bad_request`, so
 * a feature whose op is absent is off, not "probably fine".
 */
export function capabilitiesFromOps(ops: readonly string[] | null): PanelCapabilities {
  if (ops === null) return OPTIMISTIC;
  const speaks = new Set(ops);
  return {
    diff: speaks.has(CAPABILITY_OPS.diff),
    branches: speaks.has(CAPABILITY_OPS.branches),
    watch: speaks.has(CAPABILITY_OPS.watch),
  };
}

/** A connection, as far as this module needs it. */
export interface Pingable {
  ping(): Promise<{ ops: string[] }>;
}

/** One answer per connection. Weak, so a closed channel's entry goes with it. */
const asked = new WeakMap<Pingable, Promise<PanelCapabilities>>();

/**
 * Ask a connection for its op list, once, and remember the answer.
 *
 * Once per *connection* rather than once per caller: the panel's lease hands the
 * same connection to StrictMode's remount and to a second panel on the same
 * host, and a ping each time would be two round trips for one unchanging answer.
 *
 * A ping that *fails* is `OPTIMISTIC`, not all-off. A dead channel has its own
 * state and its own sentence (`panel.closed` / `panel.error`); turning a broken
 * connection into "this remote cannot show diffs" would blame the fallback for
 * something it did not do.
 */
export function capabilitiesFor(connection: Pingable): Promise<PanelCapabilities> {
  const known = asked.get(connection);
  if (known) return known;
  const decision = connection.ping().then(
    (pong) => capabilitiesFromOps(pong.ops),
    () => capabilitiesFromOps(null),
  );
  asked.set(connection, decision);
  return decision;
}

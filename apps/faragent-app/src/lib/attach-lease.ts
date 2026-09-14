/**
 * The attach lease: one ssh attach per terminal key.
 *
 * `TerminalView` keys it by `` `${host}\0${specKey}` `` — one key per open tab —
 * so two tabs are two slots and each tab's cleanup releases its own. `release`
 * closes the slot for *its own* key and touches nothing else: that is what makes
 * closing a tab actually hang up that tab's attach, and what keeps a newly
 * opened tab from evicting a running one's slot. (The sibling shape that leaked
 * a slot per extra tab is described in `lease.ts`, which is where the deferred
 * close, the StrictMode window and the keyed invariant live.)
 *
 * This module only fixes the value type — `attach_open` answers with a numeric
 * session id — and the name. Both implementations are deliberately the same
 * one: a second copy of a subtle algorithm is how the single-slot bug survived
 * three fixes on this branch.
 */
import { createLease, type Lease, type Schedule } from "./lease.ts";

export type { Lease, Schedule };

export function createAttachLease(schedule?: Schedule): Lease<number> {
  return createLease<number>(schedule);
}

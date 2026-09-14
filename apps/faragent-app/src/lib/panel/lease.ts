/**
 * The panel's helper connection, as a lease.
 *
 * The implementation — and the invariant that keeps a released slot closeable —
 * lives in `lib/lease.ts`. This module is the panel's spelling of it, so
 * `helper-context.tsx` keeps importing "the panel lease".
 *
 * It used to be a second copy with a single `slot`: `acquire` replaced a slot
 * that still had a holder whenever the key differed, and `release` then
 * early-returned on the key mismatch — so `acquire("hA")`, `acquire("hB")`,
 * `release("hA")` closed nothing and hA's helper was leaked. The comment here
 * claimed the opposite ("a released slot whose key was replaced in the meantime
 * has no holder left and is closed by the same callback"); it described an
 * earlier arrangement of the code, not the one below it. That is the failure
 * mode worth naming: a comment asserting a guarantee the code does not provide
 * is how the next person ships the bug, and it is why this file no longer has
 * its own copy of the algorithm to drift out of step with the attach lease's.
 *
 * `PanelHelperProvider` keys it by `` `${host}#${attempt}` ``: one channel per
 * host, and a fresh one per retry, because the lease caches a rejected open
 * exactly as it caches a resolved one.
 */
export { createLease, type Lease, type Schedule } from "../lease.ts";

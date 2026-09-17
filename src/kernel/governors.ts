/**
 * Governor threads — learned threads in `root/threads/` that govern on top of
 * the structural isolation (plan.md Decision Log 2026-09-17): sole-writer
 * enforcement for the discovery store, plugin-asset gating, rate limits.
 *
 * @remarks
 * Governors are NOT the load-bearing isolation layer — structure (SQL-level
 * space scoping) isolates; threads govern. A governor is ordinary learned
 * content: it blocks at the behavioral event layer (observable in the
 * deadlock trace's candidate set), and it passes `frontier-verify` like every
 * learned thread — no special casing. A pure blocker that blocks a
 * floor-requested event deadlocks the turn and fails its own gate; the
 * relinquish path (the reconcile scan's `scan.begin`) is what makes the
 * verified form reachable.
 *
 * @packageDocumentation
 */

import type { Thread } from '../behavioral/behavioral.types.ts'

/** The reconcile scan fires this to relinquish write-policy governors. */
export const SCAN_BEGIN_EVENT = 'scan.begin'

/**
 * Discovery write-policy governor — blocks `discovery-create` /
 * `discovery-update` / `discovery-delete` calls outside the scan. The
 * reconcile scan fires {@link SCAN_BEGIN_EVENT} before its upsert window; the
 * interrupt tears the governor down (relinquish) so the scan — the sole
 * writer — can proceed.
 */
export const DISCOVERY_WRITE_GOVERNOR: Thread = {
  label: 'governor:discovery-write-policy',
  rules: [
    {
      block: [{ type: 'discovery.create' }, { type: 'discovery.update' }, { type: 'discovery.delete' }],
      interrupt: [{ type: SCAN_BEGIN_EVENT }],
    },
  ],
}

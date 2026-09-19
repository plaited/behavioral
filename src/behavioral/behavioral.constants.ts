import { keyMirror } from '../utils.ts'

/**
 * Discriminant values for the `SnapshotMessage` union.
 *
 * @remarks
 * Use the `kind` field to narrow the union:
 * - `'deadlock'` — no unblocked candidate could be selected
 * - `'frontier'` — frontier snapshot per super-step
 * - `'pending_bids'` — pending thread bids per super-step
 * - `'selection'` — event selection trace
 * - `'step'` — a super-step began; `ingress: true` marks an externally
 *   initiated step
 * - `'interrupt'` — a b-thread was terminated by a matching interrupt listener
 * - `'transform'` — a b-thread's transform listener matched; the engine
 *   evaluates the listener's jq `query` over the selected event's detail and
 *   re-enters with the result as the `target` event (in-engine, 2026-09-18)
 * - `'transform_error'` — a transform contract failed (jq error, no detail,
 *   empty or non-object output); the target never fires
 * - `'trigger_error'` — event rejected at the `trigger` ingress boundary
 * - `'add_thread_error'` — invalid thread arguments passed to `useAddThread`
 *
 * @public
 */
export const TRACE_MESSAGE_KINDS = keyMirror(
  'deadlock',
  'frontier',
  'pending_bids',
  'selection',
  'trigger_error',
  'add_thread_error',
  'thread_added',
  'interrupt',
  'transform',
  'transform_error',
  'step',
)

/**
 * Discriminant values for the scheduler-facing frontier status.
 *
 * @remarks
 * - `'ready'` — enabled candidates are available for selection
 * - `'deadlock'` — candidates exist but all are blocked
 * - `'idle'` — no candidates at all
 *
 * @public
 */
export const FRONTIER_STATUS = keyMirror('ready', 'deadlock', 'idle')

export const IDIOMS = keyMirror('waitFor', 'interrupt', 'request', 'block', 'transform')

export const WORKER_MESSAGE_KINDS = keyMirror('trigger', 'addThreads')

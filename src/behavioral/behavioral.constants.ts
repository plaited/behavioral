import { keyMirror } from '../utils.ts'

/**
 * Discriminant values for the `SnapshotMessage` union.
 *
 * @remarks
 * Use the `kind` field to narrow the union:
 * - `'deadlock'` — no unblocked candidate could be selected
 * - `'selection'` — event selection trace
 * - `'interrupt'` — a b-thread was terminated by a matching interrupt listener
 * - `'transform'` — a b-thread's transform listener matched; external code
 *   should apply the listener's `query` and emit the `target` event
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
  'interrupt',
  'transform',
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

/**
 * Contentless kick event used to start a super-step after internal re-entry
 * threads are added through `useAddThread`.
 *
 * @remarks
 * Contract: nothing ever listens for, waits on, blocks, or transforms the
 * kick; it carries no detail and no semantics. An external actor triggering it
 * is harmless by construction. `useAddThread` is inert (it does not step), so
 * re-entering code adds its once-thread, then fires this kick to advance the
 * program — preserving idle-until-trigger quiescence for pure-requesting
 * programs. The kick is priority 0 and selected first; the re-entry thread's
 * requested event follows in the next super-step as a request-origin candidate.
 *
 * @public
 */
export const KICK_EVENT_TYPE = 'bp.kick'

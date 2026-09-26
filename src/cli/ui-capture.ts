/**
 * The ui autoresearch loop's capture side — the iterate mechanism that
 * refines the ui_* producer threads by measurement, not argument.
 *
 * @remarks
 * An in-process RAW `useTrace` consumer (the eval ruling's canonical path:
 * in-process = raw; the per-consumer catch means it coexists with the
 * redacted trace lane untouched) writing ui-pipeline runs to a capture sink
 * the eval harness reads. A run is the trace slice from a `render` ingress
 * (the pipeline's generation trigger) to its `ui_render` selection — ingress
 * → preflight → generation → render.
 *
 * The Thread set rides `thread_added` for free, in two lanes: the STANDING
 * threads (the policy set — the once-thread boots are pre-run mechanics) and
 * the run's once-thread RE-ENTRIES (the transform targets and faculty
 * result re-entries), position-tagged by the message index at which each
 * arrived. The position tag is what makes prefix replay faithful: a replay
 * of the first N messages registers exactly the re-entries that existed at
 * that point — no unselectable events (the frontier's synthetic once-thread
 * reconstruction covers requesters), no phantom future candidates.
 *
 * The replay pass is `frontier_request { op: 'replay' }` over a captured
 * run — the divergence view: where requests blocked, what the frontier
 * looked like when the hold happened. Replay the full run for the end
 * state; replay a PREFIX (`uiReplayRequest(run, upTo)` — the message count,
 * e.g. up to just before the browser's scale reply) for the hold. The
 * graders are consumer-authored (the eval data-contract) — this module
 * wires the loop, nothing more.
 *
 * MINIMAL: a run closes at the `ui_render` terminus or is superseded by the
 * next `render` ingress (an incomplete hold run is captured as-is — exactly
 * the divergence-view fodder); a quiescence-based flush rides a named need.
 *
 * @packageDocumentation
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import { ueid } from '../utils.ts'
import { UI_RENDER_TRIGGER_TYPE } from './ui-threads.ts'

/**
 * One captured once-thread re-entry — the message count already seen when
 * the thread was added (the transform target's or faculty result's requester).
 */
export type UiReentry = { at: number; thread: Thread }

/**
 * Drop undefined-valued own keys — the engine's transform re-entries carry an
 * explicit `space: undefined` (root) that the replay input schema's strict
 * thread shape rejects; absent means root, the same semantics.
 */
const normalizeThread = (thread: Thread): Thread => {
  const out = { ...thread } as Record<string, unknown>
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key]
  }
  return out as Thread
}

/** One captured ui-pipeline run: the standing Thread set, the position-tagged re-entries, the run's selections. */
export type UiRun = {
  startedAt: number
  threads: Thread[]
  reentries: UiReentry[]
  messages: SelectionTrace[]
}

/**
 * The raw capture consumer — mount beside the redacted lane
 * (`runtime.useTrace(createUiCapture({ sink }))`). The sink is the eval
 * harness's own code; {@link uiCaptureFileSink} is the durable default.
 */
export const createUiCapture = ({ sink }: { sink: (run: UiRun) => void }): ((trace: Trace) => void) => {
  const threads: Thread[] = []
  let open: UiRun | null = null
  /** Once-thread re-entries seen since the last selection, while no run is open. */
  let buffered: Thread[] = []
  const flush = (): void => {
    if (open === null) return
    sink({ ...open, threads: [...threads], reentries: [...open.reentries] })
    open = null
  }
  return (trace: Trace): void => {
    if (trace.kind === TRACE_MESSAGE_KINDS.thread_added) {
      if (trace.thread.once === true) {
        // A once-thread re-entry (a transform target's or a faculty result's
        // requester). While a run is open it is position-tagged for faithful
        // prefix replay; while closed it buffers — the trigger's own
        // transform re-entries arrive BEFORE the opening selection trace
        // (the engine adds the once-thread, then traces the selection), so
        // the buffer is what backfills a run at open. Boot onces ride the
        // same buffer and are cleared by the boot's own selections.
        const thread = normalizeThread(trace.thread)
        if (open === null) buffered.push(thread)
        else open.reentries.push({ at: open.messages.length, thread })
      } else {
        threads.push(trace.thread)
      }
      return
    }
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const selected = trace.selected
    if (selected.type === UI_RENDER_TRIGGER_TYPE && selected.ingress === true) {
      // A new trigger supersedes an open run — an incomplete hold run is
      // captured as-is (the divergence view's raw material) — and the
      // buffered re-entries are this trigger's own transforms: backfill at 0.
      flush()
      open = {
        startedAt: trace.timestamp,
        threads: [],
        reentries: buffered.map((thread) => ({ at: 0, thread })),
        messages: [trace],
      }
      buffered = []
      return
    }
    if (open === null) {
      // A closed-world selection consumes whatever re-entries were pending
      // — they belong to its cascade, not to a future run.
      buffered = []
      return
    }
    open.messages.push(trace)
    if (selected.type === 'ui_render') flush()
  }
}

/**
 * The durable default sink — one JSONL line per closed run under
 * `<root>/ui-runs.jsonl` (the host passes `<home>/captures`; the same
 * root-local trust domain as the redacted trace log).
 */
export const uiCaptureFileSink = ({ root }: { root: string }): ((run: UiRun) => void) => {
  let ready = false
  return (run: UiRun): void => {
    if (!ready) {
      mkdirSync(root, { recursive: true })
      ready = true
    }
    appendFileSync(join(root, 'ui-runs.jsonl'), `${JSON.stringify(run)}\n`, 'utf8')
  }
}

/** The thread set for a replay of the first `upTo` messages: the standing set + the re-entries that existed by then. */
const replayThreads = (run: UiRun, upTo: number): Thread[] => [
  ...run.threads,
  ...run.reentries.filter((reentry) => reentry.at < upTo).map((reentry) => reentry.thread),
]

/**
 * The replay pass — build the `frontier_request { op: 'replay' }` event over
 * a captured run. The default replays the whole run (the end state); pass
 * `upTo` (a message count) to replay a PREFIX and re-derive a mid-run state
 * — e.g. the index of the browser's scale reply for the preflight hold.
 * Trigger it through the composition; the frontier lane analyses and the
 * result re-enters as a selection carrying `{ frontier, stateKey, pendingCount }`.
 */
export const uiReplayRequest = (run: UiRun, upTo = run.messages.length): BPEvent => ({
  type: FACULTY_MESSAGE_KINDS.frontier_request,
  detail: {
    id: `ui-replay-${ueid()}`,
    op: 'replay',
    // Threads are pure data (they serialize as JSON) but their listener
    // schemas aren't statically JsonValue — the same cast the composition's
    // candidate emission makes (b-program's thread-candidate precedent).
    input: {
      threads: replayThreads(run, upTo),
      messages: run.messages.slice(0, upTo),
    } as unknown as JsonObject,
  },
})

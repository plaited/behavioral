import { TRACE_MESSAGE_KINDS, WORKER_MESSAGE_KINDS } from './behavioral.constants.ts'
import type { BPEvent, JsonObject, Thread, Trace, TraceListener, Trigger } from './behavioral.types.ts'
import {
  validateResponseCancelEvent,
  validateResponseRequestEvent,
  validateResponseRequestResultEvent,
  validateToolCallEvent,
  validateToolCallResultEvent,
  validateToolCancelEvent,
} from './use-behavioral.types.ts'

/*
 * The runtime composition hook: a dumb pump between the engine worker and the
 * satellite workers, and the one wiring point every host shares — CLI, local
 * PWA, Tauri mobile each pass their own workers and threads through here.
 *
 * One communication protocol: BPEvent-shaped messages everywhere. The router
 * never repacks, never remembers, never shapes —
 * - engine selection traces carry the selected candidate; its event portion,
 *   when schema-valid, is forwarded VERBATIM to the owning satellite port
 *   (the satellites speak the event wire and validate input at their own
 *   boundaries, echoing any request `space` on the result)
 * - satellite result events re-enter the program as once-threads that request
 *   the event, so the program's own listeners pick them up
 * - a crashed satellite re-enters one `worker_error` event (errors-as-data);
 *   threads waiting on a result can waitFor [result, worker_error]
 * - the trace lane is pass-through only: traces go to the host's
 *   traceListener (useTrace consumers) and are never read for control beyond
 *   the selection payload, which IS the routing input by design
 *
 * Transforming and routing-as-shaping are program concerns (threads /
 * transforms), not router code — add them as thread libraries when consumers
 * exist.
 */

export const useBehavioral = ({
  threads,
  traceListener,
  toolsClientWorker,
  responsesClientWorker,
  frontierWorker,
  useTrigger,
}: {
  threads: Thread[]
  traceListener: TraceListener
  toolsClientWorker: Worker
  responsesClientWorker: Worker
  /** Optional satellite running the frontier analysis worker. */
  frontierWorker?: Worker
  useTrigger: (trigger: Trigger) => void
}): Worker => {
  const behavioralWorker = new Worker(new URL('./behavioral.worker.ts', import.meta.url))

  // Engine port — the {kind} envelope is behavioral.worker.ts's protocol.
  const addThreads = (newThreads: Thread[]) =>
    behavioralWorker.postMessage({ kind: WORKER_MESSAGE_KINDS.add_threads, threads: newThreads })

  // The router's only family knowledge: which port an event type routes to.
  // Tool-calling is two-level: every tool shares the `tool_call` event type, so
  // satellite tools (frontier) are discriminated by `detail.tool` and fall
  // back to the tools worker. Cancels carry only an id — they cannot be
  // attributed to a satellite tool and land on the tools port, where an
  // unknown id is a no-op (frontier analyses are synchronous and cannot be
  // canceled mid-run anyway).
  const routes: Record<string, Worker> = {
    [WORKER_MESSAGE_KINDS.response_request]: responsesClientWorker,
    [WORKER_MESSAGE_KINDS.response_cancel]: responsesClientWorker,
    [WORKER_MESSAGE_KINDS.tool_call]: toolsClientWorker,
    [WORKER_MESSAGE_KINDS.tool_cancel]: toolsClientWorker,
  }
  const toolRoutes: Record<string, Worker> = {}

  const reenter = (message: { type: string; detail: JsonObject & { id: string }; space?: string }): void => {
    addThreads([
      {
        ...(message.space === undefined ? {} : { space: message.space }),
        label: `on_${message.type}_${message.detail.id}`,
        once: true,
        rules: [{ request: { type: message.type, detail: message.detail } }],
      },
    ])
  }

  // Both tool-speaking satellites post tool_call_result events.
  const onToolCallResult = ({ data }: MessageEvent): void => {
    if (!validateToolCallResultEvent(data)) return
    reenter(data)
  }

  behavioralWorker.onmessage = async ({ data }: MessageEvent<Trace>): Promise<void> => {
    await traceListener(data)
    if (data.kind !== TRACE_MESSAGE_KINDS.selection) return
    // The selection trace carries the selected candidate; its event portion is
    // the BPEvent. The router is the trust boundary for events crossing into
    // worker processes: only schema-valid events route.
    const candidate = data.selected
    const event = { type: candidate.type, detail: candidate.detail, space: candidate.space }
    const tool = event.type === WORKER_MESSAGE_KINDS.tool_call ? (event.detail as { tool?: string }).tool : undefined
    const port = (tool === undefined ? undefined : toolRoutes[tool]) ?? routes[event.type]
    if (port === undefined) return
    if (
      !validateResponseRequestEvent(event) &&
      !validateToolCallEvent(event) &&
      !validateResponseCancelEvent(event) &&
      !validateToolCancelEvent(event)
    ) {
      return
    }
    port.postMessage(event)
  }

  responsesClientWorker.onmessage = ({ data }: MessageEvent): void => {
    if (!validateResponseRequestResultEvent(data)) return
    reenter(data)
  }

  toolsClientWorker.onmessage = onToolCallResult

  // Only the router can see a satellite crash — no thread ever could — so the
  // crash is synthesized as one worker_error event (errors-as-data).
  const onCrash =
    (workerName: string) =>
    (error: ErrorEvent): void => {
      addThreads([
        {
          label: `on_worker_error_${workerName}`,
          once: true,
          rules: [
            {
              request: {
                type: WORKER_MESSAGE_KINDS.worker_error,
                detail: { worker: workerName, message: error.message },
              },
            },
          ],
        },
      ])
    }

  responsesClientWorker.onerror = onCrash('responses-client')
  toolsClientWorker.onerror = onCrash('tools-client')

  // The frontier satellite is optional: hosts without one simply have no
  // frontier tool routes, and a frontier tool_call falls back to the tools
  // worker (which reports `invalid input` for an unknown tool name).
  if (frontierWorker !== undefined) {
    for (const tool of ['frontier-replay', 'frontier-explore', 'frontier-verify']) {
      toolRoutes[tool] = frontierWorker
    }
    frontierWorker.onmessage = onToolCallResult
    frontierWorker.onerror = onCrash('frontier')
  }

  addThreads(threads)
  useTrigger(((event: BPEvent) => {
    behavioralWorker.postMessage({ kind: WORKER_MESSAGE_KINDS.trigger, event })
  }) as Trigger)

  // The engine worker is router-owned: hosts terminate it on shutdown
  // (satellites are passed in, so hosts keep their lifecycle).
  return behavioralWorker
}

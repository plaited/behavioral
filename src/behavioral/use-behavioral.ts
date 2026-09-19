import { TRACE_MESSAGE_KINDS, WORKER_MESSAGE_KINDS } from './behavioral.constants.ts'
import type { BPEvent, JsonObject, Thread, Trace, TraceListener, Trigger } from './behavioral.types.ts'
import {
  validateFrontierRequestEvent,
  validateFrontierRequestResultEvent,
  validateResponseCancelEvent,
  validateResponseRequestEvent,
  validateResponseRequestResultEvent,
  validateStoreRequestEvent,
  validateStoreRequestResultEvent,
  validateToolCallEvent,
  validateToolCallResultEvent,
  validateToolCancelEvent,
} from './use-behavioral.types.ts'

/*
 * The runtime composition hook: a dumb pump between the engine worker and the
 * satellite worker families (responses, tools, frontier, store), and the one
 * wiring point every host shares — CLI, local
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
  workers,
  useTrigger,
}: {
  threads: Thread[]
  traceListener: TraceListener
  /** The satellite worker families keyed by family — the router holds no positional knowledge. */
  workers: {
    /** Executes shell scripts (`tool_call`). */
    tools: Worker
    /** Runs Open Responses model calls (`response_request`). */
    responses: Worker
    /** Optional: frontier analysis (`frontier_request`). */
    frontier?: Worker
    /** Optional: durable space-scoped store (`store_request`). */
    store?: Worker
  }
  useTrigger: (trigger: Trigger) => void
}): Worker => {
  const {
    tools: toolsClientWorker,
    responses: responsesClientWorker,
    frontier: frontierWorker,
    store: storeWorker,
  } = workers
  const behavioralWorker = new Worker(new URL('./behavioral.worker.ts', import.meta.url))

  // Engine port — the {kind} envelope is behavioral.worker.ts's protocol.
  const addThreads = (newThreads: Thread[]) =>
    behavioralWorker.postMessage({ kind: WORKER_MESSAGE_KINDS.add_threads, threads: newThreads })

  // The router's only family knowledge: which port an event type routes to.
  // Each worker family owns its event types (response_*, tool_*, frontier_*,
  // store_*), so routing is one lookup on the type. Cancels exist only for the
  // async families (model calls, shell runs); frontier analyses and store ops
  // are short-lived and have no cancel.
  const routes: Record<string, Worker> = {
    [WORKER_MESSAGE_KINDS.response_request]: responsesClientWorker,
    [WORKER_MESSAGE_KINDS.response_cancel]: responsesClientWorker,
    [WORKER_MESSAGE_KINDS.tool_call]: toolsClientWorker,
    [WORKER_MESSAGE_KINDS.tool_cancel]: toolsClientWorker,
  }

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

  // Satellites post their family's result event; each re-enters as a thread.
  const onToolCallResult = ({ data }: MessageEvent): void => {
    if (!validateToolCallResultEvent(data)) return
    reenter(data)
  }
  const onFrontierResult = ({ data }: MessageEvent): void => {
    if (!validateFrontierRequestResultEvent(data)) return
    reenter(data)
  }
  const onStoreResult = ({ data }: MessageEvent): void => {
    if (!validateStoreRequestResultEvent(data)) return
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
    const port = routes[event.type]
    if (port === undefined) return
    if (
      !validateResponseRequestEvent(event) &&
      !validateToolCallEvent(event) &&
      !validateResponseCancelEvent(event) &&
      !validateToolCancelEvent(event) &&
      !validateFrontierRequestEvent(event) &&
      !validateStoreRequestEvent(event)
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

  responsesClientWorker.onerror = onCrash('responses')
  toolsClientWorker.onerror = onCrash('tools')

  // Optional families: hosts without one simply have no route for that
  // family's events, and the requesting thread waits — a program should not
  // request events it did not wire a worker for, same as any unknown type.
  if (frontierWorker !== undefined) {
    routes[WORKER_MESSAGE_KINDS.frontier_request] = frontierWorker
    frontierWorker.onmessage = onFrontierResult
    frontierWorker.onerror = onCrash('frontier')
  }
  if (storeWorker !== undefined) {
    routes[WORKER_MESSAGE_KINDS.store_request] = storeWorker
    storeWorker.onmessage = onStoreResult
    storeWorker.onerror = onCrash('store')
  }

  addThreads(threads)
  useTrigger(((event: BPEvent) => {
    behavioralWorker.postMessage({ kind: WORKER_MESSAGE_KINDS.trigger, event })
  }) as Trigger)

  // The engine worker is router-owned: hosts terminate it on shutdown
  // (satellites are passed in, so hosts keep their lifecycle).
  return behavioralWorker
}

import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { BPEvent, Thread, Trace, TraceListener, Trigger } from '../behavioral/behavioral.types.ts'
import { mcpThreads } from './mcp.threads.ts'
import { shellThreads } from './shell.threads.ts'
import { useWorker } from './use-worker.ts'
import { WORKER_MESSAGE_KINDS } from './workers.constants.ts'
import {
  validateFrontierRequestEvent,
  validateFrontierRequestResultEvent,
  validateMcpCancelEvent,
  validateMcpRequestEvent,
  validateMcpRequestResultEvent,
  validateResponseCancelEvent,
  validateResponseRequestEvent,
  validateResponseRequestResultEvent,
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateShellRequestResultEvent,
  validateStoreRequestEvent,
  validateStoreRequestResultEvent,
} from './workers.types.ts'

/*
 * The runtime composition hook: spawns EVERY family itself and pumps events
 * between the engine worker and the satellites. The host wires only ingress
 * (useTrigger) and observation (traceListener); configuration flows through
 * env-data (MODEL_ENDPOINTS; STORE_DB_PATH_KEY — :memory: by default,
 * durable by env var; MCP_BROKER_*).
 *
 * Families:
 * - engine — router-owned, always on (the agent itself)
 * - frontier — router-owned, always on (the verification mirror; zero
 *   deployment knobs)
 * - shell / responses / store / mcp — default-on, pruned by the `workers`
 *   allow-list: UNSET = all on; SET = only the named families spawn. A
 *   pruned family has no route and no thread pack — requesting threads
 *   simply wait (the documented no-route behavior).
 *
 * Thread packs are family-shipped and mount only when every family they
 * drive is on (the shell pack needs shell + store; the mcp spine needs
 * mcp + store). `workers: []` = the maximally-pruned agent: engine +
 * frontier, a pure reasoning + self-verification loop.
 *
 * `shell` is the one instance-level override: the pre-curried useWorker
 * return (a function awaiting addThreads/space) for a host-constructed
 * shell family — the sandboxed-shell seam. The host owns that Worker's
 * lifecycle; the default construction is identical.
 *
 * One communication protocol: BPEvent-shaped messages everywhere. The
 * router never repacks, never remembers, never shapes — selection traces
 * carry the selected candidate; its event portion, when it passes the
 * owning family's own gate (type-const discrimination means an event can
 * only satisfy its family's schema), is forwarded VERBATIM to the family
 * port; satellite result events re-enter as once-threads; a crash
 * re-enters one worker_error event (errors-as-data).
 */

/** The selectable worker families (engine and frontier are never selectable — always on). */
export type WorkerFamily = 'shell' | 'responses' | 'store' | 'mcp'

export const useBehavioral = ({
  traceListener,
  useTrigger,
  workers,
  shell: shellOverride,
  store: storeOverride,
}: {
  traceListener: TraceListener
  useTrigger: (trigger: Trigger) => void
  /** Allow-list: unset = all default families on; set = only the named families spawn. */
  workers?: WorkerFamily[]
  /**
   * The shell family override: the pre-curried useWorker return (awaiting
   * addThreads/space) for a host-constructed shell family — e.g. a sandboxed
   * spawn. The host owns that Worker's lifecycle.
   */
  shell?: ReturnType<typeof useWorker>
  /**
   * The store family override: the pre-curried useWorker return for a
   * host-constructed store family — e.g. a durable db path where the default
   * is :memory:. The host owns that Worker's lifecycle.
   */
  store?: ReturnType<typeof useWorker>
}): Worker => {
  const enabled = new Set<WorkerFamily>(workers === undefined ? ['shell', 'responses', 'store', 'mcp'] : workers)
  const has = (family: WorkerFamily): boolean => enabled.has(family)

  const behavioralWorker = new Worker(new URL('./behavioral.worker.ts', import.meta.url))

  // Engine port — the {kind} envelope is behavioral.worker.ts's protocol.
  const addThreads = (newThreads: Thread[]) =>
    behavioralWorker.postMessage({ kind: WORKER_MESSAGE_KINDS.add_threads, threads: newThreads })

  // ── Family wiring: every default family through the primitive ──────────

  // Frontier — router-owned, always on. No cancel (analyses are synchronous);
  // no thread pack (pure analysis; consumers request it).
  const frontier = useWorker({
    worker: new Worker(new URL('./frontier.worker.ts', import.meta.url)),
    name: 'frontier',
    threads: [],
    validateRequestEvent: validateFrontierRequestEvent,
    validateEventCancel: validateFrontierRequestEvent, // no cancel event exists; the request schema is the gate
    validateResultEvent: validateFrontierRequestResultEvent,
  })(addThreads)

  // The shell family: a host override (pre-curried useWorker return) is
  // invoked with OUR addThreads — the host never touches the engine port; a
  // default construction runs otherwise. The pack requires shell + store —
  // the selector gates the mount; a pruned shell still routes but mounts no
  // pack.
  const shell =
    shellOverride === undefined
      ? useWorker({
          worker: new Worker(new URL('./shell.worker.ts', import.meta.url)),
          name: 'shell',
          threads: has('shell') && has('store') ? shellThreads : [],
          validateRequestEvent: validateShellRequestEvent,
          validateEventCancel: validateShellCancelEvent,
          validateResultEvent: validateShellRequestResultEvent,
        })(addThreads)
      : shellOverride(addThreads)

  const responses = useWorker({
    worker: new Worker(new URL('./responses-client.worker.ts', import.meta.url)),
    name: 'responses',
    threads: [],
    validateRequestEvent: validateResponseRequestEvent,
    validateEventCancel: validateResponseCancelEvent,
    validateResultEvent: validateResponseRequestResultEvent,
  })(addThreads)

  // The store family: a host override is invoked with OUR addThreads (the
  // durable-db seam — the default is :memory: via env-data); the default
  // construction runs otherwise.
  const store =
    storeOverride === undefined
      ? useWorker({
          worker: new Worker(new URL('./store.worker.ts', import.meta.url)),
          name: 'store',
          threads: [],
          validateRequestEvent: validateStoreRequestEvent,
          validateEventCancel: validateStoreRequestEvent, // no cancel; the request schema is the gate
          validateResultEvent: validateStoreRequestResultEvent,
        })(addThreads)
      : storeOverride(addThreads)

  const mcp = useWorker({
    worker: new Worker(new URL('./mcp-client.worker.ts', import.meta.url)),
    name: 'mcp',
    // The spine requires mcp + store.
    threads: has('mcp') && has('store') ? mcpThreads : [],
    validateRequestEvent: validateMcpRequestEvent,
    validateEventCancel: validateMcpCancelEvent,
    validateResultEvent: validateMcpRequestResultEvent,
  })(addThreads)

  // ── Routing: event type → family port (the only family knowledge) ──────

  // Each family product carries its port and its own gate; routing is one
  // lookup on the event type, and the owning family's gate decides
  // validity (type-const discrimination: an event can only satisfy its own
  // family's schema — the per-family boundary replaces any union chain).
  type FamilyPort = { port: Worker; gate: (event: unknown) => boolean }

  const families: Record<string, FamilyPort> = {}
  const route = (types: string[], family: { port: Worker; gate: (event: unknown) => boolean }): void => {
    for (const type of types) families[type] = family
  }

  route([WORKER_MESSAGE_KINDS.shell_request, WORKER_MESSAGE_KINDS.shell_cancel], {
    port: shell.port,
    gate: shell.invalidEventGate as (event: unknown) => boolean,
  })
  if (has('responses')) {
    route([WORKER_MESSAGE_KINDS.response_request, WORKER_MESSAGE_KINDS.response_cancel], {
      port: responses.port,
      gate: responses.invalidEventGate as (event: unknown) => boolean,
    })
  }
  route([WORKER_MESSAGE_KINDS.frontier_request], {
    port: frontier.port,
    gate: frontier.invalidEventGate as (event: unknown) => boolean,
  })
  if (has('store')) {
    route([WORKER_MESSAGE_KINDS.store_request], {
      port: store.port,
      gate: store.invalidEventGate as (event: unknown) => boolean,
    })
  }
  if (has('mcp')) {
    route([WORKER_MESSAGE_KINDS.mcp_request, WORKER_MESSAGE_KINDS.mcp_cancel], {
      port: mcp.port,
      gate: mcp.invalidEventGate as (event: unknown) => boolean,
    })
  }

  // ── Engine pump: traces out, schema-valid events to their family ports ──

  behavioralWorker.onmessage = async ({ data }: MessageEvent<Trace>): Promise<void> => {
    await traceListener(data)
    if (data.kind !== TRACE_MESSAGE_KINDS.selection) return
    const candidate = data.selected
    const event = { type: candidate.type, detail: candidate.detail, space: candidate.space }
    const family = families[event.type]
    if (family === undefined) return
    // The trust boundary for events crossing into worker processes: only
    // events passing the owning family's own gate route.
    if (family.gate(event)) return
    family.port.postMessage(event)
  }

  // Host ingress: useTrigger posts one external event through the engine.
  useTrigger(((event: BPEvent) => {
    behavioralWorker.postMessage({ kind: WORKER_MESSAGE_KINDS.trigger, event })
  }) as Trigger)

  // The engine worker is router-owned: hosts terminate it on shutdown. The
  // satellite workers (including a host-constructed shell) terminate with it
  // when process lifetime ends — cold-per-turn is the default posture.
  return behavioralWorker
}

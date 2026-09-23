import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import { behavioral } from '../behavioral/behavioral.ts'
import type { BPEvent, Thread, Trace, TraceListener, Trigger } from '../behavioral/behavioral.types.ts'
import { BEHAVIOR_MESSAGE_KINDS } from './behaviors.constants.ts'
import {
  validateFrontierRequestEvent,
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
} from './behaviors.types.ts'
import { handleFrontierMessage } from './frontier.behavior.ts'
import { mcpThreads } from './mcp.threads.ts'
import { bindEmit } from './process-lane.ts'
import { shellThreads } from './shell.threads.ts'
import { useProcess } from './use-process.ts'

/*
 * The runtime composition — IN-PROCESS. The engine is behavioral() in the
 * host's main thread: addThread/trigger/step called directly, traces through
 * useTrace with zero postMessage hops (the engine-never-awaits invariant is
 * what makes this safe on the main thread). Frontier is the in-process embed:
 * its analysis dispatch is imported and driven directly, its emit lane bound
 * to the composition's reenter. The four capability families (shell, store,
 * responses, mcp) are Bun.spawn PROCESSES speaking the unchanged wire over
 * stdio lines — per-space isolatable, abort-able, head-of-line-free — wired
 * by the useProcess primitive.
 *
 * The in-process re-entry law: addThread alone is inert — every re-entry
 * (satellite results, crash synthesis, pack mounts) pumps one super-step.
 * This was the engine transport's trailing step; it is the composition's
 * now.
 *
 * `behaviors` is the allow-list (unset = all four behaviors on); `shell` and
 * `store` are the two instance overrides — pre-curried useProcess returns
 * for host-constructed families (sandboxed shell, durable store); the host
 * owns those processes' lifecycles.
 */

/** The selectable worker families (engine and frontier are never selectable — always on). */
export type Behavior = 'shell' | 'responses' | 'store' | 'mcp'

/** The in-process frontier embed family: the dispatch driven directly, emit bound to reenter. */
const frontierFamily = (
  addThreads: (threads: Thread[]) => void,
): {
  send: (event: BPEvent) => void
  gate: (event: BPEvent) => boolean
} => {
  const wire = (event: {
    type: string
    detail: import('../behavioral/behavioral.types.ts').JsonObject & { id: string }
    space?: string
  }): void => {
    addThreads([
      {
        ...(event.space === undefined ? {} : { space: event.space }),
        label: `on_${event.type}_${event.detail.id}`,
        once: true,
        rules: [{ request: { type: event.type, detail: event.detail } }],
      },
    ])
  }
  bindEmit((emitted) => wire(emitted as never))
  return {
    send: (event: BPEvent): void => {
      if (validateFrontierRequestEvent(event)) handleFrontierMessage(event)
    },
    gate: (event: BPEvent): boolean => !validateFrontierRequestEvent(event),
  }
}

export const useBehavioral = ({
  traceListener,
  useTrigger,
  behaviors,
  shell: shellOverride,
  store: storeOverride,
}: {
  traceListener: TraceListener
  useTrigger: (trigger: Trigger) => void
  /** Allow-list: unset = all default behaviors on; set = only the named behaviors spawn. */
  behaviors?: Behavior[]
  /** The shell family override: a pre-curried useProcess return (sandboxed shell). */
  shell?: ReturnType<typeof useProcess>
  /** The store family override: a pre-curried useProcess return (durable store). */
  store?: ReturnType<typeof useProcess>
}) => {
  const enabled = new Set<Behavior>(behaviors === undefined ? ['shell', 'responses', 'store', 'mcp'] : behaviors)
  const has = (family: Behavior): boolean => enabled.has(family)

  // ── The engine, in-process ────────────────────────────────────────────────

  const program = behavioral()

  /** The in-process re-entry law: addThread + the trailing step. */
  const addThreads = (threads: Thread[]): void => {
    for (const thread of threads) program.addThread(thread)
    program.step()
  }

  // Boot-order law: pack mounts (and any family construction's thread
  // additions) are DEFERRED until the pump is subscribed and the routes are
  // registered — the Worker world got this for free (the engine subscribed at
  // spawn, before any add_threads); in-process, the first step's selections
  // would land on a pump that doesn't route yet. RE-ENTRIES (satellite
  // results, crash synthesis) go live immediately after the flush.
  const pendingThreads: Thread[] = []
  let mounting = true
  const familyAddThreads = (threads: Thread[]): void => {
    if (mounting) pendingThreads.push(...threads)
    else addThreads(threads)
  }

  // ── Family wiring: frontier in-process; four families as processes ───────

  const frontier = frontierFamily(familyAddThreads)

  // The shell family: a host override (pre-curried useProcess return) is
  // invoked with OUR addThreads — the host never touches the program port;
  // a default construction runs otherwise. The pack requires shell + store —
  // the selector gates the mount; a pruned shell still routes but mounts no
  // pack.
  const shell =
    shellOverride === undefined
      ? useProcess({
          command: ['bun', 'run', 'shell.behavior.ts'],
          name: 'shell',
          threads: has('shell') && has('store') ? shellThreads : [],
          validateRequestEvent: validateShellRequestEvent,
          validateEventCancel: validateShellCancelEvent,
          validateResultEvent: validateShellRequestResultEvent,
        })(familyAddThreads)
      : shellOverride(familyAddThreads)

  const responses = useProcess({
    command: ['bun', 'run', 'responses-client.behavior.ts'],
    name: 'responses',
    threads: [],
    validateRequestEvent: validateResponseRequestEvent,
    validateEventCancel: validateResponseCancelEvent,
    validateResultEvent: validateResponseRequestResultEvent,
  })(familyAddThreads)

  // The store family: a host override is invoked with OUR addThreads (the
  // durable-db seam — the default is :memory: via env-data); the default
  // construction runs otherwise.
  const store =
    storeOverride === undefined
      ? useProcess({
          command: ['bun', 'run', 'store.behavior.ts'],
          name: 'store',
          threads: [],
          validateRequestEvent: validateStoreRequestEvent,
          validateEventCancel: validateStoreRequestEvent, // no cancel; the request schema is the gate
          validateResultEvent: validateStoreRequestResultEvent,
        })(familyAddThreads)
      : storeOverride(familyAddThreads)

  const mcp = useProcess({
    command: ['bun', 'run', 'mcp-client.behavior.ts'],
    name: 'mcp',
    // The spine requires mcp + store.
    threads: has('mcp') && has('store') ? mcpThreads : [],
    validateRequestEvent: validateMcpRequestEvent,
    validateEventCancel: validateMcpCancelEvent,
    validateResultEvent: validateMcpRequestResultEvent,
  })(familyAddThreads)

  // ── Routing: event type → family lane (the only family knowledge) ────────

  type FamilyPort = { send: (event: BPEvent) => void; gate: (event: BPEvent) => boolean }
  const families: Record<string, FamilyPort> = {}
  const route = (types: string[], family: FamilyPort): void => {
    for (const type of types) families[type] = family
  }

  route([BEHAVIOR_MESSAGE_KINDS.shell_request, BEHAVIOR_MESSAGE_KINDS.shell_cancel], {
    send: (event: BPEvent): void => shell.send(event),
    gate: (event: BPEvent): boolean => shell.invalidEventGate(event),
  })
  if (has('responses')) {
    route([BEHAVIOR_MESSAGE_KINDS.response_request, BEHAVIOR_MESSAGE_KINDS.response_cancel], {
      send: (event: BPEvent): void => responses.send(event),
      gate: (event: BPEvent): boolean => responses.invalidEventGate(event),
    })
  }
  route([BEHAVIOR_MESSAGE_KINDS.frontier_request], { send: frontier.send, gate: frontier.gate })
  if (has('store')) {
    route([BEHAVIOR_MESSAGE_KINDS.store_request], {
      send: (event: BPEvent): void => store.send(event),
      gate: (event: BPEvent): boolean => store.invalidEventGate(event),
    })
  }
  if (has('mcp')) {
    route([BEHAVIOR_MESSAGE_KINDS.mcp_request, BEHAVIOR_MESSAGE_KINDS.mcp_cancel], {
      send: (event: BPEvent): void => mcp.send(event),
      gate: (event: BPEvent): boolean => mcp.invalidEventGate(event),
    })
  }

  // ── The engine pump: traces out, gated events to their family lanes ─────

  program.useTrace((trace: Trace) => {
    void traceListener(trace)
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const candidate = (trace as import('../behavioral/behavioral.types.ts').SelectionTrace).selected
    const event = { type: candidate.type, detail: candidate.detail, space: candidate.space } as BPEvent
    const family = families[event.type]
    if (family === undefined) return
    // The trust boundary for events crossing into family processes: only
    // events passing the owning family's own gate route.
    if (family.gate(event)) return
    family.send(event)
  })

  // The deferred mounts flush now — pump subscribed, routes registered: the
  // boot cascade (scan boots → shell_requests → family processes) runs in a
  // world that can route it. Re-entries go live from here on.
  mounting = false
  addThreads(pendingThreads)

  // Host ingress: useTrigger admits one external event through the program.
  useTrigger(((event: BPEvent) => {
    program.trigger(event)
  }) as Trigger)

  // ── The runtime handle ────────────────────────────────────────────────────

  // Hosts terminate what the composition spawned. Host-provided overrides
  // (shell/store processes) are NOT terminated here — the host owns those
  // (the override ruling's lifecycle half). The engine and frontier are
  // in-process: nothing to terminate, they end with the host process.
  return {
    program,
    terminate: (): void => {
      bindEmit(null)
      if (shellOverride === undefined) shell.terminate()
      responses.terminate()
      if (storeOverride === undefined) store.terminate()
      mcp.terminate()
    },
  }
}

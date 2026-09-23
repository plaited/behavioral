import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import { behavioral } from '../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../behavioral/behavioral.types.ts'
import { BEHAVIOR_MESSAGE_KINDS } from '../behaviors/behaviors.constants.ts'
import { behaviorsThreads, eventGuardEntries, guardThreads } from '../behaviors/behaviors.threads.ts'
import {
  McpCancelEventSchema,
  McpRequestEventSchema,
  McpRequestResultEventSchema,
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
  StoreRequestEventSchema,
  StoreRequestResultEventSchema,
  validateFrontierRequestEvent,
} from '../behaviors/behaviors.types.ts'
import { handleFrontierMessage } from '../behaviors/frontier.behavior.ts'
import { mcpThreads } from '../behaviors/mcp-client.threads.ts'
import { bindEmit } from '../behaviors/process-lane.ts'
import { shellThreads } from '../behaviors/shell.threads.ts'
import { useBehavior } from '../behaviors/use-behavior.ts'
import type { Behavior } from '../behaviors.ts'

/*
 * The runtime composition — IN-PROCESS. The engine is behavioral() in the
 * host's main thread: addThread/trigger/step called directly, traces through
 * useTrace with zero postMessage hops (the engine-never-awaits invariant is
 * what makes this safe on the main thread). Frontier is the in-process embed:
 * its analysis dispatch is imported and driven directly, its emit lane bound
 * to the composition's reenter. The capability families — shell, store, and
 * mcp as default processes; system One/Two as endpoint-carrying overrides —
 * are Bun.spawn PROCESSES speaking the unchanged wire over stdio lines —
 * per-space isolatable, abort-able, head-of-line-free — wired by the useBehavior
 * primitive.
 *
 * The in-process re-entry law: addThread alone is inert — every re-entry
 * (satellite results, crash synthesis, pack mounts) pumps one super-step.
 * This was the engine transport's trailing step; it is the composition's
 * now.
 *
 * `behaviors` is the allow-list (unset = shell/store/mcp on); `shell` and
 * `store` are the two default-family instance overrides, and `systemTwo` (and
 * later `systemOne`) is an endpoint-carrying override with no default — all
 * pre-curried useBehavior returns for host-constructed families.
 * for host-constructed families (sandboxed shell, durable store). The
 * composition invokes every factory and owns the resulting process
 * lifecycles, overrides included (the host hands over a factory, not a
 * handle).
 *
 * The lifecycle is explicit: construction wires the engine, families, and
 * routes but does NOT flush the deferred pack mounts. The host subscribes
 * (`runtime.useTrace`) first, then calls `runtime.start()` — the boot
 * cascade runs after subscribers attach, so boot traces are observable.
 * `runtime.trigger` admits events only; start/terminate are the host's
 * lifecycle, never the event lane's.
 */

/** The in-process frontier embed family: the dispatch driven directly, emit bound to reenter. */
const frontierFamily = (
  addThreads: (threads: Thread[]) => void,
): {
  send: (event: BPEvent) => void
  gate: (event: BPEvent) => boolean
} => {
  const wire = (event: { type: string; detail: JsonObject & { id: string }; space?: string }): void => {
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

export const bProgram = ({
  behaviors,
  shell: shellOverride,
  store: storeOverride,
  systemOne: systemOneOverride,
  systemTwo: systemTwoOverride,
}: {
  /** Allow-list: unset = all default behaviors on; set = only the named behaviors spawn. */
  behaviors?: Behavior[]
  /** The shell family override: a pre-curried useBehavior return (sandboxed shell). */
  shell?: ReturnType<typeof useBehavior>
  /** The store family override: a pre-curried useBehavior return (durable store). */
  store?: ReturnType<typeof useBehavior>
  /**
   * The System One family override (e.g. `useSystemOne({ endpoint })`). No
   * default: with no override the family carries no endpoint, so it is simply
   * absent — no process, no route.
   */
  systemOne?: ReturnType<typeof useBehavior>
  /**
   * The System Two family override (e.g. `useSystemTwo({ endpoints })`). No
   * default: with no override the family carries no endpoint, so it is simply
   * absent — no process, no route.
   */
  systemTwo?: ReturnType<typeof useBehavior>
}) => {
  const enabled = new Set<Behavior>(behaviors === undefined ? ['shell', 'store', 'mcp'] : behaviors)
  const has = (family: Behavior): boolean => enabled.has(family)

  // ── The engine, in-process ────────────────────────────────────────────────

  const { addThread, step, trigger, useTrace } = behavioral()

  /** The in-process re-entry law: addThread + the trailing step. */
  const addThreads = (threads: Thread[]): void => {
    for (const thread of threads) addThread(thread)
    step()
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

  // The shell family: a host override (pre-curried useBehavior return) is
  // invoked with OUR addThreads — the host never touches the program port;
  // a default construction runs otherwise. The pack requires shell + store —
  // the selector gates the mount; a pruned shell still routes but mounts no
  // pack.
  const shell =
    shellOverride === undefined
      ? useBehavior({
          command: ['bun', 'run', 'shell.behavior.ts'],
          name: 'shell',
          threads: has('shell') && has('store') ? shellThreads : [],
          requestSchema: ShellRequestEventSchema,
          cancelSchema: ShellCancelEventSchema,
          resultSchema: ShellRequestResultEventSchema,
        })(familyAddThreads)
      : shellOverride(familyAddThreads)

  // The system families: no default. A host override (a config helper
  // return — `useSystemTwo({ endpoints })`) carries the endpoint it needs;
  // without one the family is simply absent.
  const systemOne = systemOneOverride?.(familyAddThreads)
  const systemTwo = systemTwoOverride?.(familyAddThreads)

  // The store family: a host override is invoked with OUR addThreads (the
  // durable-db seam — the default is :memory: via env-data); the default
  // construction runs otherwise.
  const store =
    storeOverride === undefined
      ? useBehavior({
          command: ['bun', 'run', 'store.behavior.ts'],
          name: 'store',
          threads: [],
          requestSchema: StoreRequestEventSchema,
          cancelSchema: StoreRequestEventSchema, // no cancel; the request schema is the gate
          resultSchema: StoreRequestResultEventSchema,
        })(familyAddThreads)
      : storeOverride(familyAddThreads)

  const mcp = useBehavior({
    command: ['bun', 'run', 'mcp-client.behavior.ts'],
    name: 'mcp',
    // The spine requires mcp + store.
    threads: has('mcp') && has('store') ? mcpThreads : [],
    requestSchema: McpRequestEventSchema,
    cancelSchema: McpCancelEventSchema,
    resultSchema: McpRequestResultEventSchema,
  })(familyAddThreads)

  // ── Routing: event type → family lane (the only family knowledge) ────────

  // The root guard pack is always mounted, independent of the allow-list.
  familyAddThreads(behaviorsThreads)

  type FamilyPort = { send: (event: BPEvent) => void; gate: (event: BPEvent) => boolean }
  const families: Record<string, FamilyPort> = {}
  const route = (types: string[], family: FamilyPort): void => {
    for (const type of types) families[type] = family
  }

  route([BEHAVIOR_MESSAGE_KINDS.shell_request, BEHAVIOR_MESSAGE_KINDS.shell_cancel], {
    send: (event: BPEvent): void => shell.send(event),
    gate: (event: BPEvent): boolean => shell.invalidEventGate(event),
  })
  if (systemOne !== undefined) {
    // The family's request/cancel/result guard derives from the same schemas
    // useBehavior compiled — a malformed system_one event is blocked (visible
    // in the frontier traces), not silently dropped.
    familyAddThreads(guardThreads(`guard:${systemOne.name}-schema`, eventGuardEntries(systemOne.schemas)))
    route([BEHAVIOR_MESSAGE_KINDS.system_one_request, BEHAVIOR_MESSAGE_KINDS.system_one_cancel], {
      send: (event: BPEvent): void => systemOne.send(event),
      gate: (event: BPEvent): boolean => systemOne.invalidEventGate(event),
    })
  }
  if (systemTwo !== undefined) {
    // The family's request/cancel/result guard derives from the same schemas
    // useBehavior compiled — a malformed system_two event is blocked (visible
    // in the frontier traces), not silently dropped.
    familyAddThreads(guardThreads(`guard:${systemTwo.name}-schema`, eventGuardEntries(systemTwo.schemas)))
    route([BEHAVIOR_MESSAGE_KINDS.system_two_request, BEHAVIOR_MESSAGE_KINDS.system_two_cancel], {
      send: (event: BPEvent): void => systemTwo.send(event),
      gate: (event: BPEvent): boolean => systemTwo.invalidEventGate(event),
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

  useTrace((trace: Trace) => {
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const candidate = (trace as SelectionTrace).selected
    const event = { type: candidate.type, detail: candidate.detail, space: candidate.space } as BPEvent
    const family = families[event.type]
    if (family === undefined) return
    // The trust boundary for events crossing into family processes: only
    // events passing the owning family's own gate route.
    if (family.gate(event)) return
    family.send(event)
  })

  // ── The explicit start: flush the deferred pack mounts ────────────────

  // Construction wires the pump and routes but does not flush. The host
  // subscribes (useTrace) FIRST, then calls start() — the boot cascade
  // (scan boots → shell_requests → family processes) runs in a world whose
  // subscribers are attached, so boot traces are observable. Idempotent;
  // start/terminate are the host's lifecycle, never the event lane's.
  let started = false
  const start = (): void => {
    if (started) return
    started = true
    mounting = false
    addThreads(pendingThreads)
  }

  // ── The runtime handle ────────────────────────────────────────────────────

  // The composition owns every family process it invoked — overrides
  // included: the host hands over a curried factory, the composition holds
  // the only `terminate` handle. (The engine and frontier are in-process:
  // nothing to terminate, they end with the host process.)
  return {
    trigger,
    useTrace,
    start,
    terminate: (): void => {
      bindEmit(null)
      shell.terminate()
      store.terminate()
      mcp.terminate()
      systemOne?.terminate()
      systemTwo?.terminate()
    },
  }
}

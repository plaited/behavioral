import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import { behavioral } from '../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../behavioral/behavioral.types.ts'
import { validateThread } from '../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'
import { eventGuardEntries, facultiesThreads, guardThreads } from '../faculties/faculties.threads.ts'
import {
  SecurityCancelEventSchema,
  SecurityRequestEventSchema,
  SecurityRequestResultEventSchema,
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
  StoreRequestEventSchema,
  StoreRequestResultEventSchema,
  validateFrontierRequestEvent,
} from '../faculties/faculties.types.ts'
import { handleFrontierMessage } from '../faculties/frontier/faculty.ts'
import { admissionAnalysisInput, admissionReviewThreads } from '../faculties/frontier/threads.ts'
import { bindEmit } from '../faculties/process-lane.ts'
import { remoteMcpThreads } from '../faculties/shell/remote-mcp.threads.ts'
import { rpcAuthThreads } from '../faculties/shell/rpc-auth.threads.ts'
import { shellThreads } from '../faculties/shell/threads.ts'
import {
  ADMISSION_EVENT_TYPES,
  admissionJudgmentThreads,
  supervisionJudgmentThreads,
  supervisionThreads,
  validateAdmissionVerdict,
} from '../faculties/system-one/threads.ts'
import { useFaculty } from '../faculties/use-faculty.ts'
import type { Faculty } from '../faculties.ts'

/*
 * The runtime composition — IN-PROCESS. The engine is behavioral() in the
 * host's main thread: addThread/trigger/step called directly, traces through
 * useTrace with zero postMessage hops (the engine-never-awaits invariant is
 * what makes this safe on the main thread). Frontier is the in-process embed:
 * its analysis dispatch is imported and driven directly, its emit lane bound
 * to the composition's reenter. The capability faculties — shell, store, and
 * security as default processes; system One/Two as endpoint-carrying overrides —
 * are Bun.spawn PROCESSES speaking the unchanged wire over stdio lines —
 * per-space isolatable, abort-able, head-of-line-free — wired by the useFaculty
 * primitive.
 *
 * The in-process re-entry law: addThread alone is inert — every re-entry
 * (satellite results, crash synthesis, thread mounts) pumps one super-step.
 * This was the engine transport's trailing step; it is the composition's
 * now.
 *
 * `faculties` is the allow-list (unset = shell/store/security on); `shell` and
 * `store` are the two default-faculty instance overrides (sandboxed shell,
 * durable store), and `systemOne`/`systemTwo` are endpoint-carrying overrides
 * with no default — all pre-curried useFaculty returns for host-constructed
 * faculties. The composition invokes every factory and owns the resulting
 * process lifecycles, overrides included (the host hands over a factory, not a
 * handle).
 *
 * The lifecycle is explicit: construction wires the engine, faculties, and
 * routes but does NOT flush the deferred thread mounts. The host subscribes
 * (`runtime.useTrace`) first, then calls `runtime.start()` — the boot
 * cascade runs after subscribers attach, so boot traces are observable.
 * `runtime.trigger` admits events only; start/terminate are the host's
 * lifecycle, never the event lane's.
 */

/** The in-process frontier embed faculty: the dispatch driven directly, emit bound to reenter. */
const frontierFaculty = (
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
  faculties,
  shell: shellOverride,
  store: storeOverride,
  security: securityOverride,
  systemOne: systemOneOverride,
  systemTwo: systemTwoOverride,
  supervision,
}: {
  /** Allow-list: unset = all default faculties on; set = only the named faculties spawn. */
  faculties?: Faculty[]
  /** The shell faculty override: a pre-curried useFaculty return (sandboxed shell). */
  shell?: ReturnType<typeof useFaculty>
  /** The store faculty override: a pre-curried useFaculty return (durable store). */
  store?: ReturnType<typeof useFaculty>
  /**
   * The security faculty override: a pre-curried useFaculty return carrying
   * env-data (the broker binding — spawned children see STARTUP env only, so
   * hosts binding the broker mid-process pass it explicitly here).
   */
  security?: ReturnType<typeof useFaculty>
  /**
   * The System One faculty override (e.g. `useSystemOne({ endpoint })`). No
   * default: with no override the faculty carries no endpoint, so it is simply
   * absent — no process, no route.
   */
  systemOne?: ReturnType<typeof useFaculty>
  /**
   * The System Two faculty override (e.g. `useSystemTwo({ endpoints })`). No
   * default: with no override the faculty carries no endpoint, so it is simply
   * absent — no process, no route.
   */
  systemTwo?: ReturnType<typeof useFaculty>
  /**
   * The runtime supervision config: the watch list (event types the counting
   * breaker supervises) and an optional threshold (default 4096, under the
   * ~8.6k cascade overflow). Mounts only with systemOne (the trip's judgment
   * requires the Decisions lane) and only when the host names watched types —
   * v1 watches what the composition is told to, no auto-discovery. Fail-
   * visible: on judge unavailability the block holds and `supervision_halted`
   * surfaces the unjudged halt.
   */
  supervision?: { watch: string[]; threshold?: number }
}) => {
  const enabled = new Set<Faculty>(faculties === undefined ? ['shell', 'store', 'security'] : faculties)
  const has = (faculty: Faculty): boolean => enabled.has(faculty)

  // ── The engine, in-process ────────────────────────────────────────────────

  const { addThread, step, trigger, useTrace, instanceId } = behavioral()
  /**
   * The identity handoff: the engine's self-minted per-process id, with the
   * resolved session id. The composition supplies no host session id today,
   * so the engine's `sessionId ?? instanceId` default makes the two equal —
   * when a host session id reaches this composition it must flow into
   * `behavioral({ sessionId })` AND into this pair (one home for the id
   * handshake).
   */
  const identity = { instanceId, sessionId: instanceId }

  /** The in-process re-entry law: addThread + the trailing step. */
  const addThreads = (threads: Thread[]): void => {
    for (const thread of threads) addThread(thread)
    step()
  }

  // Boot-order law: thread mounts (and any faculty construction's thread
  // additions) are DEFERRED until the pump is subscribed and the routes are
  // registered — the Worker world got this for free (the engine subscribed at
  // spawn, before any add_threads); in-process, the first step's selections
  // would land on a pump that doesn't route yet. RE-ENTRIES (satellite
  // results, crash synthesis) go live immediately after the flush.
  const pendingThreads: Thread[] = []
  let mounting = true
  const facultyAddThreads = (threads: Thread[]): void => {
    if (mounting) pendingThreads.push(...threads)
    else addThreads(threads)
  }

  // ── Faculty wiring: frontier in-process; four faculties as processes ───────

  const frontier = frontierFaculty(facultyAddThreads)

  // The shell faculty: a host override (pre-curried useFaculty return) is
  // invoked with OUR addThreads — the host never touches the program port;
  // a default construction runs otherwise. The threads require shell + store —
  // the selector gates the mount; a pruned shell has no route and mounts
  // none, like every other allow-listed faculty.
  const shell =
    shellOverride === undefined
      ? useFaculty({
          command: ['bun', 'run', 'shell/faculty.ts'],
          name: 'shell',
          threads: has('shell') && has('store') ? shellThreads : [],
          requestSchema: ShellRequestEventSchema,
          cancelSchema: ShellCancelEventSchema,
          resultSchema: ShellRequestResultEventSchema,
        })(facultyAddThreads)
      : shellOverride(facultyAddThreads)

  // The system faculties: no default. A host override (a config helper
  // return — `useSystemTwo({ endpoints })`) carries the endpoint it needs;
  // without one the faculty is simply absent.
  const systemOne = systemOneOverride?.(facultyAddThreads)
  const systemTwo = systemTwoOverride?.(facultyAddThreads)

  // The store faculty: a host override is invoked with OUR addThreads (the
  // durable-db seam — the default is :memory: via env-data); the default
  // construction runs otherwise.
  const store =
    storeOverride === undefined
      ? useFaculty({
          command: ['bun', 'run', 'store/faculty.ts'],
          name: 'store',
          threads: [],
          requestSchema: StoreRequestEventSchema,
          cancelSchema: StoreRequestEventSchema, // no cancel; the request schema is the gate
          resultSchema: StoreRequestResultEventSchema,
        })(facultyAddThreads)
      : storeOverride(facultyAddThreads)

  // The security faculty: the cross-cutting credential/policy faculty — its
  // vending leg serves shell (remote rpc), system-two endpoints, ATProto,
  // and any future remote faculty. No threads of its own yet (the skeleton
  // vends); the rpc auth seam's threads lives with the op it serves.
  const security =
    securityOverride === undefined
      ? useFaculty({
          command: ['bun', 'run', 'security/faculty.ts'],
          name: 'security',
          threads: [],
          requestSchema: SecurityRequestEventSchema,
          cancelSchema: SecurityCancelEventSchema,
          resultSchema: SecurityRequestResultEventSchema,
        })(facultyAddThreads)
      : securityOverride(facultyAddThreads)

  // ── Routing: event type → faculty lane (the only faculty knowledge) ────────

  // The root guard threads are always mounted, independent of the allow-list.
  facultyAddThreads(facultiesThreads)

  type FacultyPort = { send: (event: BPEvent) => void; gate: (event: BPEvent) => boolean }
  const lanes: Record<string, FacultyPort> = {}
  const route = (types: string[], faculty: FacultyPort): void => {
    for (const type of types) lanes[type] = faculty
  }

  if (has('shell')) {
    route([FACULTY_MESSAGE_KINDS.shell_request, FACULTY_MESSAGE_KINDS.shell_cancel], {
      send: (event: BPEvent): void => shell.send(event),
      gate: (event: BPEvent): boolean => shell.invalidEventGate(event),
    })
  }
  if (systemOne === undefined) {
    // The structural admission review pack — the BP-native reviewer
    // (mode-exclusive with the judgment pack below): the verdict maps to
    // thread_admission / thread_admission_rejected selections, and the
    // outcome legs in the pump own the write. Without judgment, this pack IS
    // the admission gate — livelocked proposals reject visibly, as events.
    facultyAddThreads(admissionReviewThreads)
  } else {
    // The faculty's request/cancel/result guard derives from the same schemas
    // useFaculty compiled — a malformed system_one event is blocked (visible
    // in the frontier traces), not silently dropped.
    facultyAddThreads(guardThreads(`guard:${systemOne.name}-schema`, eventGuardEntries(systemOne.schemas)))
    // The admission judgment threads: the BP-native blocking judge — it requires
    // the Decisions lane (systemOne) and the structural layer (the in-process
    // frontier embed, always present). With judgment wired, a validated
    // candidate's admission is blocked while its Decision runs; the verdict
    // events below are the judge's road back to the pump.
    facultyAddThreads(admissionJudgmentThreads)
    // The supervision threads: the runtime circuit breaker (the counting
    // supervisor) + its judgment (block-then-judge at runtime, the admission
    // pattern rotated). Mounts with systemOne and only when the host supplies
    // a watch list — the pack's second line of defense.
    if (supervision !== undefined) {
      facultyAddThreads(supervisionThreads(supervision))
      facultyAddThreads(supervisionJudgmentThreads)
    }
    route([FACULTY_MESSAGE_KINDS.system_one_request, FACULTY_MESSAGE_KINDS.system_one_cancel], {
      send: (event: BPEvent): void => systemOne.send(event),
      gate: (event: BPEvent): boolean => systemOne.invalidEventGate(event),
    })
  }
  if (systemTwo !== undefined) {
    // The faculty's request/cancel/result guard derives from the same schemas
    // useFaculty compiled — a malformed system_two event is blocked (visible
    // in the frontier traces), not silently dropped.
    facultyAddThreads(guardThreads(`guard:${systemTwo.name}-schema`, eventGuardEntries(systemTwo.schemas)))
    route([FACULTY_MESSAGE_KINDS.system_two_request, FACULTY_MESSAGE_KINDS.system_two_cancel], {
      send: (event: BPEvent): void => systemTwo.send(event),
      gate: (event: BPEvent): boolean => systemTwo.invalidEventGate(event),
    })
  }
  // The admission path — pending add_thread ids. An id registers when its
  // request routes through the frontier lane (the request leg below); the
  // correlated frontier_request_result carries the verdict. The map is the
  // authorization: only results correlated to requests this composition
  // itself routed can ever admit. A null thread (the proposal failed the
  // Thread-schema gate at registration) never admits. With systemOne wired
  // the entry survives until the judgment resolves: the verdict is the
  // CANDIDATE record — the judged outcome events below are the write legs.
  const pendingAdmissions = new Map<string, Thread | null>()

  route([FACULTY_MESSAGE_KINDS.frontier_request], {
    send: (event: BPEvent): void => {
      // The request leg: register the id against the proposed thread, then
      // route through the frontier dispatch. The frontier stays
      // analysis-shaped — it validates and returns; the composition owns the
      // write (the verdict leg, in the pump below).
      const detail = event.detail as { id?: string; op?: string; input?: { thread?: unknown } } | undefined
      if (detail?.op === 'add_thread' && typeof detail.id === 'string') {
        pendingAdmissions.set(
          detail.id,
          validateThread(detail.input?.thread) ? (detail.input as { thread: Thread }).thread : null,
        )
        // Livelock detection is part of adding threads (the ruling): the
        // analysis input rides the composition's policy — the progress spec
        // and the clamped exploration budget — never the requester's claim.
        // A self-sustaining loop proposal comes back a failed verdict and
        // never reaches the write.
        frontier.send({
          ...event,
          detail: { ...detail, input: admissionAnalysisInput(detail.input as JsonObject) },
        })
        return
      }
      frontier.send(event)
    },
    gate: frontier.gate,
  })
  if (has('store')) {
    route([FACULTY_MESSAGE_KINDS.store_request], {
      send: (event: BPEvent): void => store.send(event),
      gate: (event: BPEvent): boolean => store.invalidEventGate(event),
    })
  }
  if (has('security')) {
    route([FACULTY_MESSAGE_KINDS.credential_request, FACULTY_MESSAGE_KINDS.credential_cancel], {
      send: (event: BPEvent): void => security.send(event),
      gate: (event: BPEvent): boolean => security.invalidEventGate(event),
    })
  }

  // The rpc auth seam: the vend-and-replay spine requires the op (shell) and
  // the vending leg (security) — the threads mount only when both are on.
  if (has('shell') && has('security')) facultyAddThreads(rpcAuthThreads)
  // The remote-mcp threads: the MCP layering over the rpc op — requires the
  // executor (shell), the vending leg (security), and the registry (store).
  if (has('shell') && has('security') && has('store')) facultyAddThreads(remoteMcpThreads)

  // ── The engine pump: traces out, gated events to their faculty lanes ─────

  // The verdict leg: a frontier_request_result correlated to a pending
  // add_thread id. Both verdict legs must be ok for the thread to admit under
  // the re-entry law (addThread + step): the outer envelope (the analysis ran)
  // and the inner verdict (it verified). The rejection is data — the
  // requester reads the why from the verdict trace.
  useTrace((trace: Trace) => {
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const candidate = (trace as SelectionTrace).selected
    // The judgment's outcome legs — the admission judgment threads' road back
    // to the pump. Only a conforming verdict with admit === true admits; a
    // rejection (or anything malformed — fail-closed) drops the pending id,
    // the rejection visible in the traces.
    if (candidate.type === ADMISSION_EVENT_TYPES.admitted || candidate.type === ADMISSION_EVENT_TYPES.rejected) {
      const detail = candidate.detail as { id?: string } | undefined
      const id = detail?.id
      if (typeof id === 'string' && pendingAdmissions.has(id)) {
        const thread = pendingAdmissions.get(id)
        pendingAdmissions.delete(id)
        if (thread && candidate.type === ADMISSION_EVENT_TYPES.admitted && validateAdmissionVerdict(candidate.detail))
          addThreads([thread])
      }
      return
    }
    if (candidate.type === FACULTY_MESSAGE_KINDS.frontier_request_result) {
      const detail = candidate.detail as { id?: string; ok?: boolean; result?: { ok?: boolean } } | undefined
      const id = detail?.id
      if (typeof id === 'string' && pendingAdmissions.has(id)) {
        const thread = pendingAdmissions.get(id)
        if (detail?.ok === true && thread && detail.result?.ok === true) {
          if (systemOne !== undefined) {
            // The judged path: the verdict is the candidate record — emit it
            // to the admission judgment threads (which blocks the admission
            // while the Decision runs). The entry survives until the judged
            // outcome leg above. (A validated thread is pure data — it
            // serializes as JSON — but its listener schemas aren't statically
            // JsonValue, hence the cast.)
            addThreads([
              {
                label: `thread-candidate:${id}`,
                once: true,
                rules: [
                  {
                    request: {
                      type: ADMISSION_EVENT_TYPES.candidate,
                      detail: { id, thread: thread as unknown as JsonObject },
                    },
                  },
                ],
              },
            ])
          }
          // The structural path is BP-native (the ruling's shape): the
          // review pack's verdict threads map THIS selection to
          // thread_admission / thread_admission_rejected — the outcome legs
          // above own the write. The id stays registered until the outcome.
        } else {
          // The rejection is data — the requester reads the why from the
          // verdict trace.
          pendingAdmissions.delete(id)
        }
      }
      return
    }
    const event = { type: candidate.type, detail: candidate.detail, space: candidate.space } as BPEvent
    const faculty = lanes[event.type]
    if (faculty === undefined) return
    // The trust boundary for events crossing into faculty processes: only
    // events passing the owning faculty's own gate route.
    if (faculty.gate(event)) return
    faculty.send(event)
  })

  // ── The explicit start: flush the deferred thread mounts ────────────────

  // Construction wires the pump and routes but does not flush. The host
  // subscribes (useTrace) FIRST, then calls start() — the boot cascade
  // (scan boots → shell_requests → faculty processes) runs in a world whose
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

  // The composition owns every faculty process it invoked — overrides
  // included: the host hands over a curried factory, the composition holds
  // the only `terminate` handle. (The engine and frontier are in-process:
  // nothing to terminate, they end with the host process.)
  return {
    trigger,
    useTrace,
    start,
    identity,
    terminate: (): void => {
      bindEmit(null)
      shell.terminate()
      store.terminate()
      security.terminate()
      systemOne?.terminate()
      systemTwo?.terminate()
    },
  }
}

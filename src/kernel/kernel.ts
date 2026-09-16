/**
 * Kernel engine floor — composes the turn loop over provisioned tools.
 *
 * @remarks
 * Tools are stateless: constructor/provisioner injection for anything they
 * cannot derive from input, and no module-level singletons. The MCP client
 * tools own their per-call connections (opened on use, closed on return), and
 * the model tools fetch per call, so the kernel holds no process-lifetime
 * resources to drain.
 *
 * @packageDocumentation
 */

import { KICK_EVENT_TYPE, TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import { behavioral } from '../behavioral/behavioral.ts'
import type { BPEvent, Disconnect, Frontier, Thread, Trace } from '../behavioral/behavioral.types.ts'
import type { FunctionCallItem, InputItem, OutputItem, Usage } from '../workers/open-responses.schemas.ts'
import type { ModelCompactTool, ModelRespondTool } from '../workers/use-model.ts'
import { createScriptedModelTools, DEFAULT_SCRIPTED_RESPONSE } from '../workers/use-model.ts'
import { createDispatchBridge, type DispatchableTool, type DispatchBridge } from './dispatch.ts'
import { createReentryThread, TURN_LOOP_THREAD } from './threads.ts'

export { TurnResultSchema } from './kernel.schemas.ts'

// ---------------------------------------------------------------------------
// Kernel — owns the model tools, the dispatch registry, and the turn-loop
// thread; exposes runTurn ({ space, prompt }) → JSON result.
// ---------------------------------------------------------------------------

/** The outcome of one turn, shaped for machine consumption (headless consumers parse this). */
export type TurnResult = {
  ok: true
  space: string
  status: 'completed' | 'incomplete' | 'failed'
  /** Full trajectory items: the user prompt + model outputs + tool-call outputs. */
  items: Record<string, unknown>[]
  /** Number of model-respond rounds run (bounded by the max-iteration guard). */
  iterations: number
  /** Token usage from the last model-respond round, when the model reported it. */
  usage?: Usage
  /** Captured trace stream — every Trace message from the run (the exhaust). */
  trace: Trace[]
}

/** The result of running an arbitrary thread set without a model round-trip. */
export type RunThreadsResult = {
  /** The captured trace stream — every Trace message from the run. */
  trace: Trace[]
  /** The final frontier after the engine settled (deadlock/idle), or null. */
  frontier: Frontier | null
}

/** Options for instantiating a kernel floor. All provisioner-injected. */
export type KernelOptions = {
  /** Model tools; defaults to a deterministic scripted set (no fetch). */
  modelTools?: { modelRespond: ModelRespondTool; modelCompact: ModelCompactTool }
  /** Dispatch registry: record keyed by tool name, or an iterable of callables. */
  dispatchTools?: Record<string, DispatchableTool> | Iterable<DispatchableTool>
  /** Max model-respond rounds before the turn stops with `incomplete` status. */
  maxIterations?: number
  /** Provider label routed to the provisioned model tools. */
  provider?: string
  /** Model id routed to the provisioned model tools. */
  modelId?: string
}

/** Kernel engine surface: the turn loop + the thread runner. */
export type Kernel = {
  /** Run one turn from a `{ space, prompt, threads? }` to a JSON {@link TurnResult}.
   *  Candidate `threads` are co-registered alongside the turn-loop coordination
   *  skeleton; when omitted the turn loop runs alone (backward compat). */
  runTurn: (input: { space: string; prompt: string; threads?: Thread[] }) => Promise<TurnResult>
  /** Register arbitrary threads + run the program + capture the trace, with no
   *  model round-trip. Returns the captured trace and the final frontier. */
  runThreads: (input: { space: string; threads: Thread[] }) => Promise<RunThreadsResult>
}

/**
 * Run one turn: compose a fresh behavioral program, register the turn-loop
 * thread, wire the dispatch bridge as the `useTrace` action channel, trigger
 * the `user.prompt` ingress, and resolve when `turn.end` is selected.
 *
 * @remarks
 * MINIMAL: the turn loop is scaffolding (see {@link ./threads.ts}). The bridge
 * owns the trajectory (`items`), the iteration count, and the stop decision —
 * the thread is the static coordination skeleton. Triggers from the bridge are
 * deferred past the current super-step via `queueMicrotask` so the bridge never
 * re-enters the engine synchronously from inside a `sendTrace` listener.
 */
const runTurnImpl = ({
  space,
  prompt,
  threads,
  modelRespond,
  dispatch,
  maxIterations,
  provider,
  modelId,
}: {
  space: string
  prompt: string
  threads?: Thread[]
  modelRespond: ModelRespondTool
  dispatch: DispatchBridge
  maxIterations: number
  provider: string
  modelId: string
}): Promise<TurnResult> => {
  const program = behavioral()
  const addThread = program.useAddThread(space)
  const trigger = program.trigger
  const trace: Trace[] = []

  // Kernel-owned trajectory: the user message + every appended model output and
  // tool-call output. Re-fed to `modelRespond` each round; returned as the result.
  const items: Record<string, unknown>[] = [{ type: 'message', role: 'user', content: prompt }]
  let iterations = 0
  let lastOutput: { items: OutputItem[]; status: string; usage?: Usage } | null = null
  let pendingDispatch: FunctionCallItem[] = []
  let turnStatus: TurnResult['status'] = 'completed'
  let turnUsage: Usage | undefined

  addThread(TURN_LOOP_THREAD)
  for (const thread of threads ?? []) addThread(thread)

  // Internal re-entry: register a once-thread requesting the event, then start
  // the super-step with a contentless kick. `addThread` is inert, so without
  // the kick nothing would advance; the kick is priority 0, carries no detail,
  // and matches no listener, so the requested event follows in the next
  // super-step as a request-origin candidate (`ingress` absent). Both calls are
  // deferred past the current super-step via `queueMicrotask` so the action
  // channel never re-enters the engine from inside a `sendTrace` listener.
  const reenter = (event: BPEvent): void => {
    queueMicrotask(() => {
      addThread(
        createReentryThread({
          type: event.type,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        }),
      )
      trigger({ type: KICK_EVENT_TYPE, space })
    })
  }

  // The dispatch bridge: the action channel. Fires on selection traces for the
  // coordination events the thread requests; does its async I/O outside the
  // super-step and re-enters via `reenter`. Never throws into the space.
  const bridge = async (selectedType: string): Promise<void> => {
    try {
      if (selectedType === 'model.respond') {
        if (iterations >= maxIterations) {
          turnStatus = 'incomplete'
          reenter({ type: 'turn.end', detail: { reason: 'max_iterations' } })
          return
        }
        iterations += 1
        const out = await modelRespond({ provider, modelId, input: items as InputItem[] })
        if ('isError' in out) {
          turnStatus = 'failed'
          reenter({ type: 'turn.end', detail: { reason: 'model_error', message: out.message } })
          return
        }
        lastOutput = {
          items: out.items,
          status: out.status,
          ...(out.usage === undefined ? {} : { usage: out.usage }),
        }
        items.push(...out.items)
        if (out.usage !== undefined) turnUsage = out.usage
        reenter({ type: 'model.result', detail: { status: out.status } })
        return
      }
      if (selectedType === 'model.result') {
        // Synchronous: extract function_calls from the last model round so the
        // thread's upcoming tool.dispatch request sees them (same super-step).
        pendingDispatch = (lastOutput?.items ?? []).filter(
          (item): item is FunctionCallItem => (item as FunctionCallItem).type === 'function_call',
        )
        return
      }
      if (selectedType === 'tool.dispatch') {
        if (pendingDispatch.length === 0) {
          reenter({ type: 'turn.end', detail: { status: lastOutput?.status ?? 'completed' } })
          return
        }
        for (const call of pendingDispatch) {
          const output = await dispatch.dispatch({ name: call.name, arguments: call.arguments, call_id: call.call_id })
          items.push(output)
        }
        pendingDispatch = []
        reenter({ type: 'tool.result', detail: {} })
        return
      }
      if (selectedType === 'tool.result') {
        reenter({ type: 'respond', detail: {} })
        return
      }
    } catch (err) {
      turnStatus = 'failed'
      reenter({
        type: 'turn.end',
        detail: { reason: 'bridge_error', message: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  return new Promise<TurnResult>((resolve) => {
    let disconnect: Disconnect | undefined
    disconnect = program.useTrace((msg) => {
      trace.push(msg)
      if (msg.kind !== TRACE_MESSAGE_KINDS.selection) return
      if (msg.selected.type === 'turn.end') {
        disconnect?.()
        resolve({
          ok: true,
          space,
          status: turnStatus,
          items,
          iterations,
          trace,
          ...(turnUsage === undefined ? {} : { usage: turnUsage }),
        })
        return
      }
      void bridge(msg.selected.type)
    })
    trigger({ type: 'user.prompt', detail: { prompt }, space })
  })
}

/**
 * Run an arbitrary thread set without a model round-trip: register the threads,
 * capture every Trace message, and return the trace alongside the final frontier.
 *
 * @remarks
 * This is the primitive the autoresearch gate calls — it runs a candidate
 * thread (or set) and reads the exhaust (the trace + frontier) for
 * frontier-verify/frontier-replay. No model tools, no dispatch bridge — just
 * the behavioral engine. The engine runs to completion (all selectable events
 * fire) or pauses at deadlock/idle; the last frontier trace provides the
 * frontier.
 */
const runThreadsImpl = ({ space, threads }: { space: string; threads: Thread[] }): Promise<RunThreadsResult> => {
  const program = behavioral()
  const addThread = program.useAddThread(space)
  const trigger = program.trigger
  const trace: Trace[] = []

  // Capture all trace messages.
  program.useTrace((msg) => {
    trace.push(msg)
  })

  for (const thread of threads) addThread(thread)

  // Start the super-step via the once-thread + kick route: register a
  // `threads.registered` request thread, then fire the contentless kick.
  // `addThread` is inert — without the kick the engine would never step.
  //
  // `threads.registered` is a documented harness event — it appears in the
  // trace as a request-origin selection and is part of the contract, not noise.
  // Two ways to use it:
  //  1. Candidate threads can `waitFor` it as an ingress signal (the same way
  //     the turn loop waits for `user.prompt`).
  //  2. Consumers replaying the trace against a different thread set (e.g.
  //     `frontierReplay`) must filter it out — it is not part of the candidate
  //     program's event vocabulary.
  addThread(createReentryThread({ type: 'threads.registered', detail: { count: threads.length } }))
  trigger({ type: KICK_EVENT_TYPE, space })

  // Extract the final frontier from the last frontier trace.
  const frontierTraces = trace.filter(
    (msg): msg is Extract<Trace, { kind: typeof TRACE_MESSAGE_KINDS.frontier }> =>
      msg.kind === TRACE_MESSAGE_KINDS.frontier,
  )
  const lastFrontierTrace = frontierTraces[frontierTraces.length - 1]
  const frontier = lastFrontierTrace
    ? {
        candidates: lastFrontierTrace.candidates,
        enabled: lastFrontierTrace.enabled,
        status: lastFrontierTrace.status,
      }
    : null

  return Promise.resolve({ trace, frontier })
}

/**
 * Instantiate the kernel engine floor. Provisions the model tools (scripted by
 * default — no fetch, deterministic) and the dispatch registry (empty by
 * default; provisioner-injected). `runTurn` composes a fresh behavioral program
 * per turn. No process-lifetime resources: the model tools fetch per call.
 */
export const createKernel = (options: KernelOptions = {}): Kernel => {
  const modelTools = options.modelTools ?? createScriptedModelTools({ script: DEFAULT_SCRIPTED_RESPONSE })
  const dispatch = createDispatchBridge({
    tools: options.dispatchTools ?? {},
  })
  const maxIterations = options.maxIterations ?? 8
  const provider = options.provider ?? 'scripted'
  const modelId = options.modelId ?? 'scripted-model'
  const runTurn = (input: { space: string; prompt: string; threads?: Thread[] }): Promise<TurnResult> =>
    runTurnImpl({ ...input, modelRespond: modelTools.modelRespond, dispatch, maxIterations, provider, modelId })
  const runThreads = (input: { space: string; threads: Thread[] }): Promise<RunThreadsResult> => runThreadsImpl(input)

  return { runTurn, runThreads }
}

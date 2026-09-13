/**
 * Kernel engine floor — owns shared process-lifetime state and wires
 * provisioned tools.
 *
 * @remarks
 * The kernel is the single home for state that tools must not hold as module
 * singletons: the MCP connection pool (and, later, the model-endpoint
 * registry). Tools are stateless via constructor injection; the kernel
 * instantiates the pool once and injects its `getClient` into the MCP client
 * tool at provisioning. The kernel also owns the pool's lifecycle —
 * {@link Kernel.shutdown} drains every pooled connection and is registered on
 * process teardown so no client leaks across an agent run.
 *
 * @packageDocumentation
 */

import {
  Client,
  type FetchLike,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { KICK_EVENT_TYPE, TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import { behavioral } from '../behavioral/behavioral.ts'
import type { BPEvent, Disconnect, Frontier, Thread, Trace } from '../behavioral/behavioral.types.ts'
import { createMcpClientTool, type McpClientTool } from '../tools/mcp-client.ts'
import type { ModelCompactTool, ModelRespondTool } from '../tools/model.ts'
import { createScriptedModelTools, DEFAULT_SCRIPTED_RESPONSE } from '../tools/model.ts'
import type { FunctionCallItem, InputItem, OutputItem, Usage } from '../tools/open-responses.schemas.ts'
import { read } from '../tools/read.ts'
import { createDispatchBridge, type DispatchableTool, type DispatchBridge } from './dispatch.ts'
import { createReentryThread, TURN_LOOP_THREAD } from './threads.ts'

export { TurnResultSchema } from './kernel.schemas.ts'

// ---------------------------------------------------------------------------
// Pool contract types
// ---------------------------------------------------------------------------

/** Options used to establish (and re-establish) a pooled connection. */
export type AdapterSessionOptions = {
  headers?: Record<string, string>
  authProvider?: OAuthClientProvider
  timeoutMs?: number
  /**
   * Custom fetch implementation for the transport. When provided (e.g. by
   * test fixtures using an in-process handler), no real network socket is
   * opened — requests route directly through the handler's fetch method.
   */
  fetch?: FetchLike
}

type PoolEntry = {
  client: Client
  /** Resolves to the connected client; shared by concurrent first-callers. */
  connectPromise: Promise<Client>
}

/** Pool getter injected into the MCP client tool at provisioning. */
export type GetClientFn = (url: string, options: AdapterSessionOptions) => Promise<Client>

/** The ownable pool surface the kernel (or a test suite) instantiates. */
export type ConnectionPool = {
  /** Lazily connect a {@link Client} for `url` and reuse it on subsequent calls. */
  getClient: GetClientFn
  /** Close and drop a single connection. */
  closeClient: (url: string) => Promise<void>
  /** Close and drop every pooled connection (teardown). */
  closeAll: () => Promise<void>
  /** Test/debug hook: the number of currently pooled connections. */
  size: () => number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_INFO = { name: 'behavioral', version: '0.0.0' }

// ---------------------------------------------------------------------------
// Pool factory — a closure, no module-level Map
// ---------------------------------------------------------------------------

/**
 * Build a connection-pool closure. The kernel instantiates this once and
 * injects `getClient` into {@link createMcpClientTool}; tests instantiate one
 * per suite for isolation. Concurrent first-callers share the same
 * `connectPromise`; a failed connect evicts the entry so the next call
 * retries. Callers never close the returned client — the pool owns its
 * lifecycle (see {@link ConnectionPool.closeAll}).
 *
 * MINIMAL: the pool key is the server-url alone. A second call to the same
 * url with different `headers`/`authProvider` reuses the first connection's
 * request init. Upgrade path: key by url + auth-fingerprint so per-call auth
 * variants get distinct connections.
 */
export const createConnectionPool = (): ConnectionPool => {
  const pool = new Map<string, PoolEntry>()

  const getClient = async (url: string, options: AdapterSessionOptions): Promise<Client> => {
    const existing = pool.get(url)
    if (existing) return existing.connectPromise

    const client = new Client(CLIENT_INFO)
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: options.headers ? { headers: options.headers } : undefined,
      authProvider: options.authProvider,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    const connectPromise = client.connect(transport).then(() => client)
    pool.set(url, { client, connectPromise })

    try {
      await connectPromise
    } catch (err) {
      // Evict on failure so the next call can retry instead of reusing a dead
      // connectPromise forever.
      pool.delete(url)
      try {
        await client.close()
      } catch {
        /* best-effort */
      }
      throw err
    }
    return client
  }

  const closeClient = async (url: string): Promise<void> => {
    const entry = pool.get(url)
    if (!entry) return
    pool.delete(url)
    try {
      await entry.client.close()
    } catch {
      /* best-effort */
    }
  }

  const closeAll = async (): Promise<void> => {
    const urls = [...pool.keys()]
    await Promise.all(urls.map((url) => closeClient(url)))
  }

  const size = (): number => pool.size

  return { getClient, closeClient, closeAll, size }
}

// ---------------------------------------------------------------------------
// Kernel — owns the pool, the model tools, the dispatch registry, and the
// turn-loop thread; exposes runTurn ({ space, prompt }) → JSON result.
// ---------------------------------------------------------------------------

/** The outcome of one turn, shaped for machine consumption (Harbor parses this). */
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
  /** Custom fetch for the MCP transport — test fixtures inject an in-process
   *  handler.fetch so no real network socket is opened. */
  poolFetch?: FetchLike
}

/** Kernel engine surface: shared state + provisioned tools + lifecycle + turn. */
export type Kernel = {
  /** The kernel-owned MCP connection pool. */
  pool: ConnectionPool
  /** MCP client tool provisioned with the kernel's pool getter. */
  mcpClient: McpClientTool
  /** Run one turn from a `{ space, prompt, threads? }` to a JSON {@link TurnResult}.
   *  Candidate `threads` are co-registered alongside the turn-loop coordination
   *  skeleton; when omitted the turn loop runs alone (backward compat). */
  runTurn: (input: { space: string; prompt: string; threads?: Thread[] }) => Promise<TurnResult>
  /** Register arbitrary threads + run the program + capture the trace, with no
   *  model round-trip. Returns the captured trace and the final frontier. */
  runThreads: (input: { space: string; threads: Thread[] }) => Promise<RunThreadsResult>
  /** Drain every pooled connection. Idempotent; registered on process teardown. */
  shutdown: () => Promise<void>
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
 * Instantiate the kernel engine floor. Creates the connection pool, wires the
 * MCP client tool against the pool's `getClient`, provisions the model tools
 * (scripted by default — no fetch, deterministic) and the dispatch registry
 * (the built-in `read` tool by default), and registers a teardown hook so
 * pooled connections drain on process exit. `runTurn` composes a fresh
 * behavioral program per turn.
 *
 * MINIMAL: a single process-teardown hook (`beforeExit`). Upgrade path: also
 * drain on SIGINT/SIGTERM with a flush timeout once the agent has a graceful
 * shutdown sequence wired through the controller.
 */
export const createKernel = (options: KernelOptions = {}): Kernel => {
  const pool = createConnectionPool()
  const poolFetch = options.poolFetch
  const mcpClient = createMcpClientTool({
    getClient: (url, sessionOpts) =>
      pool.getClient(url, { ...sessionOpts, ...(poolFetch ? { fetch: poolFetch } : {}) }),
  })
  const modelTools = options.modelTools ?? createScriptedModelTools({ script: DEFAULT_SCRIPTED_RESPONSE })
  const dispatch = createDispatchBridge({
    tools: options.dispatchTools ?? { read: read as unknown as DispatchableTool },
  })
  const maxIterations = options.maxIterations ?? 8
  const provider = options.provider ?? 'scripted'
  const modelId = options.modelId ?? 'scripted-model'
  const runTurn = (input: { space: string; prompt: string; threads?: Thread[] }): Promise<TurnResult> =>
    runTurnImpl({ ...input, modelRespond: modelTools.modelRespond, dispatch, maxIterations, provider, modelId })
  const runThreads = (input: { space: string; threads: Thread[] }): Promise<RunThreadsResult> => runThreadsImpl(input)

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await pool.closeAll()
  }

  // Drain pooled connections when the agent's event loop empties. `beforeExit`
  // can fire more than once; `shutdown` is idempotent so re-entry is safe.
  process.on('beforeExit', shutdown)

  return { pool, mcpClient, runTurn, runThreads, shutdown }
}

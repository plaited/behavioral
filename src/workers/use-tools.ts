/**
 * Host consumer for the tools worker — owns the worker lifecycle, correlates
 * execution ids, and exposes the bounded `execute` surface the kernel will
 * eventually consume.
 *
 * @remarks
 * Temporary home: `createToolsExecutor` and `getToolsWorker` are self-contained
 * so they can be lifted into `src/kernel/` without rewiring.
 *
 * The worker is spawned eagerly so a broken worker surfaces at construction
 * rather than on the first execution. `execute` never rejects — every failure
 * is `status: 'error'` data, matching the kernel's dispatch convention.
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import { defineTool } from '../tools/define-tool.ts'
import type {
  ToolsCancel,
  ToolsFormat,
  ToolsLineEvent,
  ToolsOptions,
  ToolsOutbound,
  ToolsRequest,
  ToolsResult,
} from './tools.types.ts'

/** A streamed line as handed to the supervisor seam. */
export type ToolsLineSink = Omit<ToolsLineEvent, 'type'>

/**
 * Absolute bounds a host caller cannot exceed.
 *
 * @remarks
 * A request may lower a bound freely; raising past the ceiling clamps and the
 * clamp is reported in `ToolsResult.clamped`. The model-facing tool schema
 * instead *rejects* out-of-range input at its trust boundary — see
 * `getToolsWorker`.
 */
export type ToolsCeilings = {
  timeoutMs: number
  maxLines: number
  maxCharacters: number
  limit: number
}

/** Default ceilings. */
export const DEFAULT_CEILINGS: ToolsCeilings = {
  timeoutMs: 120_000,
  maxLines: 5_000,
  maxCharacters: 200_000,
  limit: 1_000,
}

/** Knobs the host clamps. */
const CLAMPED_KEYS = ['timeoutMs', 'maxLines', 'maxCharacters', 'limit'] as const

/** How long `destroy` waits for canceled runs to report before terminating. */
const DESTROY_GRACE_MS = 150

/** An error result carrying no capture — the run died with the executor. */
const failedResult = ({ id, message }: { id: string; message: string }): ToolsResult => ({
  id,
  status: 'error',
  exitCode: null,
  signal: null,
  totalLines: 0,
  hasMore: false,
  stderr: '',
  durationMs: 0,
  message,
})

/** Clamp over-ceiling knobs, recording every adjustment as `'<key> <given> -> <applied>'`. */
const clampOptions = ({
  options,
  ceilings,
}: {
  options: ToolsOptions
  ceilings: ToolsCeilings
}): { options: ToolsOptions; clamped: string[] } => {
  const clamped: string[] = []
  const applied: ToolsOptions = { ...options }
  for (const key of CLAMPED_KEYS) {
    const given = options[key]
    if (given !== undefined && given > ceilings[key]) {
      clamped.push(`${key} ${given} -> ${ceilings[key]}`)
      applied[key] = ceilings[key]
    }
  }
  return { options: applied, clamped }
}

/** Executor configuration. */
export type ToolsExecutorConfig = {
  /** Default working directory for every execution. */
  cwd?: string
  /** Worker entry override — tests and embedders may repoint it. */
  workerUrl?: URL | string
  /**
   * Supervisor seam: invoked for every output line as it arrives, before the
   * execution completes.
   *
   * @remarks
   * This is where a b-thread guard's intent becomes an action today: a listener
   * can `cancel(id)` on a quota, a stall signature, or a byte budget. MINIMAL:
   * threads cannot set numeric bounds yet — merging a selected event's `detail`
   * into tool options needs kernel ingress (the recoded kernel, not yet built).
   */
  onLine?: (event: ToolsLineSink) => void
  /** Per-installation ceiling overrides; defaults favor a small local model. */
  ceilings?: Partial<ToolsCeilings>
}

/** Host-side surface over one tools worker. */
export type ToolsExecutor = {
  /** Run one script; resolves a bounded result and never rejects. */
  execute: (script: string, options?: ToolsOptions) => Promise<ToolsResult>
  /** Stop one running execution by correlation id. */
  cancel: (id: string) => void
  /** Terminate the worker. */
  destroy: () => void
}

/**
 * Create an executor over a freshly spawned tools worker.
 *
 * @param config Default `cwd` and an optional worker entry override.
 */
export const createToolsExecutor = (config: ToolsExecutorConfig = {}): ToolsExecutor => {
  const worker = new Worker(config.workerUrl ?? new URL('./tools.ts', import.meta.url))
  const ceilings: ToolsCeilings = { ...DEFAULT_CEILINGS, ...config.ceilings }
  const pending = new Map<string, { settle: (result: ToolsResult) => void; clamped?: string[] }>()
  let destroying = false
  let destroyWatchdog: ReturnType<typeof setTimeout> | undefined
  let dead: string | undefined

  // A crashed worker is a zombie: its module never loaded, so posted messages
  // are dropped silently. Everything pending resolves as error data and the
  // executor stays dead until the caller recreates it — no auto-respawn.
  worker.onerror = (event: ErrorEvent): void => {
    dead = event.message.slice(0, 200)
    for (const [id, entry] of pending) {
      pending.delete(id)
      entry.settle(failedResult({ id, message: `worker_error: ${dead}` }))
    }
  }

  worker.onmessage = (event: MessageEvent): void => {
    const message = event.data as ToolsOutbound
    if (message.type === 'LINE') {
      config.onLine?.({
        id: message.id,
        lineNumber: message.lineNumber,
        stream: message.stream,
        line: message.line,
      })
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    entry.settle(entry.clamped === undefined ? message.result : { ...message.result, clamped: entry.clamped })
    // A draining destroy terminates once its last in-flight run has reported.
    if (destroying && pending.size === 0) {
      if (destroyWatchdog !== undefined) clearTimeout(destroyWatchdog)
      worker.terminate()
    }
  }

  const execute = (script: string, options: ToolsOptions = {}): Promise<ToolsResult> =>
    new Promise<ToolsResult>((resolve) => {
      if (dead !== undefined) {
        resolve(failedResult({ id: crypto.randomUUID(), message: `worker_error: ${dead}` }))
        return
      }
      const id = crypto.randomUUID()
      const merged: ToolsOptions = { ...(config.cwd === undefined ? {} : { cwd: config.cwd }), ...options }
      const { options: bounded, clamped } = clampOptions({ options: merged, ceilings })
      pending.set(id, { settle: resolve, ...(clamped.length === 0 ? {} : { clamped }) })
      const request: ToolsRequest = { type: 'EXECUTE', id, script, options: bounded }
      worker.postMessage(request)
    })

  const cancel = (id: string): void => {
    const message: ToolsCancel = { type: 'CANCEL', id }
    worker.postMessage(message)
  }

  const destroy = (): void => {
    if (destroying) return
    destroying = true
    if (pending.size === 0) {
      worker.terminate()
      return
    }
    // Graceful: cancel everything in flight so their process groups are reaped
    // by the worker, give them a beat to report, then cut the thread. Anything
    // still pending died with the worker — resolve it as error data.
    for (const id of [...pending.keys()]) cancel(id)
    destroyWatchdog = setTimeout(() => {
      for (const [id, entry] of pending) {
        pending.delete(id)
        entry.settle(failedResult({ id, message: 'executor_destroyed' }))
      }
      worker.terminate()
    }, DESTROY_GRACE_MS)
  }

  return { execute, cancel, destroy }
}

// ---------------------------------------------------------------------------
// Model-facing tool (§5)
// ---------------------------------------------------------------------------

/** The §5 tool input — the entire model-facing surface. */
export type ToolsToolInput = {
  script: string
  format?: ToolsFormat
  offset?: number
  limit?: number
}

export const ToolsToolInputSchema: JSONSchemaType<ToolsToolInput> = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      minLength: 1,
      description: "The shell script or command. Use `bun -e '...'` for quick TypeScript evaluations.",
    },
    format: {
      type: 'string',
      enum: ['paged', 'json', 'raw'],
      nullable: true,
      description:
        "Output representation: 'paged' (default) for line windows, 'json' to parse stdout, 'raw' for tail-bounded text.",
    },
    offset: {
      type: 'integer',
      minimum: 0,
      nullable: true,
      description: 'Lines to skip before capturing (paged only).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      nullable: true,
      description: 'Maximum lines to capture (paged only, at most 1000).',
    },
  },
  required: ['script'],
  additionalProperties: false,
}

// `jsonData` is an arbitrary JSON value, which JSONSchemaType cannot express —
// hand-written and cast per the mcp-client precedent.
export const ToolsToolOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'timeout', 'line_quota', 'canceled', 'error'] },
    exitCode: { type: 'integer', nullable: true },
    signal: { type: 'string', nullable: true },
    lines: { type: 'array', items: { type: 'string' }, nullable: true },
    totalLines: { type: 'integer' },
    hasMore: { type: 'boolean' },
    jsonData: {},
    stdout: { type: 'string', nullable: true },
    stderr: { type: 'string' },
    durationMs: { type: 'integer' },
    clamped: { type: 'array', items: { type: 'string' }, nullable: true },
    message: { type: 'string', nullable: true },
  },
  required: ['id', 'status', 'exitCode', 'signal', 'totalLines', 'hasMore', 'stderr', 'durationMs'],
  additionalProperties: false,
} as unknown as JSONSchemaType<ToolsResult>

/** The one tool the agent perceives (spec §5). */
export const TOOLS_TOOL_NAME = 'execute_shell'

/**
 * Bind the §5 tool to an executor.
 *
 * @remarks
 * The schema is the trust boundary: model input is rejected here, while host
 * callers clamp instead (see {@link createToolsExecutor}). Numeric bounds the
 * model cannot set — `timeoutMs`, `maxLines`, `maxCharacters` — are the
 * executor's defaults; a b-thread guard can only `cancel(id)` through the
 * `onLine` seam until kernel ingress for event detail exists.
 */
export const getToolsWorker = (executor: ToolsExecutor) =>
  defineTool(
    {
      name: TOOLS_TOOL_NAME,
      description:
        "Execute a shell script, command pipeline, or TypeScript fragment (`bun -e '...'`). " +
        "Output is bounded: 'paged' (default) returns a window of stdout lines with offset/limit plus " +
        "totalLines/hasMore; 'json' parses stdout as JSON; 'raw' returns tail-bounded text. " +
        'Non-zero exits are data (exitCode). Flooding, stuck, or over-budget commands are group-killed and ' +
        "reported as status 'line_quota' | 'timeout' | 'canceled'.",
      inputSchema: ToolsToolInputSchema,
      outputSchema: ToolsToolOutputSchema,
    },
    (input) =>
      executor.execute(input.script, {
        ...(input.format === undefined ? {} : { format: input.format }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
  )

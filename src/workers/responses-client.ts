/**
 * Host consumer for the model worker — owns the worker lifecycle, correlates
 * request ids, and exposes the `respond` surface the kernel consumes, plus the
 * `defineTool` binding and the in-process scripted (test/dev) executor. No
 * compaction: context management is client-side (RLM-style thread recursion +
 * distillation via the ordinary respond call — see plan.md Decision Log).
 *
 * @remarks
 * Endpoint config is seeded into the worker with `setEnvironmentData` before
 * spawn; the worker reads it once. Secrets never enter a request message or the
 * model-facing schema.
 *
 * The executor never rejects — every failure is `{ isError, message }` data,
 * matching the kernel's dispatch convention. It is a dumb per-call executor;
 * recursive/parallel model calls are decisions the behavioral threads make by
 * issuing more requests.
 *
 * @packageDocumentation
 */

import { setEnvironmentData } from 'node:worker_threads'
import type { JSONSchemaType } from 'ajv'
import { defineTool } from '../tools/define-tool.ts'
import {
  ErrorSchema,
  FunctionToolSchema,
  InputItemSchema,
  OutputItemSchema,
  reasoningEffortEnum,
  TruncationSchema,
  UsageSchema,
} from './responses-client.schemas.ts'
import {
  MODEL_ENDPOINTS_KEY,
  type ModelDeltaEvent,
  type ModelEndpoints,
  type ModelInbound,
  type ModelOutbound,
  type ModelRespondInput,
  type ModelRespondOutput,
  type Script,
  type ScriptedResponse,
} from './responses-client.types.ts'

// ---------------------------------------------------------------------------
// JSON schemas (host-facing tool boundary — the single validation point)
// ---------------------------------------------------------------------------

const inputItemJsonSchema = InputItemSchema.schema
const functionToolJsonSchema = FunctionToolSchema.schema
const outputItemJsonSchema = OutputItemSchema.schema
const usageJsonSchema = UsageSchema.schema
const errorJsonSchema = ErrorSchema.schema
const truncationJsonSchema = TruncationSchema.schema

export const ModelRespondInputSchema = {
  type: 'object',
  properties: {
    provider: {
      type: 'string',
      minLength: 1,
      description: 'provisioned endpoint selector — maps to a URL + key injected at provisioning',
    },
    modelId: { type: 'string', minLength: 1, description: 'model identifier at the endpoint' },
    input: { type: 'array', items: inputItemJsonSchema, description: 'conversation transcript items' },
    tools: { type: 'array', items: functionToolJsonSchema, nullable: true },
    instructions: { type: 'string', nullable: true },
    truncation: { ...truncationJsonSchema, nullable: true },
    stream: { type: 'boolean', nullable: true, description: 'request SSE streaming' },
    reasoningEffort: {
      anyOf: [
        {
          type: 'string',
          enum: [...reasoningEffortEnum],
          description: 'spec ReasoningEffortEnum values (none|low|medium|high|xhigh)',
        },
        {
          type: 'string',
          minLength: 1,
          description:
            'non-spec value — passed through to reasoning.effort verbatim for endpoints that extend the spec (e.g. OpenAI-only minimal)',
        },
        { type: 'null' },
      ],
      description:
        'reasoning effort; spec values are declared, others pass through (the endpoint is the authority on its supported efforts)',
    },
  },
  required: ['provider', 'modelId', 'input'],
  additionalProperties: true,
  description:
    'Send input items to a provisioned Open Responses endpoint and get back output items. ' +
    'function_call items are returned as data — dispatch them yourself. ' +
    'Named fields are spec-only; any other key-value in args passes through to the ' +
    'request body verbatim (spec params we do not name + endpoint extensions).',
} as unknown as JSONSchemaType<ModelRespondInput>

export const ModelRespondOutputSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        items: { type: 'array', items: outputItemJsonSchema },
        status: { type: 'string' },
        events: { type: 'array', items: { type: 'object' }, nullable: true },
        usage: { ...usageJsonSchema, nullable: true },
        error: { ...errorJsonSchema, nullable: true },
      },
      required: ['items', 'status'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        isError: { type: 'boolean', const: true },
        message: { type: 'string' },
      },
      required: ['isError', 'message'],
      additionalProperties: false,
    },
  ],
  description: 'Output items + status on success; { isError, message } on failure.',
} as unknown as JSONSchemaType<ModelRespondOutput>

export const MODEL_RESPOND_TOOL_NAME = 'model-respond'

export type ModelRespondTool = ReturnType<typeof defineTool<ModelRespondInput, ModelRespondOutput>>

// ---------------------------------------------------------------------------
// Executor — one worker, id-correlated requests
// ---------------------------------------------------------------------------

/** A streamed event as handed to the `onDelta` seam. */
export type ModelDeltaSink = Omit<ModelDeltaEvent, 'type'>

/** Executor configuration. */
export type ModelExecutorConfig = {
  /** Provisioned endpoint map — seeded into the worker via environment data. */
  endpoints: ModelEndpoints
  /** Worker entry override — tests and embedders may repoint it. */
  workerUrl?: URL | string
  /** Invoked for every streamed semantic event as it arrives. */
  onDelta?: (event: ModelDeltaSink) => void
}

/** Host-side surface over one model worker. */
export type ModelExecutor = {
  /** Run one respond call; resolves a result and never rejects. */
  respond: (input: ModelRespondInput) => Promise<ModelRespondOutput>
  /** Stop one in-flight call by correlation id. */
  cancel: (id: string) => void
  /** Terminate the worker. */
  destroy: () => void
}

/** How long `destroy` waits for canceled calls to report before terminating. */
const DESTROY_GRACE_MS = 150

const abortedResult = (message: string): { isError: true; message: string } => ({ isError: true, message })

/**
 * Create an executor over a freshly spawned model worker. Endpoints are seeded
 * with `setEnvironmentData` immediately before spawn, so the worker reads them
 * at startup and no secret crosses the message boundary.
 *
 * MINIMAL: environment data is process-global, so a second concurrent executor
 * with different endpoints would race the seeding of the first. One model
 * executor per process is the provisioning contract; upgrade path (if that
 * ever changes) is a `CONFIGURE` handshake message instead.
 */
export const createModelExecutor = (config: ModelExecutorConfig): ModelExecutor => {
  setEnvironmentData(MODEL_ENDPOINTS_KEY, config.endpoints)
  const worker = new Worker(config.workerUrl ?? new URL('./responses-client.worker.ts', import.meta.url))
  const pending = new Map<string, (result: ModelRespondOutput) => void>()
  let destroying = false
  let destroyWatchdog: ReturnType<typeof setTimeout> | undefined
  let dead: string | undefined

  // A crashed worker is a zombie: its module never loaded, so posted messages
  // are dropped silently. Everything pending resolves as error data and the
  // executor stays dead until the caller recreates it — no auto-respawn.
  worker.onerror = (event: ErrorEvent): void => {
    dead = event.message.slice(0, 200)
    for (const [id, settle] of pending) {
      pending.delete(id)
      settle(abortedResult(`worker_error: ${dead}`))
    }
  }

  worker.onmessage = (event: MessageEvent): void => {
    const message = event.data as ModelOutbound
    if (message.type === 'DELTA') {
      config.onDelta?.({ id: message.id, event: message.event })
      return
    }
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    settle(message.result)
    // A draining destroy terminates once its last in-flight call has reported.
    if (destroying && pending.size === 0) {
      if (destroyWatchdog !== undefined) clearTimeout(destroyWatchdog)
      worker.terminate()
    }
  }

  const request = (message: { type: 'RESPOND'; id: string; input: ModelRespondInput }) =>
    new Promise<ModelRespondOutput>((resolve) => {
      if (dead !== undefined) {
        resolve(abortedResult(`worker_error: ${dead}`))
        return
      }
      pending.set(message.id, resolve)
      worker.postMessage(message)
    })

  const respond = (input: ModelRespondInput): Promise<ModelRespondOutput> =>
    request({ type: 'RESPOND', id: crypto.randomUUID(), input })

  const cancel = (id: string): void => {
    const message: ModelInbound = { type: 'CANCEL', id }
    worker.postMessage(message)
  }

  const destroy = (): void => {
    if (destroying) return
    destroying = true
    if (pending.size === 0) {
      worker.terminate()
      return
    }
    // Graceful: cancel everything in flight, give it a beat to report, then cut
    // the thread. Anything still pending resolves as error data.
    for (const id of [...pending.keys()]) cancel(id)
    destroyWatchdog = setTimeout(() => {
      for (const [id, settle] of pending) {
        pending.delete(id)
        settle(abortedResult('executor_destroyed'))
      }
      worker.terminate()
    }, DESTROY_GRACE_MS)
  }

  return { respond, cancel, destroy }
}

// ---------------------------------------------------------------------------
// Tool bindings
// ---------------------------------------------------------------------------

const invalidInputMessage = (errors: { instancePath: string; message?: string }[] | null | undefined): string =>
  `invalid input: ${errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`

/**
 * Bind the model tool to an executor. The schema is the trust boundary:
 * model input is validated here once, and the executor receives only valid
 * input.
 */
export const createModelTools = (executor: ModelExecutor): { modelRespond: ModelRespondTool } => {
  const modelRespond = defineTool(
    {
      name: MODEL_RESPOND_TOOL_NAME,
      description:
        'Send input items to an Open Responses endpoint. Returns output items (message, ' +
        'function_call, …) plus status and usage. function_call items are data only — the ' +
        'caller dispatches them.',
      inputSchema: ModelRespondInputSchema,
      outputSchema: ModelRespondOutputSchema,
    },
    (input, validate): Promise<ModelRespondOutput> => {
      if (!validate.input(input)) return Promise.resolve(abortedResult(invalidInputMessage(validate.input.errors)))
      return executor.respond(input)
    },
  )

  return { modelRespond }
}

// ---------------------------------------------------------------------------
// Scripted executor — deterministic in-process double (no worker, no fetch)
// ---------------------------------------------------------------------------

/**
 * Build the model tool bound to a {@link Script} instead of a worker — no
 * fetch, no network, no worker. Same `{ modelRespond }` shape and the same
 * input/output schemas as {@link createModelTools}, so the turn loop,
 * dispatch bridge, and CLI seam run identically against the scripted or the
 * live worker. This is a host-side test/dev double for CLI/CI determinism — it
 * is deliberately NOT part of the worker.
 *
 * @public
 */
export const createScriptedModelTools = ({ script }: { script: Script }): { modelRespond: ModelRespondTool } => {
  let callIndex = 0
  const resolveScript = async (input: ModelRespondInput, idx: number): Promise<ScriptedResponse> => {
    if (typeof script === 'function') return script(input, idx)
    if (Array.isArray(script)) return script[Math.min(idx, script.length - 1)]!
    return script
  }
  const modelRespond = defineTool(
    {
      name: MODEL_RESPOND_TOOL_NAME,
      description:
        'Scripted (deterministic) model-respond — returns a canned response per call with no fetch. ' +
        'Same input/output shape as the live model-respond; provisioned for dev/CI determinism. ' +
        'function_call items are data only — the caller dispatches them.',
      inputSchema: ModelRespondInputSchema,
      outputSchema: ModelRespondOutputSchema,
    },
    async (input, validate): Promise<ModelRespondOutput> => {
      if (!validate.input(input)) return abortedResult(invalidInputMessage(validate.input.errors))
      const idx = callIndex
      callIndex += 1
      const canned = await resolveScript(input, idx)
      return {
        items: canned.items,
        status: canned.status,
        ...(canned.usage !== undefined && { usage: canned.usage }),
        ...(canned.error !== undefined && { error: canned.error }),
      }
    },
  )
  return { modelRespond }
}

/**
 * The default canned model-respond: a single completed assistant message —
 * the deterministic `createKernel()` floor when no `modelTools` override is
 * supplied.
 *
 * @public
 */
export const DEFAULT_SCRIPTED_RESPONSE: ScriptedResponse = {
  items: [
    {
      id: 'msg_scripted_final',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'OK' }],
    },
  ],
  status: 'completed',
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}

// Keep the reasoning-effort type (spec ReasoningEffortEnum) in the public
// surface of this module.
export type { ReasoningEffort } from './responses-client.schemas.ts'

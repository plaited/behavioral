/**
 * Model worker — executes one Open Responses call per request (`/responses`),
 * streams semantic SSE events to the host as they arrive as `DELTA`, and
 * returns a single terminal `RESULT`.
 *
 * @remarks
 * Spawned by URL from `use-responses-client.ts` (`new Worker(new URL('./responses-client.worker.ts', ...))`)
 * and imported by nobody, so it needs no main-vs-worker detection.
 *
 * Endpoint config (URL + resolved API key + extra headers) is delivered via
 * `setEnvironmentData` before the worker is spawned and read once at startup
 * with `getEnvironmentData` — secrets never enter a request message or the
 * model-facing schema.
 *
 * The worker holds no orchestration: it is a dumb per-request executor.
 * Recursive/parallel model calls (RLM) are decisions the behavioral threads
 * make by issuing more requests; the worker just answers each one.
 *
 * MINIMAL: no request-level concurrency cap — the host/threads decide how many
 * calls to have in flight. Upgrade path: an executor-side queue if a runaway
 * fan-out ever needs bounding.
 *
 * @packageDocumentation
 */

import { getEnvironmentData } from 'node:worker_threads'
import {
  ErrorSchema,
  type KnownStreamEvent,
  KnownStreamEventSchema,
  makeSchema,
  type Error as OpenResponsesError,
  type OpenResponsesStreamEvent,
  type OutputItem,
  OutputItemSchema,
  StreamEventLaxSchema,
  type Usage,
  UsageSchema,
} from './open-responses.schemas.ts'
import {
  MODEL_ENDPOINTS_KEY,
  type ModelDeltaEvent,
  type ModelEndpointConfig,
  type ModelEndpoints,
  type ModelInbound,
  type ModelRespondInput,
  type ModelRespondOutput,
  type ModelResultEvent,
} from './open-responses.types.ts'

// ---------------------------------------------------------------------------
// Endpoint config (environment data — seeded by the host before spawn)
// ---------------------------------------------------------------------------

const endpoints = (getEnvironmentData(MODEL_ENDPOINTS_KEY) ?? {}) as ModelEndpoints

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

const joinUrl = (base: string, path: string): string => `${base.replace(/\/$/, '')}${path}`

const buildHeaders = (endpoint: ModelEndpointConfig): Record<string, string> => ({
  'content-type': 'application/json',
  ...(endpoint.apiKey !== undefined && { authorization: `Bearer ${endpoint.apiKey}` }),
  ...endpoint.headers,
})

const FETCH_TIMEOUT_MS = 60_000

/**
 * Structured error body ({ error: { code, message } }) on a non-2xx response,
 * per the spec. Falls back to the raw body text when the shape doesn't match.
 */
const describeHttpError = async (res: Response): Promise<string> => {
  let detail = ''
  try {
    const raw = await res.text()
    const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } }
    if (parsed.error && typeof parsed.error === 'object') {
      const { code, message } = parsed.error
      detail = `${typeof code === 'string' ? code : 'unknown_error'}: ${typeof message === 'string' ? message : raw}`
    } else {
      detail = raw
    }
  } catch {
    detail = ''
  }
  return `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`
}

/** Tool-input fields with named wire mappings — everything else passes through. */
const NAMED_INPUT_KEYS = new Set([
  'provider',
  'modelId',
  'input',
  'tools',
  'instructions',
  'truncation',
  'stream',
  'reasoningEffort',
])

const buildRespondBody = (input: ModelRespondInput): Record<string, unknown> => {
  const body: Record<string, unknown> = { model: input.modelId, input: input.input }
  // Passthrough: spec params we do not name + endpoint extensions cross the
  // wire verbatim. Named mappings are assigned after, so they win collisions.
  for (const [key, value] of Object.entries(input)) {
    if (NAMED_INPUT_KEYS.has(key) || value === undefined) continue
    body[key] = value
  }
  if (input.tools !== undefined) body.tools = input.tools
  if (input.instructions !== undefined) body.instructions = input.instructions
  if (input.truncation !== undefined) body.truncation = input.truncation
  if (input.stream === true) body.stream = true
  if (input.reasoningEffort !== undefined) body.reasoning = { effort: input.reasoningEffort }
  return body
}

// ---------------------------------------------------------------------------
// Response schemas (lax envelopes — the strict content lives in the item union)
// ---------------------------------------------------------------------------

const usageJsonSchema = UsageSchema.schema
const errorJsonSchema = ErrorSchema.schema
const outputItemJsonSchema = OutputItemSchema.schema

type ResponseResource = {
  id: string
  object: string
  status: string
  output: OutputItem[]
  usage?: Usage
  error?: OpenResponsesError | null
}

const responseResourceSchema = makeSchema<ResponseResource>({
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    status: { type: 'string' },
    model: { type: 'string' },
    output: { type: 'array', items: outputItemJsonSchema },
    usage: { ...usageJsonSchema, additionalProperties: true, nullable: true },
    error: { ...errorJsonSchema, additionalProperties: true, nullable: true },
  },
  required: ['id', 'object', 'status', 'output'],
  additionalProperties: true,
})

// ---------------------------------------------------------------------------
// SSE streaming — parse frames incrementally and post a DELTA per event
// ---------------------------------------------------------------------------

type StreamOutcome =
  | { events: OpenResponsesStreamEvent[]; knownEvents: KnownStreamEvent[] }
  | { isError: true; message: string }

/** Parse the body of a `text/event-stream` response, invoking `onEvent` per frame. */
const streamEvents = async (
  body: ReadableStream<Uint8Array>,
  onEvent: (event: OpenResponsesStreamEvent) => void,
): Promise<StreamOutcome> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: OpenResponsesStreamEvent[] = []
  const knownEvents: KnownStreamEvent[] = []

  const consumeFrame = (frame: string): StreamOutcome | 'continue' | 'done' => {
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (line === undefined) return 'continue'
    const payload = line.slice('data: '.length).trim()
    if (payload.length === 0) return 'continue'
    if (payload === '[DONE]') return 'done'
    let data: unknown
    try {
      data = JSON.parse(payload)
    } catch {
      return { isError: true, message: `malformed SSE frame: ${payload.slice(0, 120)}` }
    }
    // Strict known-event validation first (full discrimination for assembly);
    // unknown provider extras fall through to the lax passthrough schema.
    const known = KnownStreamEventSchema.safeParse(data)
    if (known.success) {
      events.push(known.data)
      knownEvents.push(known.data)
      onEvent(known.data)
      return 'continue'
    }
    const lax = StreamEventLaxSchema.safeParse(data)
    if (!lax.success) {
      return { isError: true, message: `invalid stream event: ${lax.error.message}` }
    }
    events.push(lax.data)
    onEvent(lax.data)
    return 'continue'
  }

  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx = buffer.indexOf('\n\n')
    while (idx !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const outcome = consumeFrame(frame)
      if (outcome === 'done') return { events, knownEvents }
      if (outcome !== 'continue') return outcome
      idx = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim().length > 0) {
    const outcome = consumeFrame(buffer)
    if (outcome !== 'continue' && outcome !== 'done') return outcome
  }
  return { events, knownEvents }
}

/** Assemble items/status/usage/error from the terminal stream events. */
const assembleResponse = (events: OpenResponsesStreamEvent[], knownEvents: KnownStreamEvent[]): ModelRespondOutput => {
  const items: OutputItem[] = []
  let status = 'completed'
  let usage: Usage | undefined
  let error: OpenResponsesError | undefined
  for (const ev of knownEvents) {
    if (ev.type === 'response.output_item.done') {
      items.push(ev.item)
    } else if (ev.type === 'response.completed') {
      status = 'completed'
      usage = ev.usage
    } else if (ev.type === 'response.failed') {
      status = 'failed'
      error = ev.error
      usage = ev.usage
    } else if (ev.type === 'response.incomplete') {
      status = 'incomplete'
      usage = ev.usage
    }
  }
  return {
    events,
    items,
    status,
    ...(usage !== undefined && { usage }),
    ...(error !== undefined && { error }),
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type ActiveRequest = {
  controller: AbortController
  /** First stop reason wins. */
  reason: 'canceled' | 'timeout' | null
  timer: ReturnType<typeof setTimeout>
}

/** In-flight requests, keyed by correlation id. */
const active = new Map<string, ActiveRequest>()

const postDelta = (id: string, event: OpenResponsesStreamEvent): void => {
  const message: ModelDeltaEvent = { type: 'DELTA', id, event }
  self.postMessage(message)
}

const postResult = (id: string, result: ModelRespondOutput): void => {
  const message: ModelResultEvent = { type: 'RESULT', id, result }
  self.postMessage(message)
}

const runRespond = async (
  id: string,
  input: ModelRespondInput,
  request: ActiveRequest,
): Promise<ModelRespondOutput> => {
  const endpoint = endpoints[input.provider]
  if (!endpoint) return { isError: true, message: `[Error: unknown provider "${input.provider}"]` }
  try {
    const res = await fetch(joinUrl(endpoint.url, '/responses'), {
      method: 'POST',
      headers: buildHeaders(endpoint),
      body: JSON.stringify(buildRespondBody(input)),
      signal: request.controller.signal,
    })
    if (!res.ok) return { isError: true, message: await describeHttpError(res) }
    if (input.stream === true && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const outcome = await streamEvents(res.body as ReadableStream<Uint8Array>, (event) => postDelta(id, event))
      if ('isError' in outcome) return outcome
      return assembleResponse(outcome.events, outcome.knownEvents)
    }
    const parsed = responseResourceSchema.safeParse(await res.json())
    if (!parsed.success) return { isError: true, message: 'invalid response resource from endpoint' }
    return {
      items: parsed.data.output,
      status: parsed.data.status,
      ...(parsed.data.usage !== undefined && { usage: parsed.data.usage }),
      ...(parsed.data.error != null && { error: parsed.data.error }),
    }
  } catch (error) {
    if (request.reason === 'timeout')
      return { isError: true, message: `model request timed out after ${FETCH_TIMEOUT_MS}ms` }
    if (request.reason === 'canceled') return { isError: true, message: 'model request canceled' }
    return { isError: true, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Route one inbound message. */
const handleInbound = async (message: ModelInbound): Promise<void> => {
  if (message.type === 'CANCEL') {
    const request = active.get(message.id)
    if (request !== undefined && request.reason === null) {
      request.reason = 'canceled'
      request.controller.abort()
    }
    return
  }

  const controller = new AbortController()
  const request: ActiveRequest = {
    controller,
    reason: null,
    timer: setTimeout(() => {
      if (request.reason === null) {
        request.reason = 'timeout'
        controller.abort()
      }
    }, FETCH_TIMEOUT_MS),
  }
  active.set(message.id, request)

  // `respond` never rejects: any worker-side throw becomes result data.
  try {
    const result = await runRespond(message.id, message.input, request)
    postResult(message.id, result)
  } catch (err) {
    postResult(message.id, { isError: true, message: err instanceof Error ? err.message : String(err) })
  } finally {
    clearTimeout(request.timer)
    active.delete(message.id)
  }
}

// The wire payload is produced by our own host code, so it is typed by
// assertion rather than re-validated here — model input is validated once, at
// the tool boundary (see `use-responses-client.ts`). MINIMAL: add an AJV wire validator if
// the worker ever accepts messages from outside this process.
self.onmessage = (event: MessageEvent): void => {
  void handleInbound(event.data as ModelInbound)
}

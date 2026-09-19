/**
 * Wire and option types shared by the model worker (`responses-client.worker.ts`)
 * and its host consumer (`responses-client.ts`).
 *
 * @remarks
 * `responses-client.worker.ts` mounts `self.onmessage` at top level, so the host
 * must never import it; both sides import here instead. Types plus one
 * side-effect-free key constant — the key is the only runtime value, so both
 * sides agree on the `setEnvironmentData` / `getEnvironmentData` key without
 * a circular import.
 */

import type {
  FunctionTool,
  InputItem,
  Error as OpenResponsesError,
  OpenResponsesStreamEvent,
  OutputItem,
  ReasoningEffort,
  Truncation,
  Usage,
} from './responses-client.schemas.ts'

export type { ReasoningEffort }

/**
 * One provisioned Open Responses endpoint. `apiKey` must already be resolved
 * at provisioning time — it is never model-facing and never crosses the wire
 * in a request message (the host delivers the whole map via environment data).
 */
export type ModelEndpointConfig = {
  /**
   * The full base URL the operation path appends to (`/responses`) — no
   * `/v1/` prefix is added.
   */
  url: string
  apiKey?: string
  headers?: Record<string, string>
}

/** Provider label → endpoint config. Delivered to the worker via environment data. */
export type ModelEndpoints = Record<string, ModelEndpointConfig>

/** Environment-data key for the provisioned endpoint map (host seeds, worker reads). */
export const MODEL_ENDPOINTS_KEY = 'behavioral:model-endpoints'

// ---------------------------------------------------------------------------
// model-respond — input / output
// ---------------------------------------------------------------------------

export type ModelRespondInput = {
  provider: string
  modelId: string
  input: InputItem[]
  tools?: FunctionTool[]
  instructions?: string
  truncation?: Truncation
  stream?: boolean
  /** Spec ReasoningEffortEnum value, or a non-spec value passed through verbatim. */
  reasoningEffort?: ReasoningEffort | (string & {})
  /**
   * Passthrough: spec request params we do not name + endpoint extensions,
   * forwarded to the request body verbatim (named fields win on collision).
   */
  [key: string]: unknown
}

/**
 * Success: items + terminal status (+ usage / structured error, and the full
 * streamed event list when `stream` is set). Errors are data, never throws:
 * `{ isError: true, message }` for unknown provider / transport / HTTP failure.
 */
export type ModelRespondOutput =
  | {
      items: OutputItem[]
      status: string
      events?: OpenResponsesStreamEvent[]
      usage?: Usage
      error?: OpenResponsesError
    }
  | { isError: true; message: string }

// ---------------------------------------------------------------------------
// Wire protocol (host ⇄ worker)
// ---------------------------------------------------------------------------

/** Host → worker: run one respond call. */
export type ModelRespondRequest = { type: 'RESPOND'; id: string; input: ModelRespondInput }

/** Host → worker: stop one in-flight call. */
export type ModelCancelRequest = { type: 'CANCEL'; id: string; reason?: string }

/** Messages the worker accepts. */
export type ModelInbound = ModelRespondRequest | ModelCancelRequest

/** Worker → host: one streamed semantic event, emitted as it arrives. */
export type ModelDeltaEvent = { type: 'DELTA'; id: string; event: OpenResponsesStreamEvent }

/** Worker → host: the one terminal event per call. */
export type ModelResultEvent = { type: 'RESULT'; id: string; result: ModelRespondOutput }

/** Messages the worker emits. */
export type ModelOutbound = ModelDeltaEvent | ModelResultEvent

// ---------------------------------------------------------------------------
// Scripted (host-side, in-process) — deterministic test/dev double
// ---------------------------------------------------------------------------

/**
 * One canned model-respond response. Not part of the Open Responses spec and
 * never part of the worker — this backs the in-process deterministic executor
 * used by the CLI turn seam and unit tests.
 */
export type ScriptedResponse = {
  items: OutputItem[]
  status: string
  usage?: Usage
  error?: OpenResponsesError
}

/**
 * The scripted source: a single canned response (repeated every call), an
 * array advanced one entry per call (clamped to the last), or a function of
 * `(input, callIndex)`.
 */
export type Script =
  | ScriptedResponse
  | ScriptedResponse[]
  | ((input: ModelRespondInput, callIndex: number) => ScriptedResponse | Promise<ScriptedResponse>)

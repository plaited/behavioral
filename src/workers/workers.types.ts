import type { JSONSchemaType } from 'ajv'
import { ajv, type BPEvent, type JsonObject, type Thread } from '../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from './workers.constants.ts'

/*
 * Worker event-wire vocabulary — every request/result event family plus validators.
 *
 * Behavioral defines the protocol; worker families adapt to speak it. These are
 * the events the router moves between the engine port and the satellite worker
 * ports — the engine itself is generic over BPEvent and never imports these.
 *
 * Shape rules settled in the router design:
 * - correlation id lives INSIDE `detail` (no wire envelope) — threads match
 *   their results via listener `detailSchema` on `detail.id`
 * - requests carry `{ id, input }`; results carry `{ id, result }`; cancels `{ id }`
 * - `input`/`result` are loose JsonObject payloads: their strict schemas keep
 *   their one home in the worker families (no cross-module drift)
 * - `ingress` never survives the boundary: routed events are synthesized by
 *   workers, and `additionalProperties: false` rejects its presence (proven in
 *   the spec) — so the field is deliberately absent from the types
 *
 * @public
 */

export type ResponseRequestEvent = {
  type: typeof WORKER_MESSAGE_KINDS.response_request
  detail: { id: string; input: JsonObject }
  space?: string
}

export type ResponseRequestResultEvent = {
  type: typeof WORKER_MESSAGE_KINDS.response_request_result
  detail: { id: string; result: JsonObject }
  space?: string
}

export type ResponseCancelEvent = {
  type: typeof WORKER_MESSAGE_KINDS.response_cancel
  detail: { id: string }
  space?: string
}

export type ToolCallEvent = {
  type: typeof WORKER_MESSAGE_KINDS.tool_call
  detail: { id: string; tool: string; input: JsonObject }
  space?: string
}

export type ToolCallResultEvent = {
  type: typeof WORKER_MESSAGE_KINDS.tool_call_result
  detail: { id: string; result: JsonObject }
  space?: string
}

export type ToolCancelEvent = {
  type: typeof WORKER_MESSAGE_KINDS.tool_cancel
  detail: { id: string }
  space?: string
}

export type WorkerErrorEvent = {
  type: typeof WORKER_MESSAGE_KINDS.worker_error
  detail: { worker: string; message: string }
  space?: string
}

/** Frontier operations — its own worker family, like the responses client. */
export type FrontierOp = 'replay' | 'explore' | 'verify'

export type FrontierRequestEvent = {
  type: typeof WORKER_MESSAGE_KINDS.frontier_request
  /** `op` selects the analysis; the worker shares no event types with the tools family. */
  detail: { id: string; op: FrontierOp; input: JsonObject }
  space?: string
}

export type FrontierRequestResultEvent = {
  type: typeof WORKER_MESSAGE_KINDS.frontier_request_result
  detail: { id: string; result: JsonObject }
  space?: string
}

/** Store operations — durable, space-scoped persistence for data that must survive invocations. */
export type StoreOp = 'put' | 'get' | 'delete' | 'query'

export type StoreRequestEvent = {
  type: typeof WORKER_MESSAGE_KINDS.store_request
  /** `op` selects the store operation; the backing schema lives inside the worker — schema churn never becomes protocol churn. */
  detail: { id: string; op: StoreOp; input: JsonObject }
  space?: string
}

// No store cancel: ops are short-lived (frontier rule).
export type StoreRequestResultEvent = {
  type: typeof WORKER_MESSAGE_KINDS.store_request_result
  detail: { id: string; result: JsonObject }
  space?: string
}

/** Union of every event the router can move between ports. @public */
export type WorkerEvent =
  | ResponseRequestEvent
  | ResponseRequestResultEvent
  | ResponseCancelEvent
  | ToolCallEvent
  | ToolCallResultEvent
  | ToolCancelEvent
  | FrontierRequestEvent
  | FrontierRequestResultEvent
  | StoreRequestEvent
  | StoreRequestResultEvent
  | WorkerErrorEvent

const jsonObjectSchema = { type: 'object', required: [], additionalProperties: true } as const

export const ResponseRequestEventSchema: JSONSchemaType<ResponseRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.response_request },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, input: jsonObjectSchema },
      required: ['id', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const ResponseRequestResultEventSchema: JSONSchemaType<ResponseRequestResultEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.response_request_result },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, result: jsonObjectSchema },
      required: ['id', 'result'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const ResponseCancelEventSchema: JSONSchemaType<ResponseCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.response_cancel },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const ToolCallEventSchema: JSONSchemaType<ToolCallEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.tool_call },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, tool: { type: 'string' }, input: jsonObjectSchema },
      required: ['id', 'tool', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const ToolCallResultEventSchema: JSONSchemaType<ToolCallResultEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.tool_call_result },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, result: jsonObjectSchema },
      required: ['id', 'result'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const ToolCancelEventSchema: JSONSchemaType<ToolCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.tool_cancel },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const WorkerErrorEventSchema: JSONSchemaType<WorkerErrorEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.worker_error },
    detail: {
      type: 'object',
      properties: { worker: { type: 'string' }, message: { type: 'string' } },
      required: ['worker', 'message'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const validateResponseRequestEvent = ajv.compile(ResponseRequestEventSchema)
export const validateResponseRequestResultEvent = ajv.compile(ResponseRequestResultEventSchema)
export const validateResponseCancelEvent = ajv.compile(ResponseCancelEventSchema)
export const validateToolCallEvent = ajv.compile(ToolCallEventSchema)
export const validateToolCallResultEvent = ajv.compile(ToolCallResultEventSchema)
export const validateToolCancelEvent = ajv.compile(ToolCancelEventSchema)
// No frontier cancel event: analyses are synchronous — nothing is in flight
// to abort (the async families keep their cancels).
export const FrontierRequestEventSchema: JSONSchemaType<FrontierRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.frontier_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        op: { type: 'string', enum: ['replay', 'explore', 'verify'] },
        input: jsonObjectSchema,
      },
      required: ['id', 'op', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const FrontierRequestResultEventSchema: JSONSchemaType<FrontierRequestResultEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.frontier_request_result },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, result: jsonObjectSchema },
      required: ['id', 'result'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

// No store cancel: ops are short-lived (same rule as frontier).
export const StoreRequestEventSchema: JSONSchemaType<StoreRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.store_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        op: { type: 'string', enum: ['put', 'get', 'delete', 'query'] },
        input: jsonObjectSchema,
      },
      required: ['id', 'op', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const StoreRequestResultEventSchema: JSONSchemaType<StoreRequestResultEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: WORKER_MESSAGE_KINDS.store_request_result },
    detail: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, result: jsonObjectSchema },
      required: ['id', 'result'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const validateWorkerErrorEvent = ajv.compile(WorkerErrorEventSchema)
export const validateFrontierRequestEvent = ajv.compile(FrontierRequestEventSchema)
export const validateFrontierRequestResultEvent = ajv.compile(FrontierRequestResultEventSchema)
export const validateStoreRequestEvent = ajv.compile(StoreRequestEventSchema)
export const validateStoreRequestResultEvent = ajv.compile(StoreRequestResultEventSchema)

/**
 * The engine transport — what the router posts INTO the engine worker.
 * Two kinds, both of which evaluate.
 */
export type AddThreadsMessage = {
  kind: typeof WORKER_MESSAGE_KINDS.add_threads
  threads: Thread[]
}

export type TriggerMessage = {
  kind: typeof WORKER_MESSAGE_KINDS.trigger
  event: BPEvent
}

export type WorkerMessage = AddThreadsMessage | TriggerMessage

import type { JSONSchemaType } from 'ajv'
import { WORKER_MESSAGE_KINDS } from './behavioral.constants.ts'
import { ajv, type JsonObject } from './behavioral.types.ts'

/*
 * Router-domain event vocabulary for `use-behavioral.ts`.
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

/** Union of every event the router can move between ports. @public */
export type WorkerEvent =
  | ResponseRequestEvent
  | ResponseRequestResultEvent
  | ResponseCancelEvent
  | ToolCallEvent
  | ToolCallResultEvent
  | ToolCancelEvent
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
export const validateWorkerErrorEvent = ajv.compile(WorkerErrorEventSchema)

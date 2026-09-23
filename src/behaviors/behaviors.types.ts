import type { JSONSchemaType } from 'ajv'
import { ajv, type JsonObject, type Thread } from '../behavioral/behavioral.types.ts'
import { BEHAVIOR_MESSAGE_KINDS } from './behaviors.constants.ts'

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
 * - requests carry `{ id, input }` (the shell family adds an optional `label`); results carry `{ id, result }`; cancels `{ id }`
 * - `input`/`result` are loose JsonObject payloads: their strict schemas keep
 *   their one home in the worker families (no cross-module drift)
 * - `ingress` never survives the boundary: routed events are synthesized by
 *   behavior files, and `additionalProperties: false` rejects its presence (proven in
 *   the spec) — so the field is deliberately absent from the types
 *
 * @public
 */

export type SystemTwoRequestEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.system_two_request
  detail: { id: string; input: JsonObject }
  space?: string
}

export type SystemTwoRequestResultEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.system_two_request_result
  detail: WorkerResultDetail
  space?: string
}

export type SystemTwoCancelEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.system_two_cancel
  detail: { id: string }
  space?: string
}

export type SystemOneRequestEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.system_one_request
  detail: { id: string; input: JsonObject }
  space?: string
}

export type SystemOneRequestResultEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.system_one_request_result
  detail: WorkerResultDetail
  space?: string
}

export type SystemOneCancelEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.system_one_cancel
  detail: { id: string }
  space?: string
}

export type ShellRequestEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.shell_request
  /** `label` is an optional trace annotation (logical names like 'skill-scan') — no routing weight. */
  detail: { id: string; label?: string; input: JsonObject }
  space?: string
}

export type ShellRequestResultEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.shell_request_result
  detail: WorkerResultDetail
  space?: string
}

export type ShellCancelEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.shell_cancel
  detail: { id: string }
  space?: string
}

/**
 * The uniform result detail — every family's `*_result` event carries this
 * two-branch shape (modified-B envelope, ruled 2026-09-21): the `ok`
 * discriminant sits at detail level beside the correlation id; `result` and
 * `error` are XOR branches (oneOf on the ok const). Family statuses ride as
 * `error.code` (mcp's typed `authorization_required` included — first-class
 * preserved, its request echo rides inside `error`); success payloads ride
 * `result` verbatim. Uniform gate across every family: `select($d.ok)`.
 */
export type WorkerResultOk = {
  id: string
  ok: true
  result: JsonObject
}

export type WorkerResultError = {
  id: string
  ok: false
  /** The family failure payload — code (the family status enum), message, and any diagnostics. */
  error: { code: string; message?: string } & JsonObject
}

/** The `detail` of every `*_result` event — one shape across all five families. */
export type WorkerResultDetail = WorkerResultOk | WorkerResultError

export type BehaviorErrorEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.behavior_error
  detail: { behavior: string; message: string }
  space?: string
}

/** Frontier operations — its own worker family, like the responses client. */
export type FrontierOp = 'replay' | 'explore' | 'verify'

export type FrontierRequestEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.frontier_request
  /** `op` selects the analysis; the worker shares no event types with the tools family. */
  detail: { id: string; op: FrontierOp; input: JsonObject }
  space?: string
}

export type FrontierRequestResultEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.frontier_request_result
  detail: WorkerResultDetail
  space?: string
}

/** Store operations — durable, space-scoped persistence for data that must survive invocations. */
export type StoreOp = 'put' | 'get' | 'delete' | 'query'

export type StoreRequestEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.store_request
  /** `op` selects the store operation; the backing schema lives inside the worker — schema churn never becomes protocol churn. */
  detail: { id: string; op: StoreOp; input: JsonObject }
  space?: string
}

// No store cancel: ops are short-lived (frontier rule).
export type StoreRequestResultEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.store_request_result
  detail: WorkerResultDetail
  space?: string
}

/** MCP operations — its own worker family, like frontier and store. */
export type McpOp =
  | 'discover'
  | 'list-tools'
  | 'call-tool'
  | 'list-prompts'
  | 'get-prompt'
  | 'list-resources'
  | 'read-resource'

export type McpRequestEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.mcp_request
  /** `op` selects the MCP client operation; the backing schema lives in `src/behaviors/mcp/types.ts`. */
  detail: { id: string; op: McpOp; input: JsonObject }
  space?: string
}

export type McpRequestResultEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.mcp_request_result
  detail: WorkerResultDetail
  space?: string
}

// Remote MCP calls can hang indefinitely (third-party servers) — the async
// families keep their cancels (shell, response, mcp; frontier/store ops are
// short-lived and have none).
export type McpCancelEvent = {
  type: typeof BEHAVIOR_MESSAGE_KINDS.mcp_cancel
  detail: { id: string }
  space?: string
}

/** Union of every event the router can move between ports. @public */
export type WorkerEvent =
  | SystemTwoRequestEvent
  | SystemTwoRequestResultEvent
  | SystemTwoCancelEvent
  | SystemOneRequestEvent
  | SystemOneRequestResultEvent
  | SystemOneCancelEvent
  | ShellRequestEvent
  | ShellRequestResultEvent
  | ShellCancelEvent
  | McpRequestEvent
  | McpRequestResultEvent
  | McpCancelEvent
  | FrontierRequestEvent
  | FrontierRequestResultEvent
  | StoreRequestEvent
  | StoreRequestResultEvent
  | BehaviorErrorEvent

const jsonObjectSchema = { type: 'object', required: [], additionalProperties: true } as const

// ── The uniform result envelope — one home, five consumers ──────────────────

const workerResultOkBranch = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: true },
    result: jsonObjectSchema,
  },
  required: ['id', 'ok', 'result'],
  additionalProperties: false,
} as const

const workerResultErrorBranch = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean', const: false },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string', nullable: true },
      },
      required: ['code'],
      // Family diagnostics ride along (request echoes, exit codes, stderr…).
      additionalProperties: true,
    },
  },
  required: ['id', 'ok', 'error'],
  additionalProperties: false,
} as const

/** Build one family's `*_result` event schema over the shared detail branches. */
const resultEventSchema = (typeConst: string) =>
  ({
    type: 'object',
    properties: {
      type: { type: 'string', const: typeConst },
      detail: { type: 'object', oneOf: [workerResultOkBranch, workerResultErrorBranch] },
      space: { type: 'string', nullable: true },
    },
    required: ['type', 'detail'],
    additionalProperties: false,
  }) as unknown as import('ajv').JSONSchemaType<{ type: string; detail: WorkerResultDetail; space?: string }>

export const SystemTwoRequestEventSchema: JSONSchemaType<SystemTwoRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.system_two_request },
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

export const SystemTwoRequestResultEventSchema = resultEventSchema(BEHAVIOR_MESSAGE_KINDS.system_two_request_result)

export const SystemTwoCancelEventSchema: JSONSchemaType<SystemTwoCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.system_two_cancel },
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

export const SystemOneRequestEventSchema: JSONSchemaType<SystemOneRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.system_one_request },
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

export const SystemOneRequestResultEventSchema = resultEventSchema(BEHAVIOR_MESSAGE_KINDS.system_one_request_result)

export const SystemOneCancelEventSchema: JSONSchemaType<SystemOneCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.system_one_cancel },
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

export const ShellRequestEventSchema: JSONSchemaType<ShellRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.shell_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        label: { type: 'string', nullable: true },
        input: jsonObjectSchema,
      },
      required: ['id', 'input'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const ShellRequestResultEventSchema = resultEventSchema(BEHAVIOR_MESSAGE_KINDS.shell_request_result)

export const ShellCancelEventSchema: JSONSchemaType<ShellCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.shell_cancel },
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

export const McpRequestEventSchema: JSONSchemaType<McpRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.mcp_request },
    detail: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        op: {
          type: 'string',
          enum: [
            'discover',
            'list-tools',
            'call-tool',
            'list-prompts',
            'get-prompt',
            'list-resources',
            'read-resource',
          ],
        },
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

export const McpRequestResultEventSchema = resultEventSchema(BEHAVIOR_MESSAGE_KINDS.mcp_request_result)

export const McpCancelEventSchema: JSONSchemaType<McpCancelEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.mcp_cancel },
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

export const BehaviorErrorEventSchema: JSONSchemaType<BehaviorErrorEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.behavior_error },
    detail: {
      type: 'object',
      properties: { behavior: { type: 'string' }, message: { type: 'string' } },
      required: ['behavior', 'message'],
      additionalProperties: false,
    },
    space: { type: 'string', nullable: true },
  },
  required: ['type', 'detail'],
  additionalProperties: false,
}

export const validateSystemTwoRequestEvent = ajv.compile(SystemTwoRequestEventSchema)
export const validateSystemTwoRequestResultEvent = ajv.compile(SystemTwoRequestResultEventSchema)
export const validateSystemTwoCancelEvent = ajv.compile(SystemTwoCancelEventSchema)
export const validateSystemOneRequestEvent = ajv.compile(SystemOneRequestEventSchema)
export const validateSystemOneRequestResultEvent = ajv.compile(SystemOneRequestResultEventSchema)
export const validateSystemOneCancelEvent = ajv.compile(SystemOneCancelEventSchema)
export const validateShellRequestEvent = ajv.compile(ShellRequestEventSchema)
export const validateShellRequestResultEvent = ajv.compile(ShellRequestResultEventSchema)
export const validateShellCancelEvent = ajv.compile(ShellCancelEventSchema)
export const validateMcpRequestEvent = ajv.compile(McpRequestEventSchema)
export const validateMcpRequestResultEvent = ajv.compile(McpRequestResultEventSchema)
export const validateMcpCancelEvent = ajv.compile(McpCancelEventSchema)
// No frontier cancel event: analyses are synchronous — nothing is in flight
// to abort (the async families keep their cancels).
export const FrontierRequestEventSchema: JSONSchemaType<FrontierRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.frontier_request },
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

export const FrontierRequestResultEventSchema = resultEventSchema(BEHAVIOR_MESSAGE_KINDS.frontier_request_result)

// No store cancel: ops are short-lived (same rule as frontier).
export const StoreRequestEventSchema: JSONSchemaType<StoreRequestEvent> = {
  type: 'object',
  properties: {
    type: { type: 'string', const: BEHAVIOR_MESSAGE_KINDS.store_request },
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

export const StoreRequestResultEventSchema = resultEventSchema(BEHAVIOR_MESSAGE_KINDS.store_request_result)

export const validateBehaviorErrorEvent = ajv.compile(BehaviorErrorEventSchema)
export const validateFrontierRequestEvent = ajv.compile(FrontierRequestEventSchema)
export const validateFrontierRequestResultEvent = ajv.compile(FrontierRequestResultEventSchema)
export const validateStoreRequestEvent = ajv.compile(StoreRequestEventSchema)
export const validateStoreRequestResultEvent = ajv.compile(StoreRequestResultEventSchema)

export type AddThreads = (newThreads: Thread[]) => void

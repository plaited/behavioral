/**
 * Types shared by the mcp faculty process (`mcp/faculty.ts`) and its
 * event-wire consumers.
 *
 * @remarks
 * Types + op-input schemas only — no runtime behavior beyond compiled
 * validators, so importing this module has no side effects on either side of
 * the process boundary. The faculty runs as a spawned process (stdio lines,
 * never imported by the host), so the host must never import the faculty for
 * types; both sides import here instead. The wire itself is the behavioral
 * event vocabulary (`mcp_request` / `mcp_cancel` in, one `mcp_request_result`
 * out) defined in `src/faculties/faculties.types.ts` — only the
 * `detail.input` and `detail.result` payload shapes live here.
 *
 * Per the 2026-09-21 worker-conversion ruling: per-call input
 * credentials are RETIRED — `detail.input` carries the server URL and the
 * op's own fields, never an `auth` config or credential headers. Auth binds
 * at the worker's module scope from env-data (broker) with the keychain
 * floor. Failure is typed `authorization_required` — errors-as-data, the
 * replay spine's trigger.
 *
 * MINIMAL: op outputs are not schema-validated — remote MCP data passes
 * through loose (payloads-loose); consumers gate with their own
 * detailSchema. Upgrade path: per-op output schemas as exported schema-data
 * when a consumer needs them.
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import { ajv, type JsonObject } from '../../behavioral/behavioral.types.ts'
import type { McpOp } from '../faculties.types.ts'

// ---------------------------------------------------------------------------
// Env-data — the vend's broker binding. One home: `security/types.ts` (the
// security faculty's); re-exported here until the mcp faculty's deprecation.
// ---------------------------------------------------------------------------

export { MCP_BROKER_BOOT_SECRET_KEY, MCP_BROKER_URL_KEY } from '../security/types.ts'

// ---------------------------------------------------------------------------
// Op inputs — one shape per op, no `mode` discriminator, no auth fields
// ---------------------------------------------------------------------------

export type McpSharedInput = {
  /** Remote MCP server URL. */
  url: string
  /** Wall-clock deadline for the whole call (connect + op). */
  timeoutMs?: number
}

export type McpCallToolOpInput = McpSharedInput & { tool: string; args: Record<string, unknown> }
export type McpListToolsOpInput = McpSharedInput
export type McpListPromptsOpInput = McpSharedInput
export type McpGetPromptOpInput = McpSharedInput & { name: string; args?: Record<string, string> }
export type McpListResourcesOpInput = McpSharedInput
export type McpReadResourceOpInput = McpSharedInput & { uri: string }
export type McpDiscoverOpInput = McpSharedInput

const sharedProperties = {
  url: { type: 'string', minLength: 1, description: 'remote MCP server URL' },
  timeoutMs: {
    type: 'integer',
    minimum: 1,
    nullable: true,
    description: 'wall-clock deadline for the whole call (connect + op) in milliseconds',
  },
} as const

export const McpCallToolOpInputSchema: JSONSchemaType<McpCallToolOpInput> = {
  type: 'object',
  properties: {
    ...sharedProperties,
    tool: { type: 'string', minLength: 1, description: 'tool name to call' },
    args: {
      type: 'object',
      additionalProperties: true,
      description: 'tool arguments — a JSON object, passed through to the remote server',
    },
  },
  required: ['url', 'tool', 'args'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpCallToolOpInput>

export const McpListToolsOpInputSchema: JSONSchemaType<McpListToolsOpInput> = {
  type: 'object',
  properties: { ...sharedProperties },
  required: ['url'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpListToolsOpInput>

export const McpListPromptsOpInputSchema: JSONSchemaType<McpListPromptsOpInput> = McpListToolsOpInputSchema

export const McpListResourcesOpInputSchema: JSONSchemaType<McpListResourcesOpInput> = McpListToolsOpInputSchema

export const McpDiscoverOpInputSchema: JSONSchemaType<McpDiscoverOpInput> = McpListToolsOpInputSchema

export const McpGetPromptOpInputSchema: JSONSchemaType<McpGetPromptOpInput> = {
  type: 'object',
  properties: {
    ...sharedProperties,
    name: { type: 'string', minLength: 1, description: 'prompt name' },
    args: {
      type: 'object',
      additionalProperties: { type: 'string' },
      nullable: true,
      description: 'prompt arguments',
    },
  },
  required: ['url', 'name'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpGetPromptOpInput>

export const McpReadResourceOpInputSchema: JSONSchemaType<McpReadResourceOpInput> = {
  type: 'object',
  properties: {
    ...sharedProperties,
    uri: { type: 'string', minLength: 1, description: 'resource URI to read' },
  },
  required: ['url', 'uri'],
  additionalProperties: false,
} as unknown as JSONSchemaType<McpReadResourceOpInput>

// ---------------------------------------------------------------------------
// The result envelope — typed auth-state rides first-class
// ---------------------------------------------------------------------------

/** Outcome discriminator for one mcp op execution. */
export type McpCallStatus = 'completed' | 'authorization_required' | 'timeout' | 'canceled' | 'error'

/**
 * The single terminal payload the worker returns on `mcp_request_result`.
 *
 * @remarks
 * Errors-as-data throughout: no throw crosses the wire. `authorization_required`
 * carries the originating request verbatim — the replay spine's capture
 * payload (the store never saw the request; the result is the only carrier).
 */
export type McpCallResult = {
  /** Correlation id, echoed from the request. */
  id: string
  /** Outcome discriminator. */
  status: McpCallStatus
  /** Elapsed wall-clock time in milliseconds. */
  durationMs: number
  /** Op output when status is completed. Loose remote MCP data (payloads-loose). */
  output?: JsonObject
  /** Failure detail; the authorization reason when status is authorization_required. */
  message?: string
  /** The originating request, echoed only on authorization_required — the replay payload. */
  request?: { op: McpOp; input: JsonObject }
}

// ---------------------------------------------------------------------------
// Op input boundary — the trust boundary for anything crossing into this
// process; one compiled validator per op.
// ---------------------------------------------------------------------------

export const validateMcpCallToolOpInput = ajv.compile(McpCallToolOpInputSchema)
export const validateMcpListToolsOpInput = ajv.compile(McpListToolsOpInputSchema)
export const validateMcpListPromptsOpInput = ajv.compile(McpListPromptsOpInputSchema)
export const validateMcpGetPromptOpInput = ajv.compile(McpGetPromptOpInputSchema)
export const validateMcpListResourcesOpInput = ajv.compile(McpListResourcesOpInputSchema)
export const validateMcpReadResourceOpInput = ajv.compile(McpReadResourceOpInputSchema)
export const validateMcpDiscoverOpInput = ajv.compile(McpDiscoverOpInputSchema)

/** Op input validator registry — one compiled validator per McpOp. */
export const MCP_OP_INPUT_VALIDATORS: Record<McpOp, (input: unknown) => boolean> = {
  'call-tool': validateMcpCallToolOpInput,
  'list-tools': validateMcpListToolsOpInput,
  'list-prompts': validateMcpListPromptsOpInput,
  'get-prompt': validateMcpGetPromptOpInput,
  'list-resources': validateMcpListResourcesOpInput,
  'read-resource': validateMcpReadResourceOpInput,
  discover: validateMcpDiscoverOpInput,
}

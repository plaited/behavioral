/**
 * The mcp-client thread library — auth-failure orchestration over the worker
 * wire. Composes ON TOP of the mcp-client tool; the tool works standalone
 * (the reusability test).
 *
 * Four single-rule monitor threads coordinate the toolsWorker with the
 * storeWorker per the broker design:
 *
 * - `call-capture` — every mcp tool_call is filed in the store (`mcp-calls`)
 *   keyed by the call id, so a failed call can be replayed after consent.
 * - `result-cleaner` — a terminal result without the auth marker deletes its
 *   capture (captures never outlive their calls).
 * - `auth-surfacer` — a result carrying the auth marker re-enters as
 *   `mcp_authorization_required` (host-routable: the PWA "authorize X" prompt
 *   per the broker ruling) and does NOT clean the capture — it is pending.
 * - `auth-retry` — `mcp_authorization_granted` (host ingress after the shell
 *   completes the flow) triggers a store get; a store result carrying the
 *   captured call replays the original tool_call and deletes the capture.
 *
 * Vocabulary (thread-owned): `mcp_authorization_required { id, reason }`,
 * `mcp_authorization_granted { id }`.
 *
 * MINIMAL: marker detection is textual (UnauthorizedError |
 * authorization_required) over the serialized ToolsResult — the CLI reports
 * the SDK's error on stderr. Upgrade path: the tool surfaces structured
 * auth-state in its output schema and the select narrows to a field test.
 * The replayer fires on any store get whose value carries mcpCall —
 * namespaced under `mcpCall` to avoid collisions; tighten when a second
 * store tenant exists.
 */
import type { Thread } from '../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../workers/workers.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Thread-owned event types (hosts route mcp_authorization_required; granted is host ingress). */
export const MCP_EVENT_TYPES = {
  authorizationRequired: 'mcp_authorization_required',
  authorizationGranted: 'mcp_authorization_granted',
} as const

/** The store collection holding captured mcp calls keyed by call id. */
export const MCP_CALLS_COLLECTION = 'mcp-calls'

const AUTH_MARKER = 'UnauthorizedError|authorization_required'

const STORE_REQUEST_DETAIL: Record<string, unknown> = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1 }, op: { type: 'string' }, input: { type: 'object' } },
  required: ['id', 'op', 'input'],
}

// ── Threads ───────────────────────────────────────────────────────────────────

/** call-capture — file every mcp tool_call in the store for possible replay. */
const callCapture: Thread = {
  label: 'mcp/call-capture',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.tool_call,
          query:
            '. as $d | select($d.tool | startswith("mcp-")) | {id: $d.id, op: "put", input: {collection: "mcp-calls", key: $d.id, value: {mcpCall: {tool: $d.tool, input: $d.input}}}}',
          target: WORKER_MESSAGE_KINDS.store_request,
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              tool: { type: 'string' },
              input: { type: 'object' },
            },
            required: ['id', 'tool'],
          },
        },
      ],
    },
  ],
}

/** result-cleaner — a terminal result without the auth marker deletes its capture. */
const resultCleaner: Thread = {
  label: 'mcp/result-cleaner',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.tool_call_result,
          query: `. as $d | ($d.result | tostring) as $r | select(($r | test("${AUTH_MARKER}")) | not) | {id: $d.id, op: "delete", input: {collection: "${MCP_CALLS_COLLECTION}", key: $d.id}}`,
          target: WORKER_MESSAGE_KINDS.store_request,
          detailSchema: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1 }, result: { type: 'object' } },
            required: ['id'],
          },
        },
      ],
    },
  ],
}

/** auth-surfacer — an auth-marker result surfaces to the host; the capture stays (pending). */
const authSurfacer: Thread = {
  label: 'mcp/auth-surfacer',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.tool_call_result,
          query: `. as $d | ($d.result | tostring) as $r | select($r | test("${AUTH_MARKER}")) | {id: $d.id, reason: "mcp call requires authorization"}`,
          target: MCP_EVENT_TYPES.authorizationRequired,
          detailSchema: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1 }, result: { type: 'object' } },
            required: ['id'],
          },
        },
      ],
    },
  ],
}

/** auth-retry — granted triggers the store get; the replayer replays + cleans below. */
const authRetry: Thread = {
  label: 'mcp/auth-retry',
  rules: [
    {
      transform: [
        {
          type: MCP_EVENT_TYPES.authorizationGranted,
          query: '. as $d | {id: $d.id, op: "get", input: {collection: "mcp-calls", key: $d.id}}',
          target: WORKER_MESSAGE_KINDS.store_request,
          detailSchema: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1 } },
            required: ['id'],
          },
        },
      ],
    },
  ],
}

/** replayer — a store result carrying the captured call replays the tool_call and deletes the capture. */
const replayer: Thread = {
  label: 'mcp/replayer',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.store_request_result,
          query:
            '. as $d | select($d.result.value.mcpCall != null) | {id: ($d.id + "-retry"), tool: $d.result.value.mcpCall.tool, input: $d.result.value.mcpCall.input}',
          target: WORKER_MESSAGE_KINDS.tool_call,
          detailSchema: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1 }, result: { type: 'object' } },
            required: ['id', 'result'],
          },
        },
        {
          type: WORKER_MESSAGE_KINDS.store_request_result,
          query:
            '. as $d | select($d.result.value.mcpCall != null) | {id: $d.id, op: "delete", input: {collection: "mcp-calls", key: $d.id}}',
          target: WORKER_MESSAGE_KINDS.store_request,
          detailSchema: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1 }, result: { type: 'object' } },
            required: ['id', 'result'],
          },
        },
      ],
    },
  ],
}

/** The mcp-client thread library — add to the program alongside the satellites. */
export const mcpThreads: Thread[] = [callCapture, resultCleaner, authSurfacer, authRetry, replayer]

export { STORE_REQUEST_DETAIL }

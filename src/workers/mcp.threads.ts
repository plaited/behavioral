/**
 * The mcp family's default thread pack — the cross-turn auth replay spine:
 * capture-on-auth-required, host surfacing, grant-triggered store get, and
 * the replayer. Ships with the family ("threads arrive with the worker they
 * drive"); requires store + mcp — useBehavioral mounts it only when both
 * are on.
 *
 * Moved from src/threads/mcp-client.ts when the packs became family-shipped.
 *
 * @packageDocumentation
 */

import type { Thread } from '../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from './workers.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Thread-owned event types (hosts route mcp_authorization_required; granted is host ingress). */
export const MCP_EVENT_TYPES = {
  authorizationRequired: 'mcp_authorization_required',
  authorizationGranted: 'mcp_authorization_granted',
} as const

/** The store collection holding captured mcp requests keyed by call id. */
export const MCP_CALLS_COLLECTION = 'mcp-calls'

const MCP_RESULT_DETAIL = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    ok: { type: 'boolean' },
    result: { type: 'object' },
    error: { type: 'object' },
  },
  required: ['id', 'ok'],
} as const

// ── Threads ───────────────────────────────────────────────────────────────────

/** auth-capture — file ONLY auth-failed requests; the result's echo is the payload. */
const authCapture: Thread = {
  label: 'mcp/auth-capture',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.mcp_request_result,
          query: `. as $d | select($d.ok == false and $d.error.code? == "authorization_required") | {id: $d.id, op: "put", input: {collection: "${MCP_CALLS_COLLECTION}", key: $d.id, value: $d.error.request}}`,
          target: WORKER_MESSAGE_KINDS.store_request,
          detailSchema: MCP_RESULT_DETAIL,
        },
      ],
    },
  ],
}

/** auth-surfacer — the typed result surfaces to the host; the capture stays pending. */
const authSurfacer: Thread = {
  label: 'mcp/auth-surfacer',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.mcp_request_result,
          query:
            '. as $d | select($d.ok == false and $d.error.code? == "authorization_required") | {id: $d.id, reason: "mcp call requires authorization"}',
          target: MCP_EVENT_TYPES.authorizationRequired,
          detailSchema: MCP_RESULT_DETAIL,
        },
      ],
    },
  ],
}

/** auth-retry — granted ingress triggers the store get; the replayer takes it from there. */
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

/** replayer — a store get carrying a captured request replays the mcp_request and deletes the capture. */
const replayer: Thread = {
  label: 'mcp/replayer',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.store_request_result,
          query:
            '. as $d | select($d.result.value.op != null) | {id: ($d.id + "-retry"), op: $d.result.value.op, input: $d.result.value.input}',
          target: WORKER_MESSAGE_KINDS.mcp_request,
          detailSchema: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1 }, result: { type: 'object' } },
            required: ['id', 'result'],
          },
        },
        {
          type: WORKER_MESSAGE_KINDS.store_request_result,
          query:
            '. as $d | select($d.result.value.op != null) | {id: $d.id, op: "delete", input: {collection: "mcp-calls", key: $d.id}}',
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
export const mcpThreads: Thread[] = [authCapture, authSurfacer, authRetry, replayer]

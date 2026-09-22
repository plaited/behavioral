/**
 * The mcp-client thread library — the CROSS-TURN REPLAY SPINE over the mcp
 * worker's wire. Composes ON TOP of the mcp-client worker family; the worker
 * works standalone (the reusability test).
 *
 * The worker (src/workers/mcp-client.worker.ts) owns connections, sessions,
 * in-flight calls, and STRUCTURED auth-state: an unauthorized call returns a
 * typed `authorization_required` result that echoes the originating
 * request. Cold-per-turn means that state dies with the turn — so the only
 * thing these threads do is what crosses turns:
 *
 * - `auth-capture` — an `authorization_required` result is filed in the
 *   store (`mcp-calls`) keyed by call id, value = the echoed request. ONLY
 *   auth failures are captured — successful calls never touch the store
 *   (the per-call capture/clean churn of the pre-worker design is dead).
 * - `auth-surfacer` — the same result re-enters as
 *   `mcp_authorization_required` (host-routable: the shell's "authorize X"
 *   prompt per the broker ruling).
 * - `auth-retry` — `mcp_authorization_granted` (host ingress after the shell
 *   completes the flow) triggers the store get.
 * - `replayer` — a store get whose value carries a captured request replays
 *   the original `mcp_request` and deletes the capture.
 *
 * Vocabulary (thread-owned): `mcp_authorization_required { id, reason }`,
 * `mcp_authorization_granted { id }`.
 *
 * MINIMAL: the replayer fires on any store get whose value carries `op` —
 * the captured-request shape is `{ op, input }`, distinct from every other
 * planned tenant (the skill catalog is `{ skills, warnings }`). Tighten with
 * a collection tag when a colliding tenant shape appears.
 */
import type { Thread } from '../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../workers/workers.constants.ts'

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
  properties: { id: { type: 'string', minLength: 1 }, result: { type: 'object' } },
  required: ['id', 'result'],
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
          query: `. as $d | select($d.result.status == "authorization_required") | {id: $d.id, op: "put", input: {collection: "${MCP_CALLS_COLLECTION}", key: $d.id, value: $d.result.request}}`,
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
            '. as $d | select($d.result.status == "authorization_required") | {id: $d.id, reason: "mcp call requires authorization"}',
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

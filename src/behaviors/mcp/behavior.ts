/**
 * MCP client worker — executes one remote MCP operation per `mcp_request`
 * event against its own per-call connection and returns a single terminal
 * `mcp_request_result` event.
 *
 * @remarks
 * Spawned by URL (never imported) and speaks the behavioral event wire:
 * `mcp_request` / `mcp_cancel` in, `mcp_request_result` out, with any request
 * `space` echoed on the result. `detail.input` is validated against the op
 * input boundary (`mcp/types.ts`); per-call input credentials are
 * RETIRED per the worker-conversion rulings — auth binds at this module's
 * scope from env-data, never from the wire.
 *
 * Auth binding (the injection law one level down — functions cannot ride
 * postMessage):
 * - broker env-data (`MCP_BROKER_URL` + `MCP_BROKER_BOOT_SECRET`, seeded by
 *   the spawning composition root) → the provider fetches the broker's
 *   `request_access_token` endpoint. MINIMAL: the broker slice has not
 *   landed; its request contract is thin (POST + boot-secret bearer) and
 *   fail-closed on any failure. Pin it when the broker exists.
 * - No broker → the keychain floor: tokens written by prior
 *   BunKeychainOAuthProvider flows are read per server URL (the
 *   reconnect-per-turn posture — credentials persist in the keyring, the
 *   connection does not).
 * - Neither yields a token → the call goes unauthenticated, the server's 401
 *   surfaces as typed `authorization_required`, and the result echoes the
 *   originating request — the replay spine's capture payload.
 *
 * One connection per call (cold-per-turn: sessions die with the worker);
 * the envelope deadline (`input.timeoutMs`, default 30s) and `mcp_cancel`
 * are the two stop doors — remote MCP calls are the one behavior where
 * "hangs indefinitely" is a real third-party failure mode.
 *
 * MINIMAL: a stop closes the in-flight client but cannot abort the SDK's
 * pending fetch (no signal seam on StreamableHTTPClientTransport) — the
 * abandoned op settles into a settled race and its late rejection is
 * absorbed. Upgrade path: a transport signal when the SDK grows one.
 *
 * @packageDocumentation
 */

import {
  type AuthProvider,
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import type { ValidateFunction } from 'ajv'
import { ajv, type JsonObject } from '../../behavioral/behavioral.types.ts'
import { BEHAVIOR_MESSAGE_KINDS } from '../behaviors.constants.ts'
import {
  type McpCancelEvent,
  type McpOp,
  type McpRequestEvent,
  validateMcpCancelEvent,
  validateMcpRequestEvent,
} from '../behaviors.types.ts'
import { emit, envData, wireInbound } from '../process-lane.ts'
import { BunKeychain, tokensKey } from './keychain-oauth-provider.ts'
import { MCP_BROKER_BOOT_SECRET_KEY, MCP_BROKER_URL_KEY, MCP_OP_INPUT_VALIDATORS } from './types.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000

const CLIENT_INFO = { name: 'behavioral', version: '0.0.0' }

// ---------------------------------------------------------------------------
// Auth binding — module scope, from boundary-legal data only
// ---------------------------------------------------------------------------

const brokerUrl = envData(MCP_BROKER_URL_KEY) as string | undefined
const brokerBootSecret = envData(MCP_BROKER_BOOT_SECRET_KEY) as string | undefined
const keychain = BunKeychain()

/** Fetch an access token from the taskbar broker (env-data binding). Fail-closed. */
const brokerToken = async (): Promise<string | undefined> => {
  if (typeof brokerUrl !== 'string' || typeof brokerBootSecret !== 'string') return undefined
  try {
    const response = await fetch(new URL('request_access_token', brokerUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${brokerBootSecret}` },
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as { token?: string }
    return typeof data.token === 'string' && data.token !== '' ? data.token : undefined
  } catch {
    // A down broker must not break the floor — fall through to the keychain.
    return undefined
  }
}

/** The keychain floor: read tokens persisted by prior BunKeychainOAuthProvider flows. */
const keychainToken = async (serverUrl: string): Promise<string | undefined> => {
  try {
    const raw = await keychain.get(tokensKey(serverUrl))
    if (raw === null) return undefined
    const tokens = JSON.parse(raw) as { access_token?: string }
    return typeof tokens.access_token === 'string' && tokens.access_token !== '' ? tokens.access_token : undefined
  } catch {
    // Corrupt blobs are absent tokens — fail-closed, never a throw.
    return undefined
  }
}

/** The per-server token: broker first, keychain floor second, absent last. */
const getToken = async (serverUrl: string): Promise<string | undefined> =>
  (await brokerToken()) ?? keychainToken(serverUrl)

// ---------------------------------------------------------------------------
// In-flight execution — enough state to stop it by correlation id
// ---------------------------------------------------------------------------

type StopReason = 'canceled' | 'timeout'

type Execution = {
  /** First stop wins, so a late cancel cannot relabel a timeout. */
  stopReason: StopReason | null
  /** Set once the operation opens its client, so a stop can close it. */
  client: Client | undefined
  /** Resolves the stop race when the first stop fires (unused when the op wins). */
  onStop: ((reason: StopReason) => void) | undefined
}

/** Executions in flight, keyed by correlation id. */
const active = new Map<string, Execution>()

/** Record why an execution stopped, signal the race, and close the client. First writer wins. */
const stopExecution = ({ execution, reason }: { execution: Execution; reason: StopReason }): void => {
  if (execution.stopReason !== null) return
  execution.stopReason = reason
  // Best-effort close: the pending op rejects into the settled race's catch.
  void execution.client?.close().catch(() => undefined)
  execution.onStop?.(reason)
}

// ---------------------------------------------------------------------------
// Per-call session — one connection per op, owned by this execution
// ---------------------------------------------------------------------------

/** A broker/keychain-bound provider for one server URL — wire credentials never. */
const providerFor = (serverUrl: string): AuthProvider => ({
  token: () => getToken(serverUrl),
})

/** Run one op over its own connection, closing the client afterward. */
const runOperation = async ({
  op,
  input,
  url,
  execution,
}: {
  op: McpOp
  input: JsonObject
  url: string
  execution: Execution
}): Promise<JsonObject> => {
  const client = new Client(CLIENT_INFO)
  execution.client = client
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: providerFor(url),
  })
  await client.connect(transport)
  try {
    return await runOp({ op, input, client })
  } finally {
    execution.client = undefined
    try {
      await client.close()
    } catch {
      // Best-effort — a close failure must not mask the operation result.
    }
  }
}

const runOp = async ({ op, input, client }: { op: McpOp; input: JsonObject; client: Client }): Promise<JsonObject> => {
  switch (op) {
    case 'call-tool': {
      const tool = input as unknown as { tool: string; args: Record<string, unknown> }
      return (await client.callTool({ name: tool.tool, arguments: tool.args })) as unknown as JsonObject
    }
    case 'list-tools':
      return { tools: (await client.listTools()).tools } as unknown as JsonObject
    case 'list-prompts':
      return { prompts: (await client.listPrompts()).prompts } as unknown as JsonObject
    case 'get-prompt': {
      const prompt = input as unknown as { name: string; args?: Record<string, string> }
      return {
        messages: (await client.getPrompt({ name: prompt.name, arguments: prompt.args })).messages,
      } as unknown as JsonObject
    }
    case 'list-resources':
      return { resources: (await client.listResources()).resources } as unknown as JsonObject
    case 'read-resource': {
      const resource = input as unknown as { uri: string }
      return { contents: (await client.readResource({ uri: resource.uri })).contents } as unknown as JsonObject
    }
    case 'discover': {
      const [tools, prompts, resources] = await Promise.allSettled([
        client.listTools(),
        client.listPrompts(),
        client.listResources(),
      ])
      return {
        tools: tools.status === 'fulfilled' ? tools.value.tools : [],
        prompts: prompts.status === 'fulfilled' ? prompts.value.prompts : [],
        resources: resources.status === 'fulfilled' ? resources.value.resources : [],
      } as unknown as JsonObject
    }
  }
}

// ---------------------------------------------------------------------------
// Request execution — race the op against the first stop; no throw escapes
// ---------------------------------------------------------------------------

type RunOutcome = { output: JsonObject } | { stop: StopReason } | { fail: unknown }

const runRequest = async ({
  op,
  input,
  url,
  timeoutMs,
  execution,
}: {
  op: McpOp
  input: JsonObject
  url: string
  timeoutMs?: number
  execution: Execution
}): Promise<RunOutcome> => {
  // The stop promise is resolver-shaped: no polling, no interval to leak.
  const stopped = new Promise<RunOutcome>((resolve) => {
    execution.onStop = (reason) => resolve({ stop: reason })
  })
  const deadline = setTimeout(() => stopExecution({ execution, reason: 'timeout' }), timeoutMs ?? DEFAULT_TIMEOUT_MS)

  // The op settles as data (never rejects), so the race has no unhandled loser.
  const operation = runOperation({ op, input, url, execution })
    .then((output) => ({ output }) as RunOutcome)
    .catch((fail: unknown) => ({ fail }) as RunOutcome)

  try {
    return await Promise.race([operation, stopped])
  } finally {
    clearTimeout(deadline)
  }
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

const postResult = ({
  id,
  payload,
  error,
  space,
}: {
  id: string
  payload?: JsonObject
  error?: { code: string; message?: string } & JsonObject
  space?: string
}): void => {
  emit({
    type: BEHAVIOR_MESSAGE_KINDS.mcp_request_result,
    detail: (error === undefined
      ? { id, ok: true, result: payload ?? {} }
      : { id, ok: false, error: error as JsonObject }) as JsonObject & { id: string },
    ...(space === undefined ? {} : { space }),
  })
}

/** The success interior — status rides along as plain diagnostics. */
const successInterior = ({ started }: { started: number }): JsonObject => ({
  status: 'completed',
  durationMs: Math.round(performance.now() - started),
})

/** The error interior — the terminal status rides as `code`. */
const errorInterior = ({ code, started }: { code: string; started: number }): { code: string; durationMs: number } => ({
  code,
  durationMs: Math.round(performance.now() - started),
})

const failMessage = (fail: unknown): string => (fail instanceof Error ? fail.message : String(fail))

// ---------------------------------------------------------------------------
// Worker message loop
// ---------------------------------------------------------------------------

const handleInbound = async (message: unknown): Promise<void> => {
  if (validateMcpCancelEvent(message)) {
    // Cast: the TS7/ajv compiler defect means the type guard does not narrow.
    const cancel = message as McpCancelEvent
    const execution = active.get(cancel.detail.id)
    if (execution !== undefined) stopExecution({ execution, reason: 'canceled' })
    return
  }
  // Events failing the shared schema have no correlation id to report to and
  // are dropped — the router only forwards schema-valid events, so this is
  // defense in depth at the process boundary.
  if (!validateMcpRequestEvent(message)) return
  const event = message as McpRequestEvent
  const { id, op, input } = event.detail
  const started = performance.now()

  // Input that fails the boundary is error data, not a throw: the id is
  // valid, so the caller learns why nothing ran.
  const validateOpInput = MCP_OP_INPUT_VALIDATORS[op] as unknown as ValidateFunction<unknown>
  if (!validateOpInput(input)) {
    postResult({
      id,
      space: event.space,
      error: {
        ...errorInterior({ code: 'error', started }),
        message: `invalid input: ${ajv.errorsText(validateOpInput.errors)}`,
      },
    })
    return
  }

  const execution: Execution = { stopReason: null, client: undefined, onStop: undefined }
  active.set(id, execution)
  try {
    const { url, timeoutMs } = input as { url: string; timeoutMs?: number }
    const outcome = await runRequest({ op, input, url, timeoutMs, execution })

    if ('output' in outcome) {
      postResult({
        id,
        space: event.space,
        payload: { ...successInterior({ started }), output: outcome.output },
      })
      return
    }
    if ('stop' in outcome) {
      postResult({
        id,
        space: event.space,
        error: { ...errorInterior({ code: outcome.stop, started }) },
      })
      return
    }
    if (UnauthorizedError.isInstance(outcome.fail)) {
      postResult({
        id,
        space: event.space,
        error: {
          ...errorInterior({ code: 'authorization_required', started }),
          message: failMessage(outcome.fail),
          // The replay spine's capture payload — the store never saw the
          // request; this echo is the only carrier.
          request: { op, input },
        },
      })
      return
    }
    postResult({
      id,
      space: event.space,
      error: { ...errorInterior({ code: 'error', started }), message: failMessage(outcome.fail) },
    })
  } finally {
    active.delete(id)
  }
}

// The wire is the behavioral event vocabulary, validated with the shared
// schemas — the trust boundary for anything crossing into this process.
if (import.meta.main) {
  // Standalone (spawned process) — wire the stdio line lane. An in-process
  // import (the composition's frontier embed) wires nothing: the host's
  // stdin is never touched.
  wireInbound((message) => handleInbound(message))
}

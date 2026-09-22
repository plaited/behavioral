/**
 * The mcp-client thread library against the real engine — the cross-turn
 * replay spine over the mcp worker's wire: typed `authorization_required`
 * results are captured in the store (the only cross-turn memory — cold
 * per-turn kills in-flight state), surfaced to the host as
 * `mcp_authorization_required`, and replayed after grant ingress.
 *
 * The worker owns auth state and request echoes; these threads keep ONLY what
 * crosses turns. Successful calls are never captured (result-cleaner is dead
 * by design — no per-call store churn).
 */
import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../../workers/workers.constants.ts'
import { MCP_CALLS_COLLECTION, MCP_EVENT_TYPES, mcpThreads } from '../mcp-client.ts'

type Selected = { type: string; detail: Record<string, unknown> | undefined }

const runProgram = (events: BPEvent[]): Selected[] => {
  const program = behavioral()
  const selected: Selected[] = []
  program.useTrace((trace: Trace) => {
    if (trace.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  })
  for (const thread of mcpThreads) program.addThread(thread)
  for (const event of events)
    program.addThread({ label: `producer/${event.type}`, once: true, rules: [{ request: event }] })
  // addThread is inert — trigger admits one ingress event and runs one
  // super-step; the second pump cascades transform re-entries.
  program.trigger({ type: 'mcp_gate_pump', detail: {} })
  program.trigger({ type: 'mcp_gate_pump', detail: {} })
  return selected
}

const authRequiredResult = (id: string): BPEvent => ({
  type: WORKER_MESSAGE_KINDS.mcp_request_result,
  detail: {
    id,
    result: {
      id,
      status: 'authorization_required',
      durationMs: 12,
      message: 'unauthorized',
      request: { op: 'list-tools', input: { url: 'https://mcp.example.com/mcp' } },
    },
  },
})

const completedResult = (id: string): BPEvent => ({
  type: WORKER_MESSAGE_KINDS.mcp_request_result,
  detail: {
    id,
    result: { id, status: 'completed', durationMs: 40, output: { tools: [] } },
  },
})

describe('mcp threads — the replay spine', () => {
  test('an authorization_required result is captured in the store with the echoed request', () => {
    const selected = runProgram([authRequiredResult('c1')])
    const put = selected.find((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
    expect(put).toBeDefined()
    const input = put?.detail?.input as JsonObject
    expect(input.collection).toBe(MCP_CALLS_COLLECTION)
    expect(input.key).toBe('c1')
    expect(input.value).toEqual({ op: 'list-tools', input: { url: 'https://mcp.example.com/mcp' } })
  })

  test('a completed result is never captured — no per-call store churn', () => {
    const selected = runProgram([completedResult('c2')])
    expect(selected.some((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op !== 'get')).toBe(false)
  })

  test('an authorization_required result surfaces mcp_authorization_required to the host', () => {
    const selected = runProgram([authRequiredResult('c3')])
    const surfaced = selected.find((s) => s.type === MCP_EVENT_TYPES.authorizationRequired)
    expect(surfaced?.detail?.id).toBe('c3')
    expect(String(surfaced?.detail?.reason).length > 0).toBe(true)
  })

  test('grant ingress replays the captured request and deletes the capture', () => {
    const selected = runProgram([
      authRequiredResult('c4'),
      { type: MCP_EVENT_TYPES.authorizationGranted, detail: { id: 'c4' } },
      // the store worker's get result, as the router would re-enter it
      {
        type: WORKER_MESSAGE_KINDS.store_request_result,
        detail: {
          id: 'c4',
          result: { value: { op: 'list-tools', input: { url: 'https://mcp.example.com/mcp' } } },
        },
      },
    ])
    const get = selected.find((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'get')
    expect((get?.detail?.input as JsonObject)?.key).toBe('c4')
    const retry = selected.find((s) => s.type === WORKER_MESSAGE_KINDS.mcp_request && s.detail?.id === 'c4-retry')
    expect(retry?.detail?.op).toBe('list-tools')
    expect((retry?.detail?.input as JsonObject)?.url).toBe('https://mcp.example.com/mcp')
    const del = selected.find(
      (s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'delete' && s.detail?.id === 'c4',
    )
    expect(del).toBeDefined()
  })

  test('a store value that is not a captured request does not replay', () => {
    const selected = runProgram([
      {
        type: WORKER_MESSAGE_KINDS.store_request_result,
        detail: {
          id: 'c5',
          result: { value: { skills: [{ name: 'alpha' }], warnings: [] } },
        },
      },
    ])
    expect(selected.some((s) => s.type === WORKER_MESSAGE_KINDS.mcp_request)).toBe(false)
  })
})

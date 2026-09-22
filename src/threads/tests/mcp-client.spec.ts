/**
 * The mcp-client thread library against the real engine — the auth-failure
 * orchestration over the worker wire: capture → clean/surface → retry.
 */
import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../../workers/workers.constants.ts'
import { MCP_EVENT_TYPES, mcpThreads } from '../mcp-client.ts'

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

const mcpCall = (id: string): BPEvent => ({
  type: WORKER_MESSAGE_KINDS.tool_call,
  detail: { id, tool: 'mcp-discover', input: { url: 'https://mcp.example.com' } },
})

const result = (id: string, result: JsonObject): BPEvent => ({
  type: WORKER_MESSAGE_KINDS.tool_call_result,
  detail: { id, result },
})

describe('mcp threads — call capture', () => {
  test('an mcp tool_call is filed in the store keyed by call id', () => {
    const selected = runProgram([mcpCall('c1')])
    const put = selected.find((s) => s.type === WORKER_MESSAGE_KINDS.store_request)
    expect(put).toBeDefined()
    expect(put?.detail?.op).toBe('put')
    expect((put?.detail?.input as JsonObject)?.collection).toBe('mcp-calls')
    expect(((put?.detail?.input as JsonObject)?.value as JsonObject)?.mcpCall).toMatchObject({
      tool: 'mcp-discover',
    })
  })

  test('a non-mcp tool_call is not captured', () => {
    const selected = runProgram([
      { type: WORKER_MESSAGE_KINDS.tool_call, detail: { id: 's1', tool: 'skill-discover', input: {} } },
    ])
    expect(selected.some((s) => s.type === WORKER_MESSAGE_KINDS.store_request)).toBe(false)
  })
})

describe('mcp threads — result handling', () => {
  test('a successful result deletes the capture', () => {
    const selected = runProgram([mcpCall('c2'), result('c2', { status: 'success', exitCode: 0, stderr: '' })])
    const del = selected.find((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'delete')
    expect(del).toBeDefined()
    expect((del?.detail?.input as JsonObject)?.key).toBe('c2')
    expect(selected.some((s) => s.type === MCP_EVENT_TYPES.authorizationRequired)).toBe(false)
  })

  test('an auth-marker result surfaces mcp_authorization_required and keeps the capture', () => {
    const selected = runProgram([
      mcpCall('c3'),
      result('c3', { status: 'error', exitCode: 1, stderr: 'UnauthorizedError: token required' }),
    ])
    const surfaced = selected.find((s) => s.type === MCP_EVENT_TYPES.authorizationRequired)
    expect(surfaced?.detail?.id).toBe('c3')
    // the capture is NOT cleaned — the call is pending consent
    expect(selected.some((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'delete')).toBe(false)
  })
})

describe('mcp threads — grant and replay', () => {
  test('granted triggers the store get; the replayer replays the captured call and deletes the capture', () => {
    const selected = runProgram([
      mcpCall('c4'),
      result('c4', { status: 'error', exitCode: 1, stderr: 'UnauthorizedError: token required' }),
      { type: MCP_EVENT_TYPES.authorizationGranted, detail: { id: 'c4' } },
      // the store worker's get result, as the router would re-enter it
      {
        type: WORKER_MESSAGE_KINDS.store_request_result,
        detail: {
          id: 'c4',
          result: { value: { mcpCall: { tool: 'mcp-discover', input: { url: 'https://mcp.example.com' } } } },
        },
      },
    ])
    const get = selected.find((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'get')
    expect((get?.detail?.input as JsonObject)?.key).toBe('c4')
    const retry = selected.find((s) => s.type === WORKER_MESSAGE_KINDS.tool_call && s.detail?.id === 'c4-retry')
    expect(retry?.detail?.tool).toBe('mcp-discover')
    expect((retry?.detail?.input as JsonObject)?.url).toBe('https://mcp.example.com')
    const del = selected.find(
      (s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'delete' && s.detail?.id === 'c4',
    )
    expect(del).toBeDefined()
  })
})

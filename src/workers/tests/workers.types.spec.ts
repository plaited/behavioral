import { describe, expect, test } from 'bun:test'
import { WORKER_MESSAGE_KINDS } from '../workers.constants.ts'
import {
  validateFrontierRequestEvent,
  validateFrontierRequestResultEvent,
  validateMcpCancelEvent,
  validateMcpRequestEvent,
  validateMcpRequestResultEvent,
  validateResponseCancelEvent,
  validateResponseRequestEvent,
  validateResponseRequestResultEvent,
  validateStoreRequestEvent,
  validateStoreRequestResultEvent,
  validateToolCallEvent,
  validateToolCallResultEvent,
  validateToolCancelEvent,
  validateWorkerErrorEvent,
} from '../workers.types.ts'

describe('workers.types event vocabulary', () => {
  describe('response_request', () => {
    test('accepts a well-formed request', () => {
      const valid = validateResponseRequestEvent({
        type: WORKER_MESSAGE_KINDS.response_request,
        detail: {
          id: 'call_1',
          input: { provider: 'ollama', modelId: 'llama3.1', input: [] },
        },
      })
      expect(valid).toBe(true)
    })
    test('accepts optional space', () => {
      const valid = validateResponseRequestEvent({
        type: WORKER_MESSAGE_KINDS.response_request,
        detail: { id: 'call_1', input: {} },
        space: 'main',
      })
      expect(valid).toBe(true)
    })
    test('rejects a detail without id', () => {
      const valid = validateResponseRequestEvent({
        type: WORKER_MESSAGE_KINDS.response_request,
        detail: { input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without input', () => {
      const valid = validateResponseRequestEvent({
        type: WORKER_MESSAGE_KINDS.response_request,
        detail: { id: 'call_1' },
      })
      expect(valid).toBe(false)
    })
    test('rejects a missing detail', () => {
      const valid = validateResponseRequestEvent({ type: WORKER_MESSAGE_KINDS.response_request })
      expect(valid).toBe(false)
    })
    test('rejects a different event type', () => {
      const valid = validateResponseRequestEvent({
        type: WORKER_MESSAGE_KINDS.tool_call,
        detail: { id: 'call_1', tool: 'git_status', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects ingress — routed events are synthesized, never ingress', () => {
      const valid = validateResponseRequestEvent({
        type: WORKER_MESSAGE_KINDS.response_request,
        detail: { id: 'call_1', input: {} },
        ingress: 'boot',
      })
      expect(valid).toBe(false)
    })
  })

  describe('response_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateResponseRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.response_request_result,
        detail: { id: 'call_1', result: { items: [], status: 'completed' } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateResponseRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.response_request_result,
        detail: { id: 'call_1', result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
    test('rejects a missing id', () => {
      const valid = validateResponseRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.response_request_result,
        detail: { result: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('tool_call', () => {
    test('accepts a well-formed call', () => {
      const valid = validateToolCallEvent({
        type: WORKER_MESSAGE_KINDS.tool_call,
        detail: { id: 'tool_1', tool: 'git_status', input: {} },
      })
      expect(valid).toBe(true)
    })
    test('rejects a detail without tool', () => {
      const valid = validateToolCallEvent({
        type: WORKER_MESSAGE_KINDS.tool_call,
        detail: { id: 'tool_1', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without input', () => {
      const valid = validateToolCallEvent({
        type: WORKER_MESSAGE_KINDS.tool_call,
        detail: { id: 'tool_1', tool: 'git_status' },
      })
      expect(valid).toBe(false)
    })
    test('rejects extra detail keys — tool params live inside input', () => {
      const valid = validateToolCallEvent({
        type: WORKER_MESSAGE_KINDS.tool_call,
        detail: { id: 'tool_1', tool: 'git_status', input: {}, sneaky: true },
      })
      expect(valid).toBe(false)
    })
  })

  describe('tool_call_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateToolCallResultEvent({
        type: WORKER_MESSAGE_KINDS.tool_call_result,
        detail: { id: 'tool_1', result: { ok: true, value: {} } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a missing result payload', () => {
      const valid = validateToolCallResultEvent({
        type: WORKER_MESSAGE_KINDS.tool_call_result,
        detail: { id: 'tool_1' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('cancels', () => {
    test('accepts a well-formed response_cancel', () => {
      const valid = validateResponseCancelEvent({
        type: WORKER_MESSAGE_KINDS.response_cancel,
        detail: { id: 'call_1' },
      })
      expect(valid).toBe(true)
    })
    test('accepts a well-formed tool_cancel', () => {
      const valid = validateToolCancelEvent({
        type: WORKER_MESSAGE_KINDS.tool_cancel,
        detail: { id: 'tool_1' },
      })
      expect(valid).toBe(true)
    })
    test('rejects a cancel without id', () => {
      const valid = validateResponseCancelEvent({
        type: WORKER_MESSAGE_KINDS.response_cancel,
        detail: {},
      })
      expect(valid).toBe(false)
    })
    test('rejects an empty correlation id — nothing to correlate', () => {
      const valid = validateResponseCancelEvent({
        type: WORKER_MESSAGE_KINDS.response_cancel,
        detail: { id: '' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('frontier_request', () => {
    test('accepts a well-formed request with a known operation', () => {
      const valid = validateFrontierRequestEvent({
        type: WORKER_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', op: 'explore', input: { threads: [], maxDepth: 1 } },
      })
      expect(valid).toBe(true)
    })
    test('rejects an unknown operation — frontier is its own worker, not a tool', () => {
      const valid = validateFrontierRequestEvent({
        type: WORKER_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', op: 'frontier-explore', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without op', () => {
      const valid = validateFrontierRequestEvent({
        type: WORKER_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', input: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('frontier_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateFrontierRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.frontier_request_result,
        detail: { id: 'fr_1', result: { status: 'verified' } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateFrontierRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.frontier_request_result,
        detail: { id: 'fr_1', result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('store_request', () => {
    test('accepts a well-formed put request', () => {
      const valid = validateStoreRequestEvent({
        type: WORKER_MESSAGE_KINDS.store_request,
        detail: { id: 's1', op: 'put', input: { collection: 'runs', key: 'r1', value: {} } },
      })
      expect(valid).toBe(true)
    })
    test('rejects an op outside the enum — put|get|delete|query is the whole surface', () => {
      const valid = validateStoreRequestEvent({
        type: WORKER_MESSAGE_KINDS.store_request,
        detail: { id: 's1', op: 'purge', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without op', () => {
      const valid = validateStoreRequestEvent({
        type: WORKER_MESSAGE_KINDS.store_request,
        detail: { id: 's1', input: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('store_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateStoreRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.store_request_result,
        detail: { id: 's1', result: { ok: true } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateStoreRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.store_request_result,
        detail: { id: 's1', result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('mcp_request', () => {
    test('accepts a well-formed call-tool request', () => {
      const valid = validateMcpRequestEvent({
        type: WORKER_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'call-tool', input: { url: 'http://127.0.0.1:1/mcp', tool: 'echo', args: {} } },
      })
      expect(valid).toBe(true)
    })
    test('accepts optional space', () => {
      const valid = validateMcpRequestEvent({
        type: WORKER_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'list-tools', input: { url: 'http://127.0.0.1:1/mcp' } },
        space: 'demo',
      })
      expect(valid).toBe(true)
    })
    test('rejects an op outside the enum — the 7 ops are the whole surface', () => {
      const valid = validateMcpRequestEvent({
        type: WORKER_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'purge', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without op', () => {
      const valid = validateMcpRequestEvent({
        type: WORKER_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without input', () => {
      const valid = validateMcpRequestEvent({
        type: WORKER_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'list-tools' },
      })
      expect(valid).toBe(false)
    })
    test('rejects ingress — routed events are synthesized, never ingress', () => {
      const valid = validateMcpRequestEvent({
        type: WORKER_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'list-tools', input: { url: 'http://127.0.0.1:1/mcp' } },
        ingress: 'ui_event',
      })
      expect(valid).toBe(false)
    })
  })

  describe('mcp_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateMcpRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.mcp_request_result,
        detail: { id: 'm1', result: { status: 'completed', durationMs: 12 } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateMcpRequestResultEvent({
        type: WORKER_MESSAGE_KINDS.mcp_request_result,
        detail: { id: 'm1', result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('mcp_cancel', () => {
    test('accepts a well-formed cancel', () => {
      const valid = validateMcpCancelEvent({
        type: WORKER_MESSAGE_KINDS.mcp_cancel,
        detail: { id: 'm1' },
      })
      expect(valid).toBe(true)
    })
    test('rejects a cancel without id', () => {
      const valid = validateMcpCancelEvent({
        type: WORKER_MESSAGE_KINDS.mcp_cancel,
        detail: {},
      })
      expect(valid).toBe(false)
    })
  })

  describe('worker_error', () => {
    test('accepts a well-formed crash report', () => {
      const valid = validateWorkerErrorEvent({
        type: WORKER_MESSAGE_KINDS.worker_error,
        detail: { worker: 'tools-client', message: 'module never loaded' },
      })
      expect(valid).toBe(true)
    })
    test('rejects a report without message', () => {
      const valid = validateWorkerErrorEvent({
        type: WORKER_MESSAGE_KINDS.worker_error,
        detail: { worker: 'tools-client' },
      })
      expect(valid).toBe(false)
    })
  })
})

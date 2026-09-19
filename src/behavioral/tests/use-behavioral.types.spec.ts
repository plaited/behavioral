import { describe, expect, test } from 'bun:test'
import { WORKER_MESSAGE_KINDS } from '../behavioral.constants.ts'
import {
  validateFrontierRequestEvent,
  validateFrontierRequestResultEvent,
  validateResponseCancelEvent,
  validateResponseRequestEvent,
  validateResponseRequestResultEvent,
  validateToolCallEvent,
  validateToolCallResultEvent,
  validateToolCancelEvent,
  validateWorkerErrorEvent,
} from '../use-behavioral.types.ts'

describe('use-behavioral event vocabulary', () => {
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

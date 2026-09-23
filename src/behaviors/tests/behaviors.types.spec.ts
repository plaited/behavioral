import { describe, expect, test } from 'bun:test'
import { BEHAVIOR_MESSAGE_KINDS } from '../behaviors.constants.ts'
import {
  validateBehaviorErrorEvent,
  validateFrontierRequestEvent,
  validateFrontierRequestResultEvent,
  validateMcpCancelEvent,
  validateMcpRequestEvent,
  validateMcpRequestResultEvent,
  validateResponseCancelEvent,
  validateResponseRequestEvent,
  validateResponseRequestResultEvent,
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateShellRequestResultEvent,
  validateStoreRequestEvent,
  validateStoreRequestResultEvent,
} from '../behaviors.types.ts'

describe('workers.types event vocabulary', () => {
  describe('response_request', () => {
    test('accepts a well-formed request', () => {
      const valid = validateResponseRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_request,
        detail: {
          id: 'call_1',
          input: { provider: 'ollama', modelId: 'llama3.1', input: [] },
        },
      })
      expect(valid).toBe(true)
    })
    test('accepts optional space', () => {
      const valid = validateResponseRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_request,
        detail: { id: 'call_1', input: {} },
        space: 'main',
      })
      expect(valid).toBe(true)
    })
    test('rejects a detail without id', () => {
      const valid = validateResponseRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_request,
        detail: { input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without input', () => {
      const valid = validateResponseRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_request,
        detail: { id: 'call_1' },
      })
      expect(valid).toBe(false)
    })
    test('rejects a missing detail', () => {
      const valid = validateResponseRequestEvent({ type: BEHAVIOR_MESSAGE_KINDS.response_request })
      expect(valid).toBe(false)
    })
    test('rejects a different event type', () => {
      const valid = validateResponseRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.shell_request,
        detail: { id: 'call_1', input: { op: 'run', script: 'x' } },
      })
      expect(valid).toBe(false)
    })
    test('rejects ingress — routed events are synthesized, never ingress', () => {
      const valid = validateResponseRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_request,
        detail: { id: 'call_1', input: {} },
        ingress: 'boot',
      })
      expect(valid).toBe(false)
    })
  })

  describe('response_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateResponseRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_request_result,
        detail: { id: 'call_1', ok: true, result: { items: [], status: 'completed' } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateResponseRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_request_result,
        detail: { id: 'call_1', ok: true, result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
    test('rejects a missing id', () => {
      const valid = validateResponseRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_request_result,
        detail: { result: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('shell_request', () => {
    test('accepts a well-formed request', () => {
      const valid = validateShellRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.shell_request,
        detail: { id: 'sh_1', input: { op: 'run', script: 'console.log(1)' } },
      })
      expect(valid).toBe(true)
    })
    test('accepts an optional label annotation', () => {
      const valid = validateShellRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.shell_request,
        detail: { id: 'sh_1', label: 'skill-scan', input: { op: 'shell', command: 'echo hi' } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a detail without input', () => {
      const valid = validateShellRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.shell_request,
        detail: { id: 'sh_1', label: 'skill-scan' },
      })
      expect(valid).toBe(false)
    })
    test('rejects extra detail keys — params live inside input', () => {
      const valid = validateShellRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.shell_request,
        detail: { id: 'sh_1', bogus: 'x', input: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('shell_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateShellRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.shell_request_result,
        detail: { id: 'sh_1', ok: true, result: { value: {} } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a missing result payload', () => {
      const valid = validateShellRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.shell_request_result,
        detail: { id: 'sh_1' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('cancels', () => {
    test('accepts a well-formed response_cancel', () => {
      const valid = validateResponseCancelEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_cancel,
        detail: { id: 'call_1' },
      })
      expect(valid).toBe(true)
    })
    test('accepts a well-formed shell_cancel', () => {
      const valid = validateShellCancelEvent({
        type: BEHAVIOR_MESSAGE_KINDS.shell_cancel,
        detail: { id: 'shell_1' },
      })
      expect(valid).toBe(true)
    })
    test('rejects a cancel without id', () => {
      const valid = validateResponseCancelEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_cancel,
        detail: {},
      })
      expect(valid).toBe(false)
    })
    test('rejects an empty correlation id — nothing to correlate', () => {
      const valid = validateResponseCancelEvent({
        type: BEHAVIOR_MESSAGE_KINDS.response_cancel,
        detail: { id: '' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('frontier_request', () => {
    test('accepts a well-formed request with a known operation', () => {
      const valid = validateFrontierRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', op: 'explore', input: { threads: [], maxDepth: 1 } },
      })
      expect(valid).toBe(true)
    })
    test('rejects an unknown operation — frontier is its own worker, not a tool', () => {
      const valid = validateFrontierRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', op: 'frontier-explore', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without op', () => {
      const valid = validateFrontierRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.frontier_request,
        detail: { id: 'fr_1', input: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('frontier_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateFrontierRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.frontier_request_result,
        detail: { id: 'fr_1', ok: true, result: { status: 'verified' } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateFrontierRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.frontier_request_result,
        detail: { id: 'fr_1', ok: true, result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('store_request', () => {
    test('accepts a well-formed put request', () => {
      const valid = validateStoreRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.store_request,
        detail: { id: 's1', op: 'put', input: { collection: 'runs', key: 'r1', value: {} } },
      })
      expect(valid).toBe(true)
    })
    test('rejects an op outside the enum — put|get|delete|query is the whole surface', () => {
      const valid = validateStoreRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.store_request,
        detail: { id: 's1', op: 'purge', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without op', () => {
      const valid = validateStoreRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.store_request,
        detail: { id: 's1', input: {} },
      })
      expect(valid).toBe(false)
    })
  })

  describe('store_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateStoreRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.store_request_result,
        detail: { id: 's1', ok: true, result: {} },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateStoreRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.store_request_result,
        detail: { id: 's1', ok: true, result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('mcp_request', () => {
    test('accepts a well-formed call-tool request', () => {
      const valid = validateMcpRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'call-tool', input: { url: 'http://127.0.0.1:1/mcp', tool: 'echo', args: {} } },
      })
      expect(valid).toBe(true)
    })
    test('accepts optional space', () => {
      const valid = validateMcpRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'list-tools', input: { url: 'http://127.0.0.1:1/mcp' } },
        space: 'demo',
      })
      expect(valid).toBe(true)
    })
    test('rejects an op outside the enum — the 7 ops are the whole surface', () => {
      const valid = validateMcpRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'purge', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without op', () => {
      const valid = validateMcpRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', input: {} },
      })
      expect(valid).toBe(false)
    })
    test('rejects a detail without input', () => {
      const valid = validateMcpRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'list-tools' },
      })
      expect(valid).toBe(false)
    })
    test('rejects ingress — routed events are synthesized, never ingress', () => {
      const valid = validateMcpRequestEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_request,
        detail: { id: 'm1', op: 'list-tools', input: { url: 'http://127.0.0.1:1/mcp' } },
        ingress: 'ui_event',
      })
      expect(valid).toBe(false)
    })
  })

  describe('mcp_request_result', () => {
    test('accepts a well-formed result', () => {
      const valid = validateMcpRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_request_result,
        detail: { id: 'm1', ok: true, result: { status: 'completed', durationMs: 12 } },
      })
      expect(valid).toBe(true)
    })
    test('rejects a non-object result payload', () => {
      const valid = validateMcpRequestResultEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_request_result,
        detail: { id: 'm1', result: 'not-an-object' },
      })
      expect(valid).toBe(false)
    })
  })

  describe('mcp_cancel', () => {
    test('accepts a well-formed cancel', () => {
      const valid = validateMcpCancelEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_cancel,
        detail: { id: 'm1' },
      })
      expect(valid).toBe(true)
    })
    test('rejects a cancel without id', () => {
      const valid = validateMcpCancelEvent({
        type: BEHAVIOR_MESSAGE_KINDS.mcp_cancel,
        detail: {},
      })
      expect(valid).toBe(false)
    })
  })

  describe('behavior_error', () => {
    test('accepts a well-formed crash report', () => {
      const valid = validateBehaviorErrorEvent({
        type: BEHAVIOR_MESSAGE_KINDS.behavior_error,
        detail: { behavior: 'shell', message: 'module never loaded' },
      })
      expect(valid).toBe(true)
    })
    test('rejects a report without message', () => {
      const valid = validateBehaviorErrorEvent({
        type: BEHAVIOR_MESSAGE_KINDS.behavior_error,
        detail: { behavior: 'shell' },
      })
      expect(valid).toBe(false)
    })
  })
})

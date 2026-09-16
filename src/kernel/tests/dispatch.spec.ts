import { describe, expect, test } from 'bun:test'
import type { FunctionCallOutputItem } from '../../workers/open-responses.schemas.ts'
import { createDispatchBridge, type DispatchableTool } from '../dispatch.ts'

// A plain callable tool taking `unknown` (validates/echoes internally). Built
// without the useTool factory so the dispatch contract — lookup, JSON-parse,
// call, correlate — is tested directly. `name` is set via `Object.defineProperty`
// (functions have a non-writable `name`; `Object.assign` would throw in strict
// mode — the same reason use-tool.ts uses `Object.defineProperty`).
const tool = (name: string, fn: (input: unknown) => Promise<unknown>): DispatchableTool =>
  Object.defineProperty(fn, 'name', { value: name, configurable: true }) as DispatchableTool

const echoTool = tool('echo', async (input) => ({ echoed: input }))
const throwingTool = tool('boom', async () => {
  throw new Error('boom')
})
const errorTool = tool('fails', async () => ({ isError: true, message: 'nope' }))
const stringTool = tool('str', async () => 'plain text')

const call = (
  overrides: Partial<{ name: string; arguments: string; call_id: string }> = {},
): {
  name: string
  arguments: string
  call_id: string
} => ({
  name: 'echo',
  arguments: '{}',
  call_id: 'call_1',
  ...overrides,
})

const asFco = (x: unknown): FunctionCallOutputItem => x as FunctionCallOutputItem

describe('createDispatchBridge — dispatch + correlation', () => {
  test('a successful call returns a completed output correlated by call_id', async () => {
    const bridge = createDispatchBridge({ tools: { echo: echoTool } })
    const fco = asFco(await bridge.dispatch(call({ arguments: '{"say":"hi"}', call_id: 'call_abc' })))
    expect(fco.type).toBe('function_call_output')
    expect(fco.status).toBe('completed')
    expect(fco.call_id).toBe('call_abc')
    expect(fco.id).not.toBe(fco.call_id)
    expect(fco.id).toMatch(/^fco_/)
    expect(JSON.parse(fco.output)).toEqual({ echoed: { say: 'hi' } })
  })

  test('a string result is passed through as the output verbatim', async () => {
    const bridge = createDispatchBridge({ tools: { str: stringTool } })
    const fco = asFco(await bridge.dispatch(call({ name: 'str' })))
    expect(fco.status).toBe('completed')
    expect(fco.output).toBe('plain text')
  })

  test('an unknown tool name returns a failed output as data (never throws)', async () => {
    const bridge = createDispatchBridge({ tools: { echo: echoTool } })
    const fco = asFco(await bridge.dispatch(call({ name: 'nope' })))
    expect(fco.status).toBe('failed')
    expect(fco.call_id).toBe('call_1')
    expect(JSON.parse(fco.output)).toEqual({ error: 'unknown_tool', name: 'nope' })
  })

  test('malformed arguments JSON returns a failed output as data', async () => {
    const bridge = createDispatchBridge({ tools: { echo: echoTool } })
    const fco = asFco(await bridge.dispatch(call({ arguments: '{not json' })))
    expect(fco.status).toBe('failed')
    const payload = JSON.parse(fco.output) as { error: string; name: string; arguments: string }
    expect(payload.error).toBe('invalid_arguments')
    expect(payload.name).toBe('echo')
    expect(payload.arguments).toBe('{not json')
  })

  test('a tool isError result becomes a failed output carrying the message', async () => {
    const bridge = createDispatchBridge({ tools: { fails: errorTool } })
    const fco = asFco(await bridge.dispatch(call({ name: 'fails' })))
    expect(fco.status).toBe('failed')
    const payload = JSON.parse(fco.output) as { error: string; message: string }
    expect(payload.error).toBe('tool_error')
    expect(payload.message).toBe('nope')
  })

  test('an unexpected tool throw becomes a failed output (never throws into the space)', async () => {
    const bridge = createDispatchBridge({ tools: { boom: throwingTool } })
    const fco = asFco(await bridge.dispatch(call({ name: 'boom' })))
    expect(fco.status).toBe('failed')
    const payload = JSON.parse(fco.output) as { error: string; message: string }
    expect(payload.error).toBe('tool_threw')
    expect(payload.message).toBe('boom')
  })

  test('every output item is spec-valid: id + type + status + call_id + output', async () => {
    const bridge = createDispatchBridge({ tools: { echo: echoTool } })
    const fco = asFco(await bridge.dispatch(call({ call_id: 'call_spec' })))
    expect(typeof fco.id).toBe('string')
    expect(fco.id.length).toBeGreaterThan(0)
    expect(fco.type).toBe('function_call_output')
    expect(['completed', 'failed', 'incomplete', 'in_progress']).toContain(fco.status)
    expect(fco.call_id).toBe('call_spec')
    expect(typeof fco.output).toBe('string')
  })

  test('has() reports registry membership', () => {
    const bridge = createDispatchBridge({ tools: { echo: echoTool } })
    expect(bridge.has('echo')).toBe(true)
    expect(bridge.has('missing')).toBe(false)
  })

  test('an iterable of tools is keyed by each tool .name', async () => {
    const bridge = createDispatchBridge({ tools: [echoTool] })
    expect(bridge.has('echo')).toBe(true)
    const fco = asFco(await bridge.dispatch(call({ arguments: '{"x":1}' })))
    expect(fco.status).toBe('completed')
    expect(JSON.parse(fco.output)).toEqual({ echoed: { x: 1 } })
  })

  test('two parallel same-tool calls correlate by their own call_id', async () => {
    const bridge = createDispatchBridge({ tools: { echo: echoTool } })
    const [a, b] = await Promise.all([
      bridge.dispatch(call({ call_id: 'call_A', arguments: '{"i":1}' })),
      bridge.dispatch(call({ call_id: 'call_B', arguments: '{"i":2}' })),
    ])
    expect(asFco(a).call_id).toBe('call_A')
    expect(asFco(b).call_id).toBe('call_B')
    expect(JSON.parse(asFco(a).output)).toEqual({ echoed: { i: 1 } })
    expect(JSON.parse(asFco(b).output)).toEqual({ echoed: { i: 2 } })
    expect(asFco(a).id).not.toBe(asFco(b).id)
  })
})

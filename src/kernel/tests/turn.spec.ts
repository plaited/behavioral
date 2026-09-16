import { describe, expect, test } from 'bun:test'
import type { FunctionCallOutputItem, OutputItem } from '../../workers/open-responses.schemas.ts'
import {
  createScriptedModelTools,
  MODEL_COMPACT_TOOL_NAME,
  MODEL_RESPOND_TOOL_NAME,
  type ModelCompactTool,
  type ModelRespondTool,
} from '../../workers/use-model.ts'
import type { DispatchableTool } from '../dispatch.ts'
import { createKernel } from '../kernel.ts'

// A plain callable tool keyed by `.name` (see dispatch.spec.ts for why
// Object.defineProperty, not Object.assign, sets the function name).
const tool = (name: string, fn: (input: unknown) => Promise<unknown>): DispatchableTool =>
  Object.defineProperty(fn, 'name', { value: name, configurable: true }) as DispatchableTool

const echoTool = tool('echo', async (input) => ({ echoed: input }))

const assistantMessage = (id: string, text: string): OutputItem =>
  ({
    id,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }) as OutputItem

const functionCall = (id: string, callId: string, name: string, args: object): OutputItem =>
  ({
    id,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  }) as OutputItem

const findFco = (items: unknown[]): FunctionCallOutputItem | undefined =>
  items.find((item) => (item as { type?: string }).type === 'function_call_output') as
    | FunctionCallOutputItem
    | undefined

const findAssistantText = (items: unknown[]): string | undefined => {
  const msg = items.find(
    (item) => (item as { type?: string }).type === 'message' && (item as { role?: string }).role === 'assistant',
  ) as { content?: Array<{ text?: string }> } | undefined
  return msg?.content?.[0]?.text
}

describe('createKernel().runTurn — minimal turn loop', () => {
  test('a simple turn against the default scripted model completes in one round', async () => {
    const kernel = createKernel()
    const result = await kernel.runTurn({ space: 's', prompt: 'Hello' })
    expect(result.ok).toBe(true)
    expect(result.space).toBe('s')
    expect(result.status).toBe('completed')
    expect(result.iterations).toBe(1)
    // Trajectory: the user message + the scripted final assistant message.
    expect(result.items).toHaveLength(2)
    expect((result.items[0] as { type: string; role: string }).type).toBe('message')
    expect((result.items[0] as { role: string }).role).toBe('user')
    expect(findAssistantText(result.items)).toBe('OK')
    expect(result.usage).toEqual({ input_tokens: 1, output_tokens: 1, total_tokens: 2 })
  })

  test('a scripted function_call round dispatches and the output correlates by call_id', async () => {
    const kernel = createKernel({
      modelTools: createScriptedModelTools({
        script: [
          { items: [functionCall('fc_1', 'call_abc', 'echo', { q: 'a' })], status: 'completed' },
          { items: [assistantMessage('msg_done', 'done')], status: 'completed' },
        ],
      }),
      dispatchTools: { echo: echoTool },
    })
    const result = await kernel.runTurn({ space: 's', prompt: 'use the echo tool' })
    expect(result.status).toBe('completed')
    expect(result.iterations).toBe(2)
    // The function_call_output is in the trajectory, correlated by call_id.
    const fco = findFco(result.items)
    expect(fco).toBeDefined()
    expect(fco!.call_id).toBe('call_abc')
    expect(fco!.status).toBe('completed')
    expect(fco!.type).toBe('function_call_output')
    expect(fco!.id).not.toBe('call_abc')
    expect(JSON.parse(fco!.output)).toEqual({ echoed: { q: 'a' } })
    // The turn completed with the final assistant message.
    expect(findAssistantText(result.items)).toBe('done')
  })

  test('a turn that never produces a final message stops at the max-iteration guard', async () => {
    // A single-entry array that always returns a function_call (clamped to last).
    const kernel = createKernel({
      modelTools: createScriptedModelTools({
        script: [{ items: [functionCall('fc_loop', 'call_loop', 'echo', { n: 1 })], status: 'completed' }],
      }),
      dispatchTools: { echo: echoTool },
      maxIterations: 3,
    })
    const result = await kernel.runTurn({ space: 's', prompt: 'loop forever' })
    expect(result.status).toBe('incomplete')
    expect(result.iterations).toBe(3)
    // Every round dispatched an echo; three function_call_outputs correlate.
    const fcos = result.items.filter((item) => (item as { type?: string }).type === 'function_call_output')
    expect(fcos).toHaveLength(3)
    for (const fco of fcos) expect((fco as FunctionCallOutputItem).call_id).toBe('call_loop')
  })

  test('a model error stops the turn with failed status', async () => {
    const failingRespond = Object.defineProperty(async () => ({ isError: true, message: 'model down' }), 'name', {
      value: MODEL_RESPOND_TOOL_NAME,
      configurable: true,
    }) as unknown as ModelRespondTool
    const noopCompact = Object.defineProperty(async () => ({ encrypted_content: 'x' }), 'name', {
      value: MODEL_COMPACT_TOOL_NAME,
      configurable: true,
    }) as unknown as ModelCompactTool
    const kernel = createKernel({ modelTools: { modelRespond: failingRespond, modelCompact: noopCompact } })
    const result = await kernel.runTurn({ space: 's', prompt: 'anything' })
    expect(result.status).toBe('failed')
    expect(result.iterations).toBe(1)
  })

  test('two simple turns with the same prompt produce deep-equal results (deterministic)', async () => {
    const kernel = createKernel()
    const a = await kernel.runTurn({ space: 's', prompt: 'same prompt' })
    const b = await kernel.runTurn({ space: 's', prompt: 'same prompt' })
    // The trace carries per-run timestamps/instanceId — compare the
    // deterministic trajectory fields, not the raw exhaust.
    const { trace: _ta, ...aRest } = a
    const { trace: _tb, ...bRest } = b
    expect(Bun.deepEquals(aRest, bRest)).toBe(true)
  })

  test('spaces stay isolated — a second space does not observe the first', async () => {
    const kernel = createKernel()
    const a = await kernel.runTurn({ space: 'alpha', prompt: 'in alpha' })
    const b = await kernel.runTurn({ space: 'beta', prompt: 'in beta' })
    expect(a.space).toBe('alpha')
    expect(b.space).toBe('beta')
    // Each trajectory starts with its own user message.
    expect((a.items[0] as { content: string }).content).toBe('in alpha')
    expect((b.items[0] as { content: string }).content).toBe('in beta')
  })
})

describe('createKernel().runTurn — MINIMAL scaffolding marker', () => {
  test('the turn-loop thread is marked MINIMAL scaffolding', async () => {
    const source = await Bun.file('./src/kernel/threads.ts').text()
    expect(source.includes('MINIMAL: scaffolding turn-loop')).toBe(true)
  })
})

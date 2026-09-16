import { describe, expect, test } from 'bun:test'
import { ajv } from '../../tools/use-tool.ts'
import {
  createModelExecutor,
  createModelTools,
  createScriptedModelTools,
  DEFAULT_SCRIPTED_RESPONSE,
  MODEL_COMPACT_TOOL_NAME,
  MODEL_RESPOND_TOOL_NAME,
  ModelCompactInputSchema,
  ModelCompactOutputSchema,
  ModelRespondInputSchema,
  ModelRespondOutputSchema,
} from '../use-model.ts'
import { ASSISTANT_TEXT, startOpenResponsesServer } from './model-server-fixture.ts'

const validateRespondInput = ajv.compile(ModelRespondInputSchema)
const validateRespondOutput = ajv.compile(ModelRespondOutputSchema)
const validateCompactInput = ajv.compile(ModelCompactInputSchema)
const validateCompactOutput = ajv.compile(ModelCompactOutputSchema)

const userMessage = { type: 'message', role: 'user', content: 'Say hello' } as const

describe('model tools — schema contract', () => {
  test('respond requires provider, modelId, and input', () => {
    expect(validateRespondInput({})).toBe(false)
    expect(validateRespondInput({ provider: 'p', modelId: 'm' })).toBe(false)
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [] })).toBe(true)
  })

  test('respond rejects unknown/host-only fields (no apiKey or url on the wire)', () => {
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], apiKey: 'leak' })).toBe(false)
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], url: 'http://x' })).toBe(false)
  })

  test('reasoningEffort is constrained to the enum', () => {
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 'ultra' })).toBe(false)
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 'high' })).toBe(true)
  })

  test('compact requires provider, modelId, and input; promptCacheKey is optional', () => {
    expect(validateCompactInput({ provider: 'p', modelId: 'm' })).toBe(false)
    expect(validateCompactInput({ provider: 'p', modelId: 'm', input: [] })).toBe(true)
    expect(validateCompactInput({ provider: 'p', modelId: 'm', input: [], promptCacheKey: 'k' })).toBe(true)
  })
})

describe('model tools — call-through over the executor', () => {
  test('runs a respond call through the worker and the result satisfies the output schema', async () => {
    const server = await startOpenResponsesServer()
    const executor = createModelExecutor({ endpoints: { mock: { url: server.url } } })
    try {
      const { modelRespond, modelCompact } = createModelTools(executor)
      expect(modelRespond.name).toBe(MODEL_RESPOND_TOOL_NAME)
      expect(modelCompact.name).toBe(MODEL_COMPACT_TOOL_NAME)

      const out = await modelRespond({ provider: 'mock', modelId: 'mock-model', input: [userMessage] })
      expect(validateRespondOutput(out)).toBe(true)
      expect((out as { isError?: boolean }).isError).toBeUndefined()
      expect((out as { items: Array<{ content?: Array<{ text?: string }> }> }).items[0]?.content?.[0]?.text).toBe(
        ASSISTANT_TEXT,
      )
    } finally {
      executor.destroy()
      await server.close()
    }
  })

  test('invalid input is rejected at the boundary and never reaches the executor', async () => {
    const { modelRespond } = createScriptedModelTools({ script: DEFAULT_SCRIPTED_RESPONSE })
    const out = await modelRespond({ provider: '', modelId: '', input: [] })
    expect((out as { isError?: boolean }).isError).toBe(true)
    expect((out as { message?: string }).message).toContain('invalid input')
  })
})

describe('createScriptedModelTools — deterministic in-process double (no worker, no fetch)', () => {
  test('a single scripted response repeats on every call', async () => {
    const { modelRespond, modelCompact } = createScriptedModelTools({ script: DEFAULT_SCRIPTED_RESPONSE })
    const first = await modelRespond({ provider: 'scripted', modelId: 'm', input: [userMessage] })
    const second = await modelRespond({ provider: 'scripted', modelId: 'm', input: [userMessage] })
    expect(validateRespondOutput(first)).toBe(true)
    expect((first as { items: unknown[] }).items).toHaveLength(1)
    expect((second as { items: unknown[] }).items).toHaveLength(1)

    const compact = await modelCompact({ provider: 'scripted', modelId: 'm', input: [userMessage] })
    expect(validateCompactOutput(compact)).toBe(true)
    expect((compact as { encrypted_content?: string }).encrypted_content).toBe('scripted-compaction')
  })

  test('an array script advances one entry per call', async () => {
    const { modelRespond } = createScriptedModelTools({
      script: [
        { items: [], status: 'first' },
        { items: [], status: 'second' },
      ],
    })
    const first = await modelRespond({ provider: 'scripted', modelId: 'm', input: [userMessage] })
    const second = await modelRespond({ provider: 'scripted', modelId: 'm', input: [userMessage] })
    expect((first as { status?: string }).status).toBe('first')
    expect((second as { status?: string }).status).toBe('second')
  })
})

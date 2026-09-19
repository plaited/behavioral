import { describe, expect, test } from 'bun:test'
import { ajv } from '../../tools/use-tool.ts'
import {
  createModelExecutor,
  createModelTools,
  createScriptedModelTools,
  DEFAULT_SCRIPTED_RESPONSE,
  MODEL_RESPOND_TOOL_NAME,
  ModelRespondInputSchema,
  ModelRespondOutputSchema,
} from '../use-responses-client.ts'
import { ASSISTANT_TEXT, startOpenResponsesServer } from './fixtures/model-server.ts'

const validateRespondInput = ajv.compile(ModelRespondInputSchema)
const validateRespondOutput = ajv.compile(ModelRespondOutputSchema)

const userMessage = { type: 'message', role: 'user', content: 'Say hello' } as const

describe('model tools — schema contract', () => {
  test('respond requires provider, modelId, and input', () => {
    expect(validateRespondInput({})).toBe(false)
    expect(validateRespondInput({ provider: 'p', modelId: 'm' })).toBe(false)
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [] })).toBe(true)
  })

  test('respond rejects unknown/host-only fields as endpoint config — extras are inert body data', async () => {
    const server = await startOpenResponsesServer({ apiKey: 'real-key' })
    const executor = createModelExecutor({
      endpoints: { mock: { url: server.url, apiKey: 'real-key' } },
    })
    try {
      const { modelRespond } = createModelTools(executor)
      const out = await modelRespond({
        provider: 'mock',
        modelId: 'mock-model',
        input: [userMessage],
        apiKey: 'inert-body-value',
        url: 'http://evil.example',
      })
      // The call still went to the provisioned endpoint with the provisioned
      // key — args never reconfigure the connection.
      expect((out as { isError?: boolean }).isError).toBeUndefined()
      expect(server.requests[0]?.path).toBe('/responses')
      expect(server.requests[0]?.auth).toBe('Bearer real-key')
      // Extra keys pass through as plain body data, nothing more.
      const body = server.requests[0]?.body as Record<string, unknown>
      expect(body.apiKey).toBe('inert-body-value')
      expect(body.url).toBe('http://evil.example')
    } finally {
      executor.destroy()
      await server.close()
    }
  })

  test('reasoningEffort declares the spec enum and passes non-spec values through', () => {
    // Spec values accepted.
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 'high' })).toBe(true)
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 'xhigh' })).toBe(true)
    // Non-spec values (OpenAI-only minimal, endpoint extensions) pass through.
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 'minimal' })).toBe(true)
    // Structure is still guarded: empty and non-string values rejected.
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: '' })).toBe(false)
    expect(validateRespondInput({ provider: 'p', modelId: 'm', input: [], reasoningEffort: 3 })).toBe(false)
  })

  test('extra key-values pass through validation and reach the wire verbatim', async () => {
    const server = await startOpenResponsesServer()
    const executor = createModelExecutor({ endpoints: { mock: { url: server.url } } })
    try {
      const { modelRespond } = createModelTools(executor)
      const out = await modelRespond({
        provider: 'mock',
        modelId: 'mock-model',
        input: [userMessage],
        prompt_cache_key: 'cache-1',
        temperature: 0.2,
        // OpenAI-only effort flows through as the raw spec param object.
        reasoning: { effort: 'minimal' },
      })
      expect((out as { isError?: boolean }).isError).toBeUndefined()
      const body = server.requests[0]?.body as Record<string, unknown>
      expect(body.prompt_cache_key).toBe('cache-1')
      expect(body.temperature).toBe(0.2)
      expect(body.reasoning).toEqual({ effort: 'minimal' })
    } finally {
      executor.destroy()
      await server.close()
    }
  })
})

describe('model tools — call-through over the executor', () => {
  test('runs a respond call through the worker and the result satisfies the output schema', async () => {
    const server = await startOpenResponsesServer()
    const executor = createModelExecutor({ endpoints: { mock: { url: server.url } } })
    try {
      const { modelRespond } = createModelTools(executor)
      expect(modelRespond.name).toBe(MODEL_RESPOND_TOOL_NAME)

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
    const { modelRespond } = createScriptedModelTools({ script: DEFAULT_SCRIPTED_RESPONSE })
    const first = await modelRespond({ provider: 'scripted', modelId: 'm', input: [userMessage] })
    const second = await modelRespond({ provider: 'scripted', modelId: 'm', input: [userMessage] })
    expect(validateRespondOutput(first)).toBe(true)
    expect((first as { items: unknown[] }).items).toHaveLength(1)
    expect((second as { items: unknown[] }).items).toHaveLength(1)
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

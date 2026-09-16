import { describe, expect, test } from 'bun:test'
import { createModelExecutor, type ModelDeltaSink } from '../use-model.ts'
import { ASSISTANT_TEXT, COMPACT_ENCRYPTED_CONTENT, startOpenResponsesServer } from './model-server-fixture.ts'

describe('model executor — non-streaming respond', () => {
  test('round-trips a JSON ResponseResource through the worker', async () => {
    const server = await startOpenResponsesServer()
    const executor = createModelExecutor({ endpoints: { mock: { url: server.url } } })
    try {
      const out = await executor.respond({
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'Say hello' }],
      })
      const success = out as {
        items: Array<{ type: string; content?: Array<{ text?: string }> }>
        status: string
        usage?: { total_tokens: number }
        isError?: boolean
      }
      expect(success.isError).toBeUndefined()
      expect(success.status).toBe('completed')
      expect(success.items).toHaveLength(1)
      expect(success.items[0]?.content?.[0]?.text).toBe(ASSISTANT_TEXT)
      expect(success.usage).toMatchObject({ total_tokens: 20 })
    } finally {
      executor.destroy()
      await server.close()
    }
  })
})

describe('model executor — streaming respond', () => {
  test('emits DELTA events as they arrive and assembles the terminal result', async () => {
    const server = await startOpenResponsesServer()
    const deltas: ModelDeltaSink[] = []
    const executor = createModelExecutor({
      endpoints: { mock: { url: server.url } },
      onDelta: (event) => deltas.push(event),
    })
    try {
      const out = await executor.respond({
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'Count from 1 to 5.' }],
        stream: true,
      })
      const success = out as {
        items: Array<{ type: string; content?: Array<{ text?: string }> }>
        status: string
        events?: Array<{ type: string; delta?: string }>
        isError?: boolean
      }
      expect(success.isError).toBeUndefined()
      expect(success.status).toBe('completed')
      expect(deltas.map((d) => d.event.type)).toEqual([
        'response.output_item.added',
        'response.output_text.delta',
        'response.output_text.delta',
        'response.output_item.done',
        'response.completed',
      ])
      // The terminal result still carries the buffered event list.
      expect(success.events?.map((e) => e.type)).toEqual(deltas.map((d) => d.event.type))
      const text = success.items[0]?.content?.[0]?.text
      expect(text).toBe(ASSISTANT_TEXT)
    } finally {
      executor.destroy()
      await server.close()
    }
  })
})

describe('model executor — endpoint config via environment data', () => {
  test('the provisioned apiKey reaches the wire as a bearer header', async () => {
    const server = await startOpenResponsesServer({ apiKey: 'secret-token' })
    const executor = createModelExecutor({
      endpoints: { mock: { url: server.url, apiKey: 'secret-token' } },
    })
    try {
      const out = await executor.respond({
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      })
      expect((out as { isError?: boolean }).isError).toBeUndefined()
      expect(server.requests[0]?.auth).toBe('Bearer secret-token')
    } finally {
      executor.destroy()
      await server.close()
    }
  })

  test('an unknown provider is error data, never a throw', async () => {
    const executor = createModelExecutor({ endpoints: {} })
    try {
      const out = await executor.respond({
        provider: 'nope',
        modelId: 'm',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      })
      expect((out as { isError?: boolean }).isError).toBe(true)
      expect((out as { message?: string }).message).toContain('unknown provider')
    } finally {
      executor.destroy()
    }
  })
})

describe('model executor — compact', () => {
  test('round-trips encrypted_content from a compaction resource', async () => {
    const server = await startOpenResponsesServer()
    const executor = createModelExecutor({ endpoints: { mock: { url: server.url } } })
    try {
      const out = await executor.compact({
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'compact me' }],
      })
      const success = out as { encrypted_content?: string; usage?: { total_tokens: number }; isError?: boolean }
      expect(success.isError).toBeUndefined()
      expect(success.encrypted_content).toBe(COMPACT_ENCRYPTED_CONTENT)
      expect(success.usage).toMatchObject({ total_tokens: 150 })
      expect(server.requests[0]?.path).toBe('/responses/compact')
    } finally {
      executor.destroy()
      await server.close()
    }
  })
})

describe('model executor — failures are data', () => {
  test('a non-2xx response is error data carrying the structured message', async () => {
    const server = await startOpenResponsesServer()
    const executor = createModelExecutor({ endpoints: { mock: { url: server.url } } })
    try {
      const out = await executor.respond({ provider: 'mock', modelId: 'mock-model', input: [] })
      expect((out as { isError?: boolean }).isError).toBe(true)
      expect((out as { message?: string }).message).toContain('HTTP 400')
    } finally {
      executor.destroy()
      await server.close()
    }
  })
})

describe('model executor — cancellation', () => {
  test('cancel aborts an in-flight streamed call as error data', async () => {
    const encoder = new TextEncoder()
    // A real server that emits one event and then never closes the stream.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"response.output_item.added","item":{"id":"msg_c","type":"message","status":"in_progress","role":"assistant","content":[]}}\n\n',
                ),
              )
              // Never close — the call stays in flight until canceled.
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    const executor = createModelExecutor({
      endpoints: { mock: { url: `http://localhost:${server.port}` } },
      onDelta: (event) => executor.cancel(event.id),
    })
    try {
      const out = await executor.respond({
        provider: 'mock',
        modelId: 'mock-model',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
        stream: true,
      })
      expect((out as { isError?: boolean }).isError).toBe(true)
      expect((out as { message?: string }).message).toContain('canceled')
    } finally {
      executor.destroy()
      server.stop(true)
    }
  })
})

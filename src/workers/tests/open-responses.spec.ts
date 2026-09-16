import { describe, expect, test } from 'bun:test'
import type { KnownStreamEvent, OpenResponsesStreamEvent } from '../open-responses.schemas.ts'
import {
  CompactionItemSchema,
  ErrorSchema,
  FunctionCallItemSchema,
  FunctionCallOutputItemSchema,
  KnownStreamEventSchema,
  MessageItemSchema,
  OpenResponsesRequestSchema,
  OutputTextContentSchema,
  ReasoningTextContentSchema,
  StreamEventLaxSchema,
  UsageSchema,
} from '../open-responses.schemas.ts'

// --- Scenario 1: happy text turn ---
const happyEvents: KnownStreamEvent[] = [
  {
    type: 'response.output_item.added',
    item: {
      id: 'msg_1',
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: 'Hello',
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: ' world',
  },
  {
    type: 'response.output_item.done',
    item: {
      id: 'msg_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello world' }],
    },
  },
  {
    type: 'response.completed',
    status: 'completed',
  },
]

// --- Scenario 2: function call with argument deltas ---
const functionCallEvents: KnownStreamEvent[] = [
  {
    type: 'response.output_item.added',
    item: {
      id: 'fc_1',
      type: 'function_call',
      status: 'in_progress',
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 0,
    delta: '{"location":',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 0,
    delta: ' "Paris"}',
  },
  {
    type: 'response.output_item.done',
    item: {
      id: 'fc_1',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '{"location": "Paris"}',
    },
  },
  {
    type: 'response.completed',
    status: 'completed',
  },
]

// --- Scenario 3: failed response ---
const failedEvents: KnownStreamEvent[] = [
  {
    type: 'response.output_item.added',
    item: {
      id: 'msg_fail',
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  },
  {
    type: 'response.failed',
    status: 'failed',
    error: { code: 'context_length_exceeded', message: 'Context window full' },
  },
]

// --- Scenario 4: compaction item + usage ---
const compactionEvents: KnownStreamEvent[] = [
  {
    type: 'response.output_item.added',
    item: {
      id: 'cmp_1',
      type: 'compaction',
      status: 'completed',
      encrypted_content: 'encrypted:base64data',
    },
  },
  {
    type: 'response.completed',
    status: 'completed',
    usage: {
      input_tokens: 4500,
      output_tokens: 200,
      total_tokens: 4700,
    },
  },
]

// --- Scenario 5: unknown event passthrough ---
const unknownEventEvents: OpenResponsesStreamEvent[] = [
  {
    type: 'response.vendor_extra',
    some_field: 'passes through unvalidated',
  },
  {
    type: 'response.output_item.added',
    item: {
      id: 'msg_2',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    },
  },
  {
    type: 'response.completed',
    status: 'completed',
  },
]

// ================================================================
// Tests
// ================================================================

describe('schema validation — request', () => {
  test('valid request parses successfully', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
      input: [{ type: 'message', role: 'user', content: 'Hello' }],
    })
    expect(result.model.provider).toBe('anthropic')
    expect(result.input).toHaveLength(1)
  })

  test('valid request with function_call input parses', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
      input: [
        {
          type: 'function_call',
          call_id: 'call_xyz',
          name: 'get_weather',
          arguments: '{"location":"London"}',
        },
      ],
    })
    expect(result.input[0]!.type).toBe('function_call')
  })

  test('valid request with function_call_output input parses', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_xyz',
          output: '{"temperature":72}',
        },
      ],
    })
    expect(result.input[0]!.type).toBe('function_call_output')
  })

  test('malformed item (missing required field) is hard-rejected', () => {
    expect(() =>
      OpenResponsesRequestSchema.parse({
        model: { provider: 'test', modelId: 'm' },
        input: [
          { type: 'message', role: 'assistant' }, // missing content
        ],
      }),
    ).toThrow()
  })

  test('unknown item type is hard-rejected', () => {
    expect(() =>
      OpenResponsesRequestSchema.parse({
        model: { provider: 'test', modelId: 'm' },
        input: [{ type: 'computer_call', id: 'cc_1' }],
      }),
    ).toThrow()
  })

  test('tools with name, description, parameters parse', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: { provider: 'test', modelId: 'm' },
      input: [{ type: 'message', role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from disk',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    })
    expect(result.tools).toHaveLength(1)
  })

  test('tool missing parameters is hard-rejected', () => {
    expect(() =>
      OpenResponsesRequestSchema.parse({
        model: { provider: 'test', modelId: 'm' },
        input: [{ type: 'message', role: 'user', content: 'Hi' }],
        tools: [{ name: 'read_file', description: 'Read a file from disk' }],
      }),
    ).toThrow()
  })

  test('truncation and instructions parse', () => {
    const result = OpenResponsesRequestSchema.parse({
      model: { provider: 'test', modelId: 'm' },
      input: [{ type: 'message', role: 'system', content: 'You are helpful' }],
      truncation: 'disabled',
      instructions: 'Be concise',
    })
    expect(result.truncation).toBe('disabled')
    expect(result.instructions).toBe('Be concise')
  })
})

describe('content part schemas', () => {
  test('output_text parses', () => {
    const result = OutputTextContentSchema.parse({
      type: 'output_text',
      text: 'Hello world',
    })
    expect(result.text).toBe('Hello world')
  })

  test('reasoning_text parses', () => {
    const result = ReasoningTextContentSchema.parse({
      type: 'reasoning_text',
      text: 'Model is reasoning step by step',
    })
    expect(result.text).toContain('reasoning')
  })
})

describe('item schemas', () => {
  test('message item round-trips', () => {
    const item = {
      id: 'msg_1',
      type: 'message' as const,
      status: 'completed' as const,
      role: 'assistant' as const,
      content: [{ type: 'output_text' as const, text: 'Hi' }],
    }
    const result = MessageItemSchema.parse(item)
    expect(result.id).toBe('msg_1')
    expect(result.role).toBe('assistant')
  })

  test('function_call item parses with assembled arguments', () => {
    const item = {
      id: 'fc_1',
      type: 'function_call' as const,
      status: 'completed' as const,
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '{"location": "Paris"}',
    }
    const result = FunctionCallItemSchema.parse(item)
    expect(result.arguments).toBe('{"location": "Paris"}')
    expect(result.call_id).toBe('call_abc')
  })

  test('function_call_output parses', () => {
    const item = {
      id: 'fco_1',
      type: 'function_call_output' as const,
      status: 'completed' as const,
      call_id: 'call_abc',
      output: '{"temperature": 72}',
    }
    const result = FunctionCallOutputItemSchema.parse(item)
    expect(result.output).toBe('{"temperature": 72}')
  })

  test('compaction item round-trips', () => {
    const item = {
      id: 'cmp_1',
      type: 'compaction' as const,
      status: 'completed' as const,
      encrypted_content: 'encrypted:abc123',
    }
    const result = CompactionItemSchema.parse(item)
    expect(result.encrypted_content).toBe('encrypted:abc123')
  })
})

describe('usage schema', () => {
  test('parses full usage with details', () => {
    const result = UsageSchema.parse({
      input_tokens: 4500,
      output_tokens: 200,
      total_tokens: 4700,
      input_tokens_details: { cached_tokens: 1000 },
      output_tokens_details: { reasoning_tokens: 50 },
    })
    expect(result.total_tokens).toBe(4700)
    expect(result.input_tokens_details?.cached_tokens).toBe(1000)
    expect(result.output_tokens_details?.reasoning_tokens).toBe(50)
  })

  test('parses minimal usage without details', () => {
    const result = UsageSchema.parse({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    })
    expect(result.total_tokens).toBe(150)
  })
})

describe('error schema', () => {
  test('error parses with code and message', () => {
    const result = ErrorSchema.parse({
      code: 'context_length_exceeded',
      message: 'Context window full',
    })
    expect(result.code).toBe('context_length_exceeded')
  })
})

describe('stream event scenarios', () => {
  test('happy path: item added → text deltas → item done → completed', () => {
    for (const ev of happyEvents) {
      const result = StreamEventLaxSchema.parse(ev)
      expect(result.type).toBeTypeOf('string')
    }
  })

  test('function_call arguments deltas assemble correctly', () => {
    // Validate each event in the scenario
    for (const ev of functionCallEvents) {
      const result = KnownStreamEventSchema.parse(ev)
      expect(result.type).toBeTypeOf('string')
    }

    // Simulate assembling deltas from the stream
    let assembled = ''
    for (const ev of functionCallEvents) {
      if (ev.type === 'response.function_call_arguments.delta') {
        assembled += ev.delta
      }
    }
    // The last item carries the full arguments
    let fullArgs = ''
    for (const ev of functionCallEvents) {
      if (ev.type === 'response.output_item.done' && ev.item.type === 'function_call') {
        fullArgs = ev.item.arguments
      }
    }
    expect(assembled).toBe(fullArgs)
    expect(JSON.parse(fullArgs)).toEqual({ location: 'Paris' })
  })

  test('failed response consumed without thrown error', () => {
    const collected: KnownStreamEvent[] = []
    for (const ev of failedEvents) {
      const parsed = KnownStreamEventSchema.parse(ev)
      collected.push(parsed)
    }
    const terminal = collected[collected.length - 1]
    expect(terminal).toBeDefined()
    expect(terminal!.type).toBe('response.failed')
    if (terminal!.type === 'response.failed') {
      expect(terminal!.error.code).toBe('context_length_exceeded')
    }
  })

  test('unknown event type passes through without failing', () => {
    for (const ev of unknownEventEvents) {
      const result = StreamEventLaxSchema.parse(ev)
      expect(result.type).toBeTypeOf('string')
    }
    // Verify the unknown event has its passthrough field
    const unknown = unknownEventEvents[0]!
    const parsed = StreamEventLaxSchema.parse(unknown)
    expect(parsed.type).toBe('response.vendor_extra')
    // It should have passed through 'some_field'
    expect(parsed).toHaveProperty('some_field')
  })

  test('malformed known frame throws instead of passing through', () => {
    // A response.output_text.delta missing its required `delta` field is a
    // corrupted known frame — it must fail validation, not masquerade as an
    // unknown provider extra.
    const malformed = { type: 'response.output_text.delta', item_id: 'msg_1' }
    expect(() => StreamEventLaxSchema.parse(malformed)).toThrow()
  })

  test('compaction item round-trips through schema', () => {
    for (const ev of compactionEvents) {
      const result = KnownStreamEventSchema.parse(ev)
      expect(result.type).toBeTypeOf('string')
    }
  })

  test('terminal event with usage parses token counts intact', () => {
    const ev = compactionEvents[1]!
    const parsed = KnownStreamEventSchema.parse(ev)
    expect(parsed.type).toBe('response.completed')
    if (parsed.type === 'response.completed') {
      expect(parsed.usage?.input_tokens).toBe(4500)
      expect(parsed.usage?.output_tokens).toBe(200)
      expect(parsed.usage?.total_tokens).toBe(4700)
    }
  })
})

import { describe, expect, test } from 'bun:test'
import {
  AudioContentSchema,
  ImageContentSchema,
  InputContentPartSchema,
  InputTextContentSchema,
  MessageItemParamSchema,
  VideoContentSchema,
} from '../open-responses.schemas.ts'

// ================================================================
// Input content parts — schema validation
// ================================================================

describe('InputTextContentSchema', () => {
  test('accepts simple text', () => {
    const result = InputTextContentSchema.parse({ type: 'input_text', text: 'Hello world' })
    expect(result.type).toBe('input_text')
    expect(result.text).toBe('Hello world')
  })

  test('rejects missing text', () => {
    expect(() => InputTextContentSchema.parse({ type: 'input_text' })).toThrow()
  })

  test('rejects wrong type', () => {
    expect(() => InputTextContentSchema.parse({ type: 'image', text: 'nope' })).toThrow()
  })
})

describe('ImageContentSchema', () => {
  test('accepts a data: URI', () => {
    const result = ImageContentSchema.parse({
      type: 'image',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    })
    expect(result.type).toBe('image')
    expect(result.image_url.url).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  test('accepts a regular URL', () => {
    const result = ImageContentSchema.parse({
      type: 'image',
      image_url: { url: 'https://example.com/photo.jpg' },
    })
    expect(result.image_url.url).toBe('https://example.com/photo.jpg')
  })

  test('accepts optional detail', () => {
    const result = ImageContentSchema.parse({
      type: 'image',
      image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' },
    })
    expect(result.image_url.detail).toBe('high')
  })

  test('rejects missing url', () => {
    expect(() => ImageContentSchema.parse({ type: 'image', image_url: {} })).toThrow()
  })

  test('rejects missing image_url entirely', () => {
    expect(() => ImageContentSchema.parse({ type: 'image' })).toThrow()
  })

  test('rejects invalid detail value', () => {
    expect(() =>
      ImageContentSchema.parse({
        type: 'image',
        image_url: { url: 'data:image/png;base64,AAAA', detail: 'ultra' },
      }),
    ).toThrow()
  })
})

describe('AudioContentSchema', () => {
  test('accepts base64 data with format', () => {
    const result = AudioContentSchema.parse({
      type: 'audio',
      data: '//uQxAAAAA...',
      format: 'mp3',
    })
    expect(result.type).toBe('audio')
    expect(result.data).toBe('//uQxAAAAA...')
    expect(result.format).toBe('mp3')
  })

  test('accepts data without optional format', () => {
    const result = AudioContentSchema.parse({
      type: 'audio',
      data: 'data:audio/mpeg;base64,AAAA',
    })
    expect(result.data).toBe('data:audio/mpeg;base64,AAAA')
    expect(result.format).toBeUndefined()
  })

  test('rejects missing data', () => {
    expect(() => AudioContentSchema.parse({ type: 'audio', format: 'wav' })).toThrow()
  })

  test('rejects invalid format value', () => {
    expect(() => AudioContentSchema.parse({ type: 'audio', data: 'AAAA', format: 'mp4' })).toThrow()
  })

  test('accepts all valid audio formats', () => {
    for (const format of ['mp3', 'wav', 'ogg', 'flac', 'aac'] as const) {
      const result = AudioContentSchema.parse({ type: 'audio', data: 'AAAA', format })
      expect(result.format).toBe(format)
    }
  })
})

describe('VideoContentSchema', () => {
  test('accepts base64 data with format', () => {
    const result = VideoContentSchema.parse({
      type: 'video',
      data: 'AAAA',
      format: 'mp4',
    })
    expect(result.type).toBe('video')
    expect(result.data).toBe('AAAA')
    expect(result.format).toBe('mp4')
  })

  test('accepts data without optional format', () => {
    const result = VideoContentSchema.parse({
      type: 'video',
      data: 'data:video/mp4;base64,AAAA',
    })
    expect(result.format).toBeUndefined()
  })

  test('rejects missing data', () => {
    expect(() => VideoContentSchema.parse({ type: 'video', format: 'webm' })).toThrow()
  })

  test('rejects invalid format value', () => {
    expect(() => VideoContentSchema.parse({ type: 'video', data: 'AAAA', format: 'mp3' })).toThrow()
  })

  test('accepts all valid video formats', () => {
    for (const format of ['mp4', 'webm', 'avi', 'mov', 'quicktime'] as const) {
      const result = VideoContentSchema.parse({ type: 'video', data: 'AAAA', format })
      expect(result.format).toBe(format)
    }
  })
})

describe('InputContentPartSchema (discriminated union)', () => {
  test('narrows to input_text', () => {
    const result = InputContentPartSchema.parse({ type: 'input_text', text: 'hi' })
    // TypeScript narrowing check: result.text should be accessible
    expect(result.type).toBe('input_text')
    if (result.type === 'input_text') {
      expect(result.text).toBe('hi')
    }
  })

  test('narrows to image', () => {
    const result = InputContentPartSchema.parse({
      type: 'image',
      image_url: { url: 'data:image/png;base64,AAAA' },
    })
    expect(result.type).toBe('image')
    if (result.type === 'image') {
      expect(result.image_url.url).toBe('data:image/png;base64,AAAA')
    }
  })

  test('narrows to audio', () => {
    const result = InputContentPartSchema.parse({ type: 'audio', data: 'AAAA', format: 'ogg' })
    expect(result.type).toBe('audio')
    if (result.type === 'audio') {
      expect(result.data).toBe('AAAA')
      expect(result.format).toBe('ogg')
    }
  })

  test('narrows to video', () => {
    const result = InputContentPartSchema.parse({ type: 'video', data: 'AAAA', format: 'mp4' })
    expect(result.type).toBe('video')
    if (result.type === 'video') {
      expect(result.data).toBe('AAAA')
    }
  })

  test('rejects unknown type', () => {
    expect(() => InputContentPartSchema.parse({ type: 'output_text', text: 'hello' })).toThrow()
    expect(() => InputContentPartSchema.parse({ type: 'reasoning_text', text: 'thinking' })).toThrow()
  })
})

describe('MessageItemParamSchema with InputContentPart[]', () => {
  test('accepts content as string', () => {
    const result = MessageItemParamSchema.parse({
      type: 'message',
      role: 'user',
      content: 'Hello',
    })
    expect(result.content).toBe('Hello')
  })

  test('accepts content as array of input content parts', () => {
    const parsed = MessageItemParamSchema.parse({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is this?' },
        { type: 'image', image_url: { url: 'data:image/png;base64,iVBOR' } },
        { type: 'audio', data: 'AAAA', format: 'wav' },
      ],
    })
    expect(Array.isArray(parsed.content)).toBe(true)
    const content = parsed.content as Array<unknown>
    expect(content).toHaveLength(3)
    const first = content[0] as { type: string }
    expect(first.type).toBe('input_text')
  })

  test('accepts a single image content part in array', () => {
    const result = MessageItemParamSchema.parse({
      type: 'message',
      role: 'user',
      content: [{ type: 'image', image_url: { url: 'data:image/png;base64,AAAA' } }],
    })
    expect(Array.isArray(result.content)).toBe(true)
    expect(result.content).toHaveLength(1)
  })

  test('rejects array with mixed output-side content parts', () => {
    expect(() =>
      MessageItemParamSchema.parse({
        type: 'message',
        role: 'user',
        content: [{ type: 'output_text', text: 'hello' }],
      }),
    ).toThrow()
  })
})

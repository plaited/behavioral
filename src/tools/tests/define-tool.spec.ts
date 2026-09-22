/**
 * defineTool — defined once, bound late.
 *
 * The tool factory returns a ctx binder: schemas compile at definition, the
 * capability context binds at the composition root (per host), and the bound
 * tool is the executable the fleet dispatches. One definition, N bindings.
 */
import { describe, expect, test } from 'bun:test'
import type { JSONSchemaType } from 'ajv'
import { defineTool } from '../define-tool.ts'

const probeSpec = {
  name: 'probe',
  description: 'probe tool',
  inputSchema: {
    type: 'object',
    properties: { n: { type: 'number' } },
    required: ['n'],
    additionalProperties: false,
  } as unknown as JSONSchemaType<{ n: number }>,
  outputSchema: {
    type: 'object',
    properties: { scaled: { type: 'number' } },
    required: ['scaled'],
    additionalProperties: false,
  } as unknown as JSONSchemaType<{ scaled: number }>,
}

describe('defineTool — defined once, bound late', () => {
  test('returns a ctx binder; the bound tool runs with the binding ctx', () => {
    const binder = defineTool(probeSpec, (input, _validate, ctx: { factor: number }) => ({
      scaled: input.n * ctx.factor,
    }))

    const doubled = binder({ factor: 2 })
    const tripled = binder({ factor: 3 })
    expect(doubled({ n: 2 })).toEqual({ scaled: 4 })
    expect(tripled({ n: 2 })).toEqual({ scaled: 6 })
  })

  test('the bound tool carries name + description + schemas for fleet reflection', () => {
    const tool = defineTool(probeSpec, (input) => ({ scaled: input.n }))(undefined)
    expect(tool.name).toBe('probe')
    expect(tool.description).toBe('probe tool')
    expect(tool.inputSchema).toBe(probeSpec.inputSchema)
    expect(tool.outputSchema).toBe(probeSpec.outputSchema)
  })

  test('the compiled validators are shared across bindings and reach the cb', () => {
    const seen: { ok?: boolean } = {}
    const binder = defineTool(probeSpec, (input, validate) => {
      seen.ok = validate.input(input)
      return { scaled: input.n }
    })
    const first = binder(undefined)
    const second = binder(undefined)
    expect(first({ n: 4 })).toEqual({ scaled: 4 })
    expect(seen.ok).toBe(true)
    // second binding shares the same compiled validator (definition-time compile)
    expect(second({ n: 5 })).toEqual({ scaled: 5 })
    expect(seen.ok).toBe(true)
    // the validator rejects what the schema forbids — usable at the cb's discretion
    binder(undefined)({ n: 'not-a-number' } as unknown as { n: number })
    expect(seen.ok).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import { ajv } from '../../tools/use-tool.ts'
import type { BMeta } from '../bmeta.ts'
import { BMetaSchema, parseBMeta } from '../bmeta.ts'

const validate = ajv.compile(BMetaSchema)

const validMeta: BMeta = {
  type: 'thread',
  title: 'Turn loop governor',
  description: 'Blocks discovery writes outside the reconcile scan',
  generated: { by: 'turn-42', at: '2026-09-17T00:00:00Z' },
  status: 'stable',
}

describe('bmeta — shared OKF-vocabulary schema', () => {
  test('a valid BMeta validates against the JSON schema', () => {
    expect(validate(validMeta)).toBe(true)
  })

  test('the thread carrier convention: meta typed as BMeta is a plain object', () => {
    // `export const meta: BMeta = {...}` — the type is structural; the same
    // object must validate against the JSON schema the html carrier uses.
    const meta: BMeta = {
      ...validMeta,
      tags: ['governor', 'write-policy'],
      verified: [{ by: 'frontier-verify', at: '2026-09-17T01:00:00Z' }],
      stale_after: '2026-12-01',
      sources: ['research/self-improving-agents.md'],
    }
    expect(validate(meta)).toBe(true)
  })

  test('malformed metas are rejected — missing required, unknown field, bad status enum', () => {
    const cases: unknown[] = [
      // missing title/description/generated/status
      { type: 'thread' },
      // unknown field
      { ...validMeta, apiKey: 'sk-secret' },
      // status outside draft|stable|deprecated
      { ...validMeta, status: 'published' },
      // generated missing `at`
      { ...validMeta, generated: { by: 'turn-42' } },
    ]
    for (const meta of cases) {
      expect(validate(meta)).toBe(false)
    }
  })

  test('parseBMeta — valid JSON parses, malformed JSON and schema violations are not ok', () => {
    const ok = parseBMeta(JSON.stringify(validMeta))
    if (!ok.ok) throw new Error(`expected ok, got: ${ok.message}`)
    expect(ok.meta.title).toBe('Turn loop governor')

    const badJson = parseBMeta('{ nope')
    expect(badJson.ok).toBe(false)
    if (!badJson.ok) expect(badJson.message).toContain('JSON')

    const badSchema = parseBMeta(JSON.stringify({ type: 'thread' }))
    expect(badSchema.ok).toBe(false)
  })
})

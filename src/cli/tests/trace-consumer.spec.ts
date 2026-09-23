import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { collectSecretValues, createTraceConsumer, redactTrace, traceLogSink } from '../trace-consumer.ts'

const selection = (detail: JsonObject, space?: string): SelectionTrace => ({
  kind: TRACE_MESSAGE_KINDS.selection,
  timestamp: 0,
  instanceId: 'i',
  step: 1,
  selected: { priority: 0, type: 'shell_request', detail, ...(space === undefined ? {} : { space }) },
})

describe('redactTrace', () => {
  test('redacts a registered secret value wherever it appears, without mutating the input', () => {
    const secret = 'registry-only-secret-123456'
    const trace = selection({ op: 'shell', command: `curl -H "Authorization: ${secret}" https://x` })
    const redacted = redactTrace(trace, [secret])
    expect(JSON.stringify(redacted)).not.toContain(secret)
    expect(JSON.stringify(redacted)).toContain('[REDACTED]')
    // Non-mutation: the original still carries the secret.
    expect(JSON.stringify(trace)).toContain(secret)
  })

  test('redacts sensitive-named fields regardless of their value', () => {
    const trace = selection({ headers: { authorization: 'whatever', 'x-api-key': 'abc' }, url: 'https://x' })
    const redacted = redactTrace(trace, []) as SelectionTrace
    const detail = redacted.selected.detail as { headers: Record<string, string>; url: string }
    expect(detail.headers.authorization).toBe('[REDACTED]')
    expect(detail.headers['x-api-key']).toBe('[REDACTED]')
    expect(detail.url).toBe('https://x')
  })

  test('redacts known credential shapes even when undeclared', () => {
    const trace = selection({ command: 'curl -H "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"' })
    const redacted = redactTrace(trace, [])
    expect(JSON.stringify(redacted)).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
  })

  test('leaves benign detail untouched', () => {
    const trace = selection({ op: 'echo', label: 'probe' })
    expect(redactTrace(trace, ['not-present'])).toEqual(trace)
  })

  test('injected patterns replace the default credential-shape set', () => {
    const trace = selection({ note: 'deploy with my-custom-ACME-1234-token' })
    const redacted = redactTrace(trace, [], [/ACME-\d{4}/g])
    expect(JSON.stringify(redacted)).toContain('[REDACTED]')
    expect(JSON.stringify(redacted)).not.toContain('ACME-1234')
  })
})

describe('collectSecretValues', () => {
  test('collects env values whose key looks sensitive, ignoring short/empty/benign', () => {
    const values = collectSecretValues({
      OPENROUTER_API_KEY: 'sk-or-abcdefghijklmnop',
      MCP_BROKER_BOOT_SECRET: 'bootsecretvalue',
      HF_TOKEN: 'hftokenvalue123',
      MODEL_ENDPOINTS: '{"a":"b"}',
      SHORT_TOKEN: 'x',
      EMPTY_SECRET: '',
    })
    expect(values).toContain('sk-or-abcdefghijklmnop')
    expect(values).toContain('bootsecretvalue')
    expect(values).toContain('hftokenvalue123')
    expect(values).not.toContain('{"a":"b"}')
    expect(values).not.toContain('x')
    expect(values).not.toContain('')
  })
})

describe('createTraceConsumer', () => {
  test('redacts once and fans out to every sink', () => {
    const secret = 'registry-only-secret-123456'
    const seen: Trace[] = []
    const consumer = createTraceConsumer({ secrets: [secret], sinks: [(t) => seen.push(t), (t) => seen.push(t)] })
    consumer(selection({ command: `echo ${secret}` }))
    expect(seen).toHaveLength(2)
    expect(JSON.stringify(seen[0])).not.toContain(secret)
    expect(JSON.stringify(seen[1])).not.toContain(secret)
  })

  test('one throwing sink does not starve the others', () => {
    const seen: Trace[] = []
    const consumer = createTraceConsumer({
      sinks: [
        () => {
          throw new Error('boom')
        },
        (t) => seen.push(t),
      ],
    })
    expect(() => consumer(selection({ op: 'echo' }))).not.toThrow()
    expect(seen).toHaveLength(1)
  })
})

describe('traceLogSink', () => {
  test('appends one JSON line per trace under <root>/<space>/<date>.jsonl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'behavioral-traces-'))
    try {
      const sink = traceLogSink({ root })
      sink(selection({ op: 'echo' }, 'space-a'))
      sink(selection({ op: 'echo' }, 'space-a'))
      const date = new Date().toISOString().slice(0, 10)
      const lines = (await Bun.file(join(root, 'space-a', `${date}.jsonl`)).text()).trim().split('\n')
      expect(lines).toHaveLength(2)
      const first = lines[0]
      if (first === undefined) throw new Error('no line written')
      expect((JSON.parse(first) as { kind: string }).kind).toBe(TRACE_MESSAGE_KINDS.selection)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a trace with no space lands under the root space', async () => {
    const root = mkdtempSync(join(tmpdir(), 'behavioral-traces-'))
    try {
      traceLogSink({ root })(selection({ op: 'echo' }))
      const date = new Date().toISOString().slice(0, 10)
      expect(await Bun.file(join(root, 'root', `${date}.jsonl`)).exists()).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

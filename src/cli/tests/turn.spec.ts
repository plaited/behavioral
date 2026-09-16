import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { TurnResultSchema } from '../../kernel/kernel.ts'

const repoRoot = path.resolve(import.meta.dir, '../../..')

const runTurnCli = async (input: string): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(['bun', 'bin/behavioral.ts', 'turn', input], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repoRoot,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

describe('behavioral turn — CLI seam', () => {
  test('runs one scripted turn and prints a valid TurnResult JSON', async () => {
    const { code, stdout, stderr } = await runTurnCli('{"space":"s","prompt":"Hello"}')
    expect(code).toBe(0)
    expect(stderr).toBe('')
    const result = JSON.parse(stdout) as {
      ok: boolean
      space: string
      status: string
      items: unknown[]
      iterations: number
      usage?: unknown
    }
    expect(result.ok).toBe(true)
    expect(result.space).toBe('s')
    expect(result.status).toBe('completed')
    expect(result.iterations).toBe(1)
    expect(result.items).toHaveLength(2)
    expect(result.usage).toBeDefined()
  })

  test('output includes a trace array with selection events and validates against TurnResultSchema', async () => {
    const { code, stdout, stderr } = await runTurnCli('{"space":"s","prompt":"Hello"}')
    expect(code).toBe(0)
    expect(stderr).toBe('')
    const result = JSON.parse(stdout) as {
      trace: Array<{ kind: string; selected?: { type: string } }>
    }
    // trace is always present (kernel always returns it, possibly empty)
    expect(Array.isArray(result.trace)).toBe(true)
    expect(result.trace.length).toBeGreaterThan(0)
    // The trace contains at least one selection event (the ingress user.prompt)
    const selectionKinds = result.trace.map((t) => t.kind)
    expect(selectionKinds).toContain(TRACE_MESSAGE_KINDS.selection)
    // The output validates against the kernel's TurnResultSchema (single source)
    const validate = TurnResultSchema.validate
    expect(validate(result)).toBe(true)
  })

  test('end-to-end determinism — two runs produce byte-identical JSON out', async () => {
    const a = await runTurnCli('{"space":"s","prompt":"Hello"}')
    const b = await runTurnCli('{"space":"s","prompt":"Hello"}')
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    // The trace carries per-run timestamps/instanceId — compare the
    // deterministic trajectory fields, not the raw exhaust.
    const { trace: _ta, ...aRest } = JSON.parse(a.stdout)
    const { trace: _tb, ...bRest } = JSON.parse(b.stdout)
    expect(Bun.deepEquals(aRest, bRest)).toBe(true)
    // The trace shape (kinds + steps) is still structurally identical.
    const aKinds = _ta.map((t: { kind: string }) => t.kind)
    const bKinds = _tb.map((t: { kind: string }) => t.kind)
    expect(aKinds).toEqual(bKinds)
  })

  test('different prompts produce different user-message items', async () => {
    const a = await runTurnCli('{"space":"s","prompt":"first"}')
    const b = await runTurnCli('{"space":"s","prompt":"second"}')
    expect(a.stdout).not.toBe(b.stdout)
    expect(JSON.parse(a.stdout).items[0]).toMatchObject({ role: 'user', content: 'first' })
    expect(JSON.parse(b.stdout).items[0]).toMatchObject({ role: 'user', content: 'second' })
  })

  test('--help exits 0 and shows the usage surface', async () => {
    const { code, stderr } = await runTurnCli('--help')
    expect(code).toBe(0)
    expect(stderr).toContain('Usage: turn')
    expect(stderr).toContain('--schema')
    expect(stderr).toContain('--dry-run')
  })

  test('--schema input emits the input JSON schema and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts', 'turn', '--schema', 'input'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    const [out, , c] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(c).toBe(0)
    const schema = JSON.parse(out)
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('space')
    expect(schema.properties).toHaveProperty('prompt')
  })

  test('--schema output emits the output JSON schema and exits 0', async () => {
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts', 'turn', '--schema', 'output'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    const [out, , c] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(c).toBe(0)
    const schema = JSON.parse(out)
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('items')
    expect(schema.properties).toHaveProperty('iterations')
  })

  test('exits 2 on invalid JSON input', async () => {
    const { code } = await runTurnCli('not-json')
    expect(code).toBe(2)
  })

  test('exits 2 on a AJV validation failure (missing prompt)', async () => {
    const { code } = await runTurnCli('{"space":"s"}')
    expect(code).toBe(2)
  })

  test('--dry-run shows the request without running the turn', async () => {
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts', 'turn', '{"space":"s","prompt":"hi"}', '--dry-run'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    const [out, , c] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(c).toBe(0)
    const result = JSON.parse(out)
    expect(result.command).toBe('turn')
    expect(result.input).toEqual({ space: 's', prompt: 'hi' })
    expect(result.dryRun).toBe(true)
  })

  test('the turn command is registered in the router --schema listing', async () => {
    const proc = Bun.spawn(['bun', 'bin/behavioral.ts', '--schema'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    const [out, , c] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(c).toBe(0)
    const listing = JSON.parse(out) as { commands: string[] }
    expect(listing.commands).toContain('turn')
  })
})

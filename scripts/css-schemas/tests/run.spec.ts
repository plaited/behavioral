/**
 * @module run.spec
 *
 * Subprocess tests for `scripts/css-schemas/run.ts`.
 * Exercises the standalone script boundary — missing args, dry-run mode,
 * and diff mode.
 */

import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'

const scriptPath = path.resolve(import.meta.dir, '../run.ts')
const repoRoot = path.resolve(import.meta.dir, '../../..')

describe('css-schemas run script', () => {
  test('no args exits with error and prints usage', async () => {
    const proc = Bun.spawn(['bun', scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    expect(await proc.exited).toBe(1)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain('generate')
  })

  test('invalid mode exits with error', async () => {
    const proc = Bun.spawn(['bun', scriptPath, 'nope'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    expect(await proc.exited).toBe(1)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain('generate')
  })

  test('diff mode is byte-stable against the committed schema (the drift contract)', async () => {
    const proc = Bun.spawn(['bun', scriptPath, 'diff'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    expect(await proc.exited).toBe(0)
    const output = JSON.parse(await new Response(proc.stdout).text())
    expect(output.changed).toBe(false)
    expect(output.diff).toBeUndefined()
  }, 60000)

  test('generate --dry-run outputs JSON with dryRun', async () => {
    const proc = Bun.spawn(['bun', scriptPath, 'generate', '--dry-run'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    expect(await proc.exited).toBe(0)
    const output = JSON.parse(await new Response(proc.stdout).text())
    expect(output.dryRun).toBe(true)
    expect(typeof output.propertyCount).toBe('number')
    expect(output.propertyCount).toBeGreaterThan(0)
    expect(typeof output.keywordEnumCount).toBe('number')
    expect(output.path).toBe('src/controller/css.schemas.ts')
  })
})

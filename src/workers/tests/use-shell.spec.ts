/**
 * Shell tool tests — the §5 model-facing surface over the executor.
 *
 * @remarks
 * The tool schema is the trust boundary: it is the only place model-supplied
 * input is validated, and the only surface the model sees (no `timeoutMs`,
 * `maxLines`, `maxCharacters`, `cwd`, `env`, or `stdin` — those are host-only).
 *
 * @packageDocumentation
 */

import { describe, expect, test } from 'bun:test'
import { ajv } from '../../tools/use-tool.ts'
import { createShellExecutor, createShellTool, ShellToolInputSchema, ShellToolOutputSchema } from '../use-shell.ts'

const validateInput = ajv.compile(ShellToolInputSchema)
const validateOutput = ajv.compile(ShellToolOutputSchema)

describe('shell tool — schema contract', () => {
  test('accepts script alone and the §5 defaults', () => {
    expect(validateInput({ script: 'ls' })).toBe(true)
    expect(validateInput({ script: 'ls', format: 'paged', offset: 0, limit: 50 })).toBe(true)
  })

  test('rejects out-of-contract input at the trust boundary', () => {
    expect(validateInput({})).toBe(false) // missing script
    expect(validateInput({ script: 'ls', format: 'yaml' })).toBe(false) // unknown format
    expect(validateInput({ script: 'ls', offset: -1 })).toBe(false) // negative offset
    expect(validateInput({ script: 'ls', limit: 1001 })).toBe(false) // over the limit ceiling
    expect(validateInput({ script: 'ls', timeoutMs: 999_999 })).toBe(false) // host-only knob
    expect(validateInput({ script: 'ls', maxLines: 10_000 })).toBe(false) // host-only knob
  })
})

describe('shell tool — call-through', () => {
  test('runs a script through the executor and the result satisfies the output schema', async () => {
    const executor = createShellExecutor()
    try {
      const shell = createShellTool(executor)

      expect(shell.name).toBe('execute_shell')

      const result = await shell({ script: 'seq 1 3' })
      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['1', '2', '3'])
      expect(validateOutput(result)).toBe(true)
    } finally {
      executor.destroy()
    }
  })

  test('a json run also satisfies the output schema', async () => {
    const executor = createShellExecutor()
    try {
      const shell = createShellTool(executor)

      const result = await shell({ script: `echo '{"ok":true}'`, format: 'json' })
      expect(result.status).toBe('completed')
      expect(result.jsonData).toEqual({ ok: true })
      expect(validateOutput(result)).toBe(true)
    } finally {
      executor.destroy()
    }
  })
})

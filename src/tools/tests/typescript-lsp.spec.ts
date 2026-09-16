import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TypeScriptLspOutput, typescriptLsp } from '../typescript-lsp.ts'
import { ajv } from '../use-tool.ts'

/** Branch-assert then narrow — same pattern as plugin-loader.spec.ts. */
const ofMode = <M extends TypeScriptLspOutput['mode']>(
  output: TypeScriptLspOutput,
  expected: M,
): Extract<TypeScriptLspOutput, { mode: M }> => {
  if (output.mode !== expected) {
    throw new Error(`expected mode '${expected}', got '${output.mode}'`)
  }
  return output as Extract<TypeScriptLspOutput, { mode: M }>
}

const createTempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'behavioral-lsp-'))

describe('typescriptLsp', () => {
  test('tool contract: kebab name and a description covering both modes', () => {
    expect(typescriptLsp.name).toBe('typescript-lsp')
    const description = typescriptLsp.description.toLowerCase()
    expect(description).toContain('execute')
    expect(description).toContain('discover')
    expect(description).toContain('requests')
  })

  test('input schema is a oneOf across execute and discover with declared rootDir default', () => {
    const schema = typescriptLsp.inputSchema as {
      oneOf?: Array<{ properties?: Record<string, { default?: unknown }> }>
    }
    expect(schema.oneOf).toHaveLength(2)
    const executeBranch = schema.oneOf?.find((branch) => Object.hasOwn(branch.properties ?? {}, 'requests'))
    expect(executeBranch).toBeDefined()
    expect(executeBranch?.properties?.rootDir?.default).toBe('.')
    const discoverBranch = schema.oneOf?.find((branch) => !Object.hasOwn(branch.properties ?? {}, 'requests'))
    expect(discoverBranch?.properties?.rootDir?.default).toBe('.')
  })

  test('input schema rejects execute without requests', () => {
    const validate = ajv.compile(typescriptLsp.inputSchema)
    expect(validate({ mode: 'execute', file: 'sample.ts', requests: [] })).toBeFalse()
    expect(validate({ mode: 'execute', file: 'sample.ts' })).toBeFalse()
  })

  test('output schema is a oneOf across execute and discover outputs', () => {
    const schema = typescriptLsp.outputSchema as { oneOf?: unknown[] }
    expect(schema.oneOf).toHaveLength(2)
  })

  // Liveness: spawns the real TypeScript 7 native server against the
  // installed 7.0.2 — pins the unstable/async API surface this tool relies on.
  test('mode=execute returns document symbols for a simple file', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'sample.ts')
    await writeFile(filePath, 'export const x = 1\n')

    const output = ofMode(
      await typescriptLsp({
        mode: 'execute',
        rootDir: dir,
        file: filePath,
        requests: [
          {
            method: 'textDocument/documentSymbol',
            params: { textDocument: { uri: `file://${filePath}` } },
          },
        ],
      }),
      'execute',
    )

    expect(output.file).toBe('sample.ts')
    expect(output.results).toHaveLength(1)
    expect(output.results[0]?.method).toBe('textDocument/documentSymbol')
    expect(output.results[0]?.result).toBeDefined()

    await rm(dir, { recursive: true, force: true })
  }, 20_000)

  test('mode=execute reports per-request errors for unsupported methods', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'sample.ts')
    await writeFile(filePath, 'export const x = 1\n')

    const output = ofMode(
      await typescriptLsp({
        mode: 'execute',
        rootDir: dir,
        file: filePath,
        requests: [{ method: 'textDocument/formatting' }],
      }),
      'execute',
    )

    expect(output.results).toHaveLength(1)
    expect(output.results[0]?.error).toContain('Unsupported method')

    await rm(dir, { recursive: true, force: true })
  }, 20_000)

  test('mode=discover lists supported LSP methods', async () => {
    const output = ofMode(await typescriptLsp({ mode: 'discover' }), 'discover')

    expect(output.capabilities.length).toBeGreaterThan(0)
    expect(output.capabilities[0]?.method).toBeString()
    expect(output.capabilities[0]?.capability).toBeString()
  })
})

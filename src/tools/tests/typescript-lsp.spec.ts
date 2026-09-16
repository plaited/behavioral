import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { typescriptLspDiscover, typescriptLspExecute } from '../typescript-lsp.ts'
import { ajv } from '../use-tool.ts'

const createTempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'behavioral-lsp-'))

const propertyOf = (tool: { inputSchema: object }, name: string) =>
  (tool.inputSchema as { properties?: Record<string, unknown> }).properties?.[name]

describe('typescriptLspExecute', () => {
  test('tool contract: kebab name and an execute-flavored description', () => {
    expect(typescriptLspExecute.name).toBe('typescript-execute')
    expect(typescriptLspExecute.description.toLowerCase()).toContain('documentsymbol')
  })

  test('input schema requires file and non-empty requests', () => {
    const validate = ajv.compile(typescriptLspExecute.inputSchema)
    expect(validate({})).toBeFalse()
    expect(validate({ file: 'sample.ts', requests: [] })).toBeFalse()
    expect(propertyOf(typescriptLspExecute, 'rootDir')).toMatchObject({ default: '.' })
  })

  // Liveness: spawns the real TypeScript 7 native server against the
  // installed 7.0.2 — pins the unstable/async API surface this tool relies on.
  test('returns document symbols for a simple file', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'sample.ts')
    await writeFile(filePath, 'export const x = 1\n')

    const output = await typescriptLspExecute({
      rootDir: dir,
      file: filePath,
      requests: [
        {
          method: 'textDocument/documentSymbol',
          params: { textDocument: { uri: `file://${filePath}` } },
        },
      ],
    })

    expect(output.file).toBe('sample.ts')
    expect(output.results).toHaveLength(1)
    expect(output.results[0]?.method).toBe('textDocument/documentSymbol')
    expect(output.results[0]?.result).toBeDefined()

    await rm(dir, { recursive: true, force: true })
  }, 20_000)

  test('reports per-request errors for unsupported methods', async () => {
    const dir = await createTempDir()
    const filePath = join(dir, 'sample.ts')
    await writeFile(filePath, 'export const x = 1\n')

    const output = await typescriptLspExecute({
      rootDir: dir,
      file: filePath,
      requests: [{ method: 'textDocument/formatting' }],
    })

    expect(output.results).toHaveLength(1)
    expect(output.results[0]?.error).toContain('Unsupported method')

    await rm(dir, { recursive: true, force: true })
  }, 20_000)
})

describe('typescriptLspDiscover', () => {
  test('tool contract: kebab name and a discover-flavored description', () => {
    expect(typescriptLspDiscover.name).toBe('typescript-discover')
    expect(typescriptLspDiscover.description.toLowerCase()).toContain('capabilit')
  })

  test('input schema is rootDir-only with declared default', () => {
    const validate = ajv.compile(typescriptLspDiscover.inputSchema)
    expect(validate({})).toBeTrue()
    expect(propertyOf(typescriptLspDiscover, 'rootDir')).toMatchObject({ default: '.' })
  })

  test('lists supported LSP methods', async () => {
    const output = await typescriptLspDiscover({})

    expect(output.capabilities.length).toBeGreaterThan(0)
    expect(output.capabilities[0]?.method).toBeString()
    expect(output.capabilities[0]?.capability).toBeString()
  })
})

import { describe, expect, test } from 'bun:test'
import {
  DiscoveryCreateInputSchema,
  DiscoveryCreateOutputSchema,
  DiscoveryDeleteInputSchema,
  DiscoveryDeleteOutputSchema,
  DiscoveryReadInputSchema,
  DiscoveryReadOutputSchema,
  DiscoverySearchInputSchema,
  DiscoverySearchOutputSchema,
  DiscoveryUpdateInputSchema,
  DiscoveryUpdateOutputSchema,
  discoveryCreate,
  discoveryDelete,
  discoveryRead,
  discoverySearch,
  discoveryUpdate,
} from '../discovery.ts'
import { ajv } from '../use-tool.ts'

const validateCreateInput = ajv.compile(DiscoveryCreateInputSchema)
const validateCreateOutput = ajv.compile(DiscoveryCreateOutputSchema)
const validateReadInput = ajv.compile(DiscoveryReadInputSchema)
const validateReadOutput = ajv.compile(DiscoveryReadOutputSchema)
const validateUpdateInput = ajv.compile(DiscoveryUpdateInputSchema)
const validateUpdateOutput = ajv.compile(DiscoveryUpdateOutputSchema)
const validateDeleteInput = ajv.compile(DiscoveryDeleteInputSchema)
const validateDeleteOutput = ajv.compile(DiscoveryDeleteOutputSchema)
const validateSearchInput = ajv.compile(DiscoverySearchInputSchema)
const validateSearchOutput = ajv.compile(DiscoverySearchOutputSchema)

// Each test gets a fresh temp cwd; the store resolves to
// <cwd>/.behavioral/discovery.sqlite.
const tempCwd = async (): Promise<{ cwd: string; cleanup: () => Promise<void> }> => {
  const dir = (await Bun.$`mktemp -d`.quiet().text()).trim()
  return {
    cwd: dir,
    cleanup: async () => {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    },
  }
}

describe('discovery tools — schema contract (RED)', () => {
  test('each tool names itself distinctly', () => {
    expect(discoveryCreate.name).toBe('discovery-create')
    expect(discoveryRead.name).toBe('discovery-read')
    expect(discoveryUpdate.name).toBe('discovery-update')
    expect(discoveryDelete.name).toBe('discovery-delete')
    expect(discoverySearch.name).toBe('discovery-search')
  })

  test('every tool requires cwd — the store path derives from it', () => {
    expect(validateCreateInput({ kind: 'mcp-tool', name: 'n', description: 'd', handle: 'h' })).toBe(false)
    expect(validateReadInput({ id: 'x' })).toBe(false)
    expect(validateUpdateInput({ id: 'x' })).toBe(false)
    expect(validateDeleteInput({ id: 'x' })).toBe(false)
    expect(validateSearchInput({ query: 'x' })).toBe(false)
  })

  test('create requires kind, name, description, handle', () => {
    expect(validateCreateInput({ cwd: '/p', kind: 'mcp-tool', name: 'n' })).toBe(false)
    expect(validateCreateInput({ cwd: '/p', kind: 'mcp-tool', name: 'n', description: 'd', handle: 'h' })).toBe(true)
  })

  test('create rejects an invalid kind', () => {
    expect(validateCreateInput({ cwd: '/p', kind: 'nope', name: 'n', description: 'd', handle: 'h' })).toBe(false)
  })

  test('read/update/delete require id', () => {
    expect(validateReadInput({ cwd: '/p' })).toBe(false)
    expect(validateReadInput({ cwd: '/p', id: 'x' })).toBe(true)
    expect(validateUpdateInput({ cwd: '/p' })).toBe(false)
    expect(validateUpdateInput({ cwd: '/p', id: 'x', description: 'd' })).toBe(true)
    expect(validateDeleteInput({ cwd: '/p' })).toBe(false)
    expect(validateDeleteInput({ cwd: '/p', id: 'x' })).toBe(true)
  })

  test('search requires query', () => {
    expect(validateSearchInput({ cwd: '/p' })).toBe(false)
    expect(validateSearchInput({ cwd: '/p', query: 'term' })).toBe(true)
    expect(validateSearchInput({ cwd: '/p', query: 'term', kind: 'skill', limit: 5 })).toBe(true)
    expect(validateSearchInput({ cwd: '/p', query: 'term', kind: 'nope' })).toBe(false)
  })

  test('a model-supplied dbPath is rejected — the store path derives from cwd', () => {
    // dbPath is NOT in any schema. A model attempting to choose the store
    // path is rejected at the boundary (additionalProperties: false).
    expect(
      validateCreateInput({
        cwd: '/p',
        kind: 'mcp-tool',
        name: 'n',
        description: 'd',
        handle: 'h',
        dbPath: '/etc/passwd',
      }),
    ).toBe(false)
    expect(validateSearchInput({ cwd: '/p', query: 'x', dbPath: '/tmp/evil.sqlite' })).toBe(false)
  })

  test('a stray mode discriminator is rejected — modes are separate tools now', () => {
    expect(validateSearchInput({ cwd: '/p', mode: 'search', query: 'x' })).toBe(false)
    expect(
      validateCreateInput({ cwd: '/p', mode: 'create', kind: 'mcp-tool', name: 'n', description: 'd', handle: 'h' }),
    ).toBe(false)
  })
})

describe('discovery tools — CRUD round-trip through <cwd>/.behavioral/discovery.sqlite', () => {
  test('create → read → update → delete an mcp-tool row', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      const created = (await discoveryCreate({
        cwd,
        kind: 'mcp-tool',
        name: 'you-docs',
        description: 'Search the MCP docs.',
        handle: 'https://api.example.com/mcp',
        metadata: { inputSchema: { type: 'object' } },
      })) as { row: { id: string; kind: string; name: string; metadata: unknown } }
      expect(validateCreateOutput(created)).toBe(true)
      const id = created.row.id
      expect(created.row.kind).toBe('mcp-tool')
      expect(created.row.name).toBe('you-docs')
      expect(created.row.metadata).toEqual({ inputSchema: { type: 'object' } })

      const read = (await discoveryRead({ cwd, id })) as { row: { name: string } | null }
      expect(validateReadOutput(read)).toBe(true)
      expect(read.row?.name).toBe('you-docs')

      const updated = (await discoveryUpdate({
        cwd,
        id,
        description: 'Search the MCP docs, updated.',
      })) as { row: { description: string } | null }
      expect(validateUpdateOutput(updated)).toBe(true)
      expect(updated.row?.description).toBe('Search the MCP docs, updated.')

      const deleted = (await discoveryDelete({ cwd, id })) as { deleted: boolean }
      expect(validateDeleteOutput(deleted)).toBe(true)
      expect(deleted.deleted).toBe(true)

      const afterDelete = (await discoveryRead({ cwd, id })) as { row: null }
      expect(afterDelete.row).toBeNull()
    } finally {
      await cleanup()
    }
  })

  test('a skill row stores frontmatter as metadata', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      const created = (await discoveryCreate({
        cwd,
        kind: 'skill',
        name: 'echo',
        description: 'Echo skill.',
        handle: '/path/to/SKILL.md',
        metadata: { license: 'ISC', 'allowed-tools': 'Bash' },
      })) as { row: { kind: string; metadata: unknown } }
      expect(created.row.kind).toBe('skill')
      expect(created.row.metadata).toEqual({ license: 'ISC', 'allowed-tools': 'Bash' })
    } finally {
      await cleanup()
    }
  })

  test('read of a missing id returns row null', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      const read = (await discoveryRead({ cwd, id: 'nonexistent' })) as { row: null }
      expect(validateReadOutput(read)).toBe(true)
      expect(read.row).toBeNull()
    } finally {
      await cleanup()
    }
  })

  test('update of a missing id returns row null with isError', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      const updated = (await discoveryUpdate({ cwd, id: 'nonexistent', description: 'x' })) as {
        row: null
        isError?: boolean
      }
      expect(updated.row).toBeNull()
      expect(updated.isError).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test('delete of a missing id returns deleted false', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      const deleted = (await discoveryDelete({ cwd, id: 'nonexistent' })) as { deleted: boolean }
      expect(deleted.deleted).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test('updating a name and handle persists', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      const created = (await discoveryCreate({
        cwd,
        kind: 'mcp-tool',
        name: 'old',
        description: 'd',
        handle: 'h1',
      })) as { row: { id: string } }
      const updated = (await discoveryUpdate({
        cwd,
        id: created.row.id,
        name: 'new',
        handle: 'h2',
      })) as { row: { name: string; handle: string } }
      expect(updated.row.name).toBe('new')
      expect(updated.row.handle).toBe('h2')
    } finally {
      await cleanup()
    }
  })
})

describe('discovery tools — search across both kinds', () => {
  test('matches by name and description substring, case-insensitive', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      await discoveryCreate({ cwd, kind: 'mcp-tool', name: 'weather', description: 'Get forecasts.', handle: 'u1' })
      await discoveryCreate({ cwd, kind: 'skill', name: 'code-review', description: 'Review code.', handle: 'p1' })
      await discoveryCreate({ cwd, kind: 'mcp-tool', name: 'search', description: 'Web search tool.', handle: 'u2' })

      const byName = (await discoverySearch({ cwd, query: 'weath' })) as { rows: { name: string }[] }
      expect(byName.rows.map((r) => r.name)).toEqual(['weather'])

      const byDesc = (await discoverySearch({ cwd, query: 'code' })) as { rows: { name: string }[] }
      expect(byDesc.rows.map((r) => r.name)).toEqual(['code-review'])

      const caseInsensitive = (await discoverySearch({ cwd, query: 'REVIEW' })) as { rows: { name: string }[] }
      expect(caseInsensitive.rows.map((r) => r.name)).toEqual(['code-review'])
    } finally {
      await cleanup()
    }
  })

  test('kind filter restricts results to one kind', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      await discoveryCreate({ cwd, kind: 'mcp-tool', name: 'search', description: 'find', handle: 'u1' })
      await discoveryCreate({ cwd, kind: 'skill', name: 'search-skill', description: 'find', handle: 'p1' })

      const toolsOnly = (await discoverySearch({ cwd, query: 'search', kind: 'mcp-tool' })) as {
        rows: { kind: string }[]
      }
      expect(toolsOnly.rows).toHaveLength(1)
      expect(toolsOnly.rows[0]!.kind).toBe('mcp-tool')

      const skillsOnly = (await discoverySearch({ cwd, query: 'search', kind: 'skill' })) as {
        rows: { kind: string }[]
      }
      expect(skillsOnly.rows).toHaveLength(1)
      expect(skillsOnly.rows[0]!.kind).toBe('skill')
    } finally {
      await cleanup()
    }
  })

  test('no match returns an empty rows array', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      const result = (await discoverySearch({ cwd, query: 'zzz' })) as { rows: unknown[] }
      expect(validateSearchOutput(result)).toBe(true)
      expect(result.rows).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test('limit caps the result count', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      for (let i = 0; i < 5; i++) {
        await discoveryCreate({ cwd, kind: 'mcp-tool', name: `match-${i}`, description: 'common', handle: `u${i}` })
      }
      const result = (await discoverySearch({ cwd, query: 'common', limit: 2 })) as { rows: unknown[] }
      expect(result.rows).toHaveLength(2)
    } finally {
      await cleanup()
    }
  })

  test('an empty query matches all rows (tier-1 catalog)', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      await discoveryCreate({ cwd, kind: 'mcp-tool', name: 'a', description: 'd', handle: 'u1' })
      await discoveryCreate({ cwd, kind: 'skill', name: 'b', description: 'd', handle: 'p1' })
      const result = (await discoverySearch({ cwd, query: '' })) as { rows: { name: string }[] }
      expect(result.rows.map((r) => r.name).sort()).toEqual(['a', 'b'])
    } finally {
      await cleanup()
    }
  })

  test('rows persist across separate calls (each call reopens the store)', async () => {
    const { cwd, cleanup } = await tempCwd()
    try {
      await discoveryCreate({ cwd, kind: 'skill', name: 'persisted', description: 'd', handle: 'p' })
      const result = (await discoverySearch({ cwd, query: 'persisted' })) as { rows: { name: string }[] }
      expect(result.rows.map((r) => r.name)).toEqual(['persisted'])
    } finally {
      await cleanup()
    }
  })
})

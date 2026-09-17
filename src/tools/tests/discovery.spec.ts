import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import {
  DISCOVERY_PLUGIN_SOURCE,
  DiscoveryCreateInputSchema,
  DiscoveryCreateOutputSchema,
  DiscoveryDeleteInputSchema,
  DiscoveryDeleteOutputSchema,
  type DiscoveryKind,
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
  provisionDiscoverySpace,
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

// ---------------------------------------------------------------------------
// Test harness — override HOME so the store lands in a temp ~/.behavioral,
// and reset the provisioned space identity around each test.
// ---------------------------------------------------------------------------

let tempHome: string | null = null

const setHome = async (): Promise<string> => {
  const dir = (await Bun.$`mktemp -d`.quiet().text()).trim()
  tempHome = dir
  Bun.env.HOME = dir
  return dir
}

afterEach(async () => {
  provisionDiscoverySpace('root')
  if (tempHome) {
    await Bun.$`rm -rf ${tempHome}`.quiet().nothrow()
    tempHome = null
  }
})

describe('discovery tools — schema contract', () => {
  test('each tool names itself distinctly', () => {
    expect(discoveryCreate.name).toBe('discovery-create')
    expect(discoveryRead.name).toBe('discovery-read')
    expect(discoveryUpdate.name).toBe('discovery-update')
    expect(discoveryDelete.name).toBe('discovery-delete')
    expect(discoverySearch.name).toBe('discovery-search')
  })

  test('no location input at all — dbPath and cwd are absent from every schema', () => {
    // The store lives at ~/.behavioral/db.sqlite; its path derives from the
    // home root, never from agent input.
    expect(validateCreateInput({ kind: 'mcp-tool', name: 'n', description: 'd', handle: 'h' })).toBe(true)
    expect(validateReadInput({ id: 'x' })).toBe(true)
    expect(validateUpdateInput({ id: 'x', description: 'd' })).toBe(true)
    expect(validateDeleteInput({ id: 'x' })).toBe(true)
    expect(validateSearchInput({ query: 'x' })).toBe(true)

    expect(validateCreateInput({ kind: 'mcp-tool', name: 'n', description: 'd', handle: 'h', cwd: '/p' })).toBe(false)
    expect(validateReadInput({ id: 'x', cwd: '/p' })).toBe(false)
  })

  test('a fabricated cross-space query fails at the schema boundary', () => {
    // Space identity is provisioner-injected, never agent-supplied — there is
    // no `space` field in the agent-facing input schemas to fabricate.
    expect(
      validateCreateInput({ kind: 'thread', name: 'n', description: 'd', handle: 'h', space: 'other-space' }),
    ).toBe(false)
    expect(validateSearchInput({ query: 'x', space: 'other-space' })).toBe(false)
    expect(validateReadInput({ id: 'x', space: 'other-space' })).toBe(false)
  })

  test('kinds: mcp-tool, skill, thread, html', () => {
    const kinds: DiscoveryKind[] = ['mcp-tool', 'skill', 'thread', 'html']
    for (const kind of kinds) {
      expect(validateCreateInput({ kind, name: 'n', description: 'd', handle: 'h' })).toBe(true)
    }
    expect(validateCreateInput({ kind: 'nope', name: 'n', description: 'd', handle: 'h' })).toBe(false)
  })

  test('create requires kind, name, description, handle', () => {
    expect(validateCreateInput({ kind: 'mcp-tool', name: 'n' })).toBe(false)
    expect(validateCreateInput({ kind: 'mcp-tool', name: 'n', description: 'd', handle: 'h' })).toBe(true)
  })

  test('a model-supplied dbPath is rejected', () => {
    expect(validateCreateInput({ kind: 'mcp-tool', name: 'n', description: 'd', handle: 'h', dbPath: '/x' })).toBe(
      false,
    )
    expect(validateSearchInput({ query: 'x', dbPath: '/tmp/evil.sqlite' })).toBe(false)
  })

  test('a stray mode discriminator is rejected — modes are separate tools', () => {
    expect(validateSearchInput({ mode: 'search', query: 'x' })).toBe(false)
    expect(validateCreateInput({ mode: 'create', kind: 'mcp-tool', name: 'n', description: 'd', handle: 'h' })).toBe(
      false,
    )
  })
})

describe('discovery tools — store at ~/.behavioral/db.sqlite', () => {
  test('rows land in the home-root store in WAL mode', async () => {
    const home = await setHome()
    const created = (await discoveryCreate({
      kind: 'thread',
      name: 'governor',
      description: 'Blocks discovery writes outside the scan',
      handle: '/behavioral/root/threads/governor.ts',
    })) as { row: { id: string; kind: string; space: string } }
    expect(validateCreateOutput(created)).toBe(true)

    const db = new Database(path.join(home, '.behavioral', 'db.sqlite'), { readonly: true })
    try {
      const mode = db.query('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(mode.journal_mode).toBe('wal')
      const count = db.query('SELECT COUNT(*) AS n FROM discovery').get() as { n: number }
      expect(count.n).toBe(1)
    } finally {
      db.close()
    }
  })
})

describe('discovery tools — CRUD round-trip through ~/.behavioral/db.sqlite', () => {
  test('create → read → update → delete an mcp-tool row', async () => {
    await setHome()
    const created = (await discoveryCreate({
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

    const read = (await discoveryRead({ id })) as { row: { name: string } | null }
    expect(validateReadOutput(read)).toBe(true)
    expect(read.row?.name).toBe('you-docs')

    const updated = (await discoveryUpdate({ id, description: 'Search the MCP docs, updated.' })) as {
      row: { description: string } | null
    }
    expect(validateUpdateOutput(updated)).toBe(true)
    expect(updated.row?.description).toBe('Search the MCP docs, updated.')

    const deleted = (await discoveryDelete({ id })) as { deleted: boolean }
    expect(validateDeleteOutput(deleted)).toBe(true)
    expect(deleted.deleted).toBe(true)

    const afterDelete = (await discoveryRead({ id })) as { row: null }
    expect(afterDelete.row).toBeNull()
  })

  test('a skill row stores frontmatter as metadata', async () => {
    await setHome()
    const created = (await discoveryCreate({
      kind: 'skill',
      name: 'echo',
      description: 'Echo skill.',
      handle: '/path/to/SKILL.md',
      metadata: { license: 'ISC', 'allowed-tools': 'Bash' },
    })) as { row: { kind: string; metadata: unknown } }
    expect(created.row.kind).toBe('skill')
    expect(created.row.metadata).toEqual({ license: 'ISC', 'allowed-tools': 'Bash' })
  })

  test('plugin-shipped components carry the source: plugin metadata marker', async () => {
    await setHome()
    const created = (await discoveryCreate({
      kind: 'skill',
      name: 'plugin-skill',
      description: 'Shipped by an installed plugin.',
      handle: '/plugins/behavioral/skills/behavioral/SKILL.md',
      metadata: { source: DISCOVERY_PLUGIN_SOURCE } as Record<string, unknown>,
    })) as { row: { metadata: Record<string, unknown> } }
    expect(created.row.metadata['source']).toBe('plugin')
  })

  test('read of a missing id returns row null', async () => {
    await setHome()
    const read = (await discoveryRead({ id: 'nonexistent' })) as { row: null }
    expect(validateReadOutput(read)).toBe(true)
    expect(read.row).toBeNull()
  })

  test('update of a missing id returns row null with isError', async () => {
    await setHome()
    const updated = (await discoveryUpdate({ id: 'nonexistent', description: 'x' })) as {
      row: null
      isError?: boolean
    }
    expect(updated.row).toBeNull()
    expect(updated.isError).toBe(true)
  })

  test('delete of a missing id returns deleted false', async () => {
    await setHome()
    const deleted = (await discoveryDelete({ id: 'nonexistent' })) as { deleted: boolean }
    expect(deleted.deleted).toBe(false)
  })

  test('updating a name and handle persists', async () => {
    await setHome()
    const created = (await discoveryCreate({
      kind: 'mcp-tool',
      name: 'old',
      description: 'd',
      handle: 'h1',
    })) as { row: { id: string } }
    const updated = (await discoveryUpdate({ id: created.row.id, name: 'new', handle: 'h2' })) as {
      row: { name: string; handle: string }
    }
    expect(updated.row.name).toBe('new')
    expect(updated.row.handle).toBe('h2')
  })
})

describe('discovery tools — search', () => {
  test('matches by name and description substring, case-insensitive', async () => {
    await setHome()
    await discoveryCreate({ kind: 'mcp-tool', name: 'weather', description: 'Get forecasts.', handle: 'u1' })
    await discoveryCreate({ kind: 'skill', name: 'code-review', description: 'Review code.', handle: 'p1' })
    await discoveryCreate({ kind: 'html', name: 'briefing', description: 'Review code context.', handle: 'h1' })

    const byName = (await discoverySearch({ query: 'weath' })) as { rows: { name: string }[] }
    expect(byName.rows.map((r) => r.name)).toEqual(['weather'])

    const byDesc = (await discoverySearch({ query: 'code' })) as { rows: { name: string }[] }
    expect(byDesc.rows.map((r) => r.name).sort()).toEqual(['briefing', 'code-review'])

    const caseInsensitive = (await discoverySearch({ query: 'REVIEW' })) as { rows: { name: string }[] }
    expect(caseInsensitive.rows).toHaveLength(2)
  })

  test('kind filter restricts results to one kind', async () => {
    await setHome()
    await discoveryCreate({ kind: 'thread', name: 'search', description: 'find', handle: 't1' })
    await discoveryCreate({ kind: 'skill', name: 'search-skill', description: 'find', handle: 'p1' })

    const threadsOnly = (await discoverySearch({ query: 'search', kind: 'thread' })) as {
      rows: { kind: string }[]
    }
    expect(threadsOnly.rows).toHaveLength(1)
    expect(threadsOnly.rows[0]!.kind).toBe('thread')

    const htmlOnly = (await discoverySearch({ query: 'search', kind: 'html' })) as { rows: unknown[] }
    expect(htmlOnly.rows).toEqual([])
  })

  test('no match returns an empty rows array; limit caps; empty query matches all', async () => {
    await setHome()
    const none = (await discoverySearch({ query: 'zzz' })) as { rows: unknown[] }
    expect(validateSearchOutput(none)).toBe(true)
    expect(none.rows).toEqual([])

    for (let i = 0; i < 5; i++) {
      await discoveryCreate({ kind: 'mcp-tool', name: `match-${i}`, description: 'common', handle: `u${i}` })
    }
    const capped = (await discoverySearch({ query: 'common', limit: 2 })) as { rows: unknown[] }
    expect(capped.rows).toHaveLength(2)

    const all = (await discoverySearch({ query: '' })) as { rows: { name: string }[] }
    expect(all.rows).toHaveLength(5)
  })

  test('rows persist across separate calls (each call reopens the store)', async () => {
    await setHome()
    await discoveryCreate({ kind: 'skill', name: 'persisted', description: 'd', handle: 'p' })
    const result = (await discoverySearch({ query: 'persisted' })) as { rows: { name: string }[] }
    expect(result.rows.map((r) => r.name)).toEqual(['persisted'])
  })
})

describe('discovery tools — provisioner-side space scoping', () => {
  test('default identity is root — the unscoped identity sees every space', async () => {
    await setHome()
    provisionDiscoverySpace('project-a')
    await discoveryCreate({ kind: 'html', name: 'a-page', description: 'd', handle: 'h-a' })
    provisionDiscoverySpace('project-b')
    await discoveryCreate({ kind: 'html', name: 'b-page', description: 'd', handle: 'h-b' })
    provisionDiscoverySpace('root')
    const all = (await discoverySearch({ query: '' })) as { rows: { name: string; space: string }[] }
    expect(all.rows.map((r) => r.name).sort()).toEqual(['a-page', 'b-page'])
    expect(all.rows.map((r) => r.space).sort()).toEqual(['project-a', 'project-b'])
  })

  test('a provisioned space sees only its own rows; create stamps its space', async () => {
    await setHome()
    provisionDiscoverySpace('project-a')
    await discoveryCreate({ kind: 'thread', name: 'a-thread', description: 'd', handle: 't-a' })
    provisionDiscoverySpace('project-b')
    await discoveryCreate({ kind: 'thread', name: 'b-thread', description: 'd', handle: 't-b' })

    const seenFromB = (await discoverySearch({ query: '' })) as { rows: { name: string }[] }
    expect(seenFromB.rows.map((r) => r.name)).toEqual(['b-thread'])

    // a row from project-a is not addressable from project-b, even by id
    const rowsFromA = (await discoverySearch({ query: 'a-thread' })) as { rows: unknown[] }
    expect(rowsFromA.rows).toEqual([])
  })

  test('root rows are stamped space=root and visible from any provisioned space (unscoped root)', async () => {
    await setHome()
    await discoveryCreate({ kind: 'skill', name: 'root-skill', description: 'd', handle: 'p-root' })
    provisionDiscoverySpace('project-a')
    const seen = (await discoverySearch({ query: 'root-skill' })) as { rows: { space: string }[] }
    expect(seen.rows).toHaveLength(1)
    expect(seen.rows[0]!.space).toBe('root')
  })
})

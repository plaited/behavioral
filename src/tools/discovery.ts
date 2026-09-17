/**
 * Agent-facing discovery store — CRUD + search over a unified catalog of
 * MCP tools, skills, learned threads, and html artifacts.
 *
 * @remarks
 * Flat, standalone `useTool` units — one per operation: `discovery-create`,
 * `discovery-read`, `discovery-update`, `discovery-delete`, and
 * `discovery-search`. Import a tool and call it; no provisioning layer, no
 * shared connection. Each call opens the SQLite store, ensures the schema,
 * runs the operation, and closes.
 *
 * **Store location (growth-model amendment):** one `~/.behavioral/db.sqlite`
 * in WAL mode — every row carries `space`. The path derives from the home
 * root, never from agent input (`cwd`/`dbPath` are absent from every schema,
 * rejected by `additionalProperties: false`).
 *
 * **Provisioner-side space scoping:** space identity is provisioner-injected,
 * never agent-supplied — there is no `space` field in the agent-facing input
 * schemas, so a space agent cannot address another space's rows by
 * construction. {@link provisionDiscoverySpace} binds the identity at
 * provisioning; `root` is the unscoped identity (cross-space navigation).
 * The kernel calls it when it provisions a space; unscoped (root) is the
 * default.
 *
 * Unified rows: `kind ∈ {'mcp-tool','skill','thread','html'}`, plus `id`,
 * `space`, `name`, `description`, `handle` (server-url for mcp-tool, SKILL.md
 * path for skill, artifact path for thread/html), `metadata_json` (inputSchema
 * for mcp-tool, frontmatter for skill, BMeta-derived fields for thread/html),
 * `updated_at`. Plugin-shipped components are indexed by the reconcile scan
 * with the {@link DISCOVERY_PLUGIN_SOURCE} metadata marker.
 *
 * Not git-backed — local SQLite, regenerable (the reconcile scan is the sole
 * writer once it lands).
 *
 * MINIMAL: search is case-insensitive LIKE over name + description, not FTS5,
 * and each call opens/closes its own connection rather than sharing one.
 * Upgrade path: an FTS5 virtual table for ranking and prefix matching once the
 * catalog grows beyond LIKE's usefulness; a process-lifetime keyed connection
 * only if open cost ever shows up.
 *
 * @packageDocumentation
 */

import { Database } from 'bun:sqlite'
import * as path from 'node:path'
import type { JSONSchemaType } from 'ajv'
import { behavioralHomeRoot, DB_FILE, ROOT_SPACE } from '../kernel/behavioral-home.ts'
import { useTool } from './use-tool.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveryKind = 'mcp-tool' | 'skill' | 'thread' | 'html'

export type DiscoveryRow = {
  id: string
  kind: DiscoveryKind
  space: string
  name: string
  description: string
  handle: string
  metadata: Record<string, unknown> | null
  updated_at: number
}

export type DiscoveryCreateInput = {
  kind: DiscoveryKind
  name: string
  description: string
  handle: string
  metadata?: Record<string, unknown>
}
export type DiscoveryCreateOutput = { row: DiscoveryRow }

export type DiscoveryReadInput = { id: string }
export type DiscoveryReadOutput = { row: DiscoveryRow | null }

export type DiscoveryUpdateInput = {
  id: string
  name?: string
  description?: string
  handle?: string
  metadata?: Record<string, unknown>
}
export type DiscoveryUpdateOutput = { row: DiscoveryRow | null; isError?: boolean; message?: string }

export type DiscoveryDeleteInput = { id: string }
export type DiscoveryDeleteOutput = { deleted: boolean }

export type DiscoverySearchInput = { query: string; kind?: DiscoveryKind; limit?: number }
export type DiscoverySearchOutput = { rows: DiscoveryRow[] }

// ---------------------------------------------------------------------------
// Provisioner-side space identity — NOT agent-facing input.
// ---------------------------------------------------------------------------

let provisionedSpace: string = ROOT_SPACE

/**
 * Bind the provisioned space identity for subsequent discovery calls. Called
 * by the kernel at provisioning; the agent-facing input schemas carry no
 * `space` field, so a space agent cannot address another space's rows by
 * construction. `root` (the default) is the unscoped identity — it sees every
 * space's rows.
 */
export const provisionDiscoverySpace = (space: string): void => {
  provisionedSpace = space
}

/** The currently bound space identity (host-side introspection for the scan). */
export const discoverySpace = (): string => provisionedSpace

/** True when the bound identity is unscoped root. */
const isUnscoped = (): boolean => provisionedSpace === ROOT_SPACE

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Metadata marker the reconcile scan writes on plugin-shipped components. */
export const DISCOVERY_PLUGIN_SOURCE = 'plugin'

const DEFAULT_SEARCH_LIMIT = 100

const KINDS_SQL = "'mcp-tool','skill','thread','html'"

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS discovery (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN (${KINDS_SQL})),
  space TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  handle TEXT NOT NULL,
  metadata_json TEXT,
  updated_at INTEGER NOT NULL
)
`

// ---------------------------------------------------------------------------
// Tool JSON schemas — one schema pair per tool, no `mode` discriminator.
// No location input: the store path derives from the home root. No `space`
// input: the identity binds provisioner-side. Both are rejected by
// `additionalProperties: false` — a fabricated cross-space or store-path
// query fails at the schema boundary. Cast through `unknown` where the open
// row shape exceeds `JSONSchemaType`'s static power; AJV validates at runtime.
// ---------------------------------------------------------------------------

const kindJsonSchema = { type: 'string', enum: ['mcp-tool', 'skill', 'thread', 'html'] } as const
const metadataJsonSchema = {
  type: 'object',
  additionalProperties: true,
  nullable: true,
  description: 'metadata blob — inputSchema for mcp-tool, frontmatter for skill, BMeta fields for thread/html',
} as const

const discoveryRowJsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['mcp-tool', 'skill', 'thread', 'html'] },
    space: { type: 'string', description: 'the space the row belongs to (root is the unscoped identity)' },
    name: { type: 'string' },
    description: { type: 'string' },
    handle: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true, nullable: true },
    updated_at: { type: 'integer' },
  },
  required: ['id', 'kind', 'space', 'name', 'description', 'handle', 'updated_at'],
  additionalProperties: false,
} as const

export const DiscoveryCreateInputSchema = {
  type: 'object',
  properties: {
    kind: kindJsonSchema,
    name: { type: 'string', minLength: 1, description: 'tool, skill, thread, or artifact name' },
    description: { type: 'string', description: 'short description for tier-1 search' },
    handle: {
      type: 'string',
      minLength: 1,
      description: 'server-url for mcp-tool, SKILL.md path for skill, artifact path for thread/html',
    },
    metadata: metadataJsonSchema,
  },
  required: ['kind', 'name', 'description', 'handle'],
  additionalProperties: false,
  description: 'Create one discovery row in ~/.behavioral/db.sqlite, stamped with the provisioned space.',
} as unknown as JSONSchemaType<DiscoveryCreateInput>

export const DiscoveryCreateOutputSchema = {
  type: 'object',
  properties: { row: discoveryRowJsonSchema },
  required: ['row'],
  additionalProperties: false,
} as unknown as JSONSchemaType<DiscoveryCreateOutput>

export const DiscoveryReadInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, description: 'row id' },
  },
  required: ['id'],
  additionalProperties: false,
  description: 'Read one discovery row by id, scoped to the provisioned space.',
} as unknown as JSONSchemaType<DiscoveryReadInput>

export const DiscoveryReadOutputSchema = {
  type: 'object',
  properties: { row: { ...discoveryRowJsonSchema, nullable: true } },
  required: ['row'],
  additionalProperties: false,
} as unknown as JSONSchemaType<DiscoveryReadOutput>

export const DiscoveryUpdateInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, description: 'row id' },
    name: { type: 'string', nullable: true, description: 'new name' },
    description: { type: 'string', nullable: true, description: 'new description' },
    handle: { type: 'string', nullable: true, description: 'new handle' },
    metadata: metadataJsonSchema,
  },
  required: ['id'],
  additionalProperties: false,
  description: 'Update one discovery row; omitted fields are left unchanged.',
} as unknown as JSONSchemaType<DiscoveryUpdateInput>

export const DiscoveryUpdateOutputSchema = {
  type: 'object',
  properties: {
    row: { ...discoveryRowJsonSchema, nullable: true, description: 'the updated row; null on error' },
    isError: { type: 'boolean', nullable: true, description: 'true when no row with the given id exists' },
    message: { type: 'string', nullable: true, description: 'error detail when isError' },
  },
  required: ['row'],
  additionalProperties: false,
} as unknown as JSONSchemaType<DiscoveryUpdateOutput>

export const DiscoveryDeleteInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, description: 'row id' },
  },
  required: ['id'],
  additionalProperties: false,
  description: 'Delete one discovery row by id, scoped to the provisioned space.',
} as unknown as JSONSchemaType<DiscoveryDeleteInput>

export const DiscoveryDeleteOutputSchema = {
  type: 'object',
  properties: { deleted: { type: 'boolean', description: 'true when a row was removed' } },
  required: ['deleted'],
  additionalProperties: false,
} as unknown as JSONSchemaType<DiscoveryDeleteOutput>

export const DiscoverySearchInputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'substring to match against name and description (empty = all)' },
    kind: { ...kindJsonSchema, nullable: true, description: 'optional kind filter' },
    limit: { type: 'integer', minimum: 1, nullable: true, description: 'max results (default 100)' },
  },
  required: ['query'],
  additionalProperties: false,
  description:
    'Search the discovery store by name/description substring, optionally narrowed by kind. Scoped to the provisioned space.',
} as unknown as JSONSchemaType<DiscoverySearchInput>

export const DiscoverySearchOutputSchema = {
  type: 'object',
  properties: { rows: { type: 'array', items: discoveryRowJsonSchema } },
  required: ['rows'],
  additionalProperties: false,
} as unknown as JSONSchemaType<DiscoverySearchOutput>

// ---------------------------------------------------------------------------
// Row (de)serialization
// ---------------------------------------------------------------------------

type StoredRow = {
  id: string
  kind: DiscoveryKind
  space: string
  name: string
  description: string
  handle: string
  metadata_json: string | null
  updated_at: number
}

const toDiscoveryRow = (row: StoredRow): DiscoveryRow => {
  let metadata: Record<string, unknown> | null = null
  if (row.metadata_json) {
    try {
      const parsed = JSON.parse(row.metadata_json)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      metadata = null
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    space: row.space,
    name: row.name,
    description: row.description,
    handle: row.handle,
    metadata,
    updated_at: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Store lifecycle — ~/.behavioral/db.sqlite (WAL), per-call connection
// ---------------------------------------------------------------------------

/**
 * Open the store for one operation, ensure the schema, run `operation`, and
 * close. The store is the single `~/.behavioral/db.sqlite` in WAL mode; its
 * path derives from the home root, never from agent input. No shared
 * connection, no factory — the tools hold no state.
 */
const withStore = async <T>(operation: (db: Database) => T): Promise<T> => {
  const dbPath = path.join(behavioralHomeRoot(), DB_FILE)
  // bun:sqlite creates the file but not its parent directory — ensure the
  // home root exists before opening.
  await Bun.$`mkdir -p ${path.dirname(dbPath)}`.quiet().nothrow()
  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(CREATE_TABLE_SQL)
    return operation(db)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Space scoping — the provisioner-side WHERE clause.
// Root is unscoped (cross-space navigation); a provisioned space sees only
// its own rows.
// ---------------------------------------------------------------------------

const scopeCondition = (): { clause: string; params: string[] } =>
  isUnscoped()
    ? { clause: '', params: [] }
    : // root is the shared global catalog — a provisioned space sees its own
      // rows plus root's, never another project space's.
      { clause: " AND (space = ? OR space = 'root')", params: [provisionedSpace] }

// ---------------------------------------------------------------------------
// useTool registration — flat, standalone tools (one per operation)
// ---------------------------------------------------------------------------

/**
 * Create a row in the unified catalog. `handle` is the server-url for
 * mcp-tool, the SKILL.md path for skill, or the artifact path for
 * thread/html; `metadata` carries the inputSchema (mcp-tool), frontmatter
 * (skill), or BMeta-derived fields (thread/html). The row is stamped with the
 * provisioned space.
 */
export const discoveryCreate = useTool(
  {
    name: 'discovery-create',
    description:
      'Create a row in the unified catalog (kind "mcp-tool" | "skill" | "thread" | "html"). handle is the server-url for mcp-tool, the SKILL.md path for skill, or the artifact path for thread/html; metadata carries kind-specific fields. Stamped with the provisioned space.',
    inputSchema: DiscoveryCreateInputSchema,
    outputSchema: DiscoveryCreateOutputSchema,
  },
  ({ kind, name, description, handle, metadata }) =>
    withStore((db): DiscoveryCreateOutput => {
      const id = crypto.randomUUID()
      const updatedAt = Date.now()
      const metadataJson = metadata ? JSON.stringify(metadata) : null
      db.prepare(
        'INSERT INTO discovery (id, kind, space, name, description, handle, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, kind, provisionedSpace, name, description, handle, metadataJson, updatedAt)
      const row = toDiscoveryRow(db.prepare('SELECT * FROM discovery WHERE id = ?').get(id) as StoredRow)
      return { row }
    }),
)

/**
 * Read one discovery row by id, scoped to the provisioned space. Returns row
 * null when no such row exists in scope.
 */
export const discoveryRead = useTool(
  {
    name: 'discovery-read',
    description:
      'Read one discovery row by id, scoped to the provisioned space. Returns row null when no such row exists.',
    inputSchema: DiscoveryReadInputSchema,
    outputSchema: DiscoveryReadOutputSchema,
  },
  ({ id }) =>
    withStore((db): DiscoveryReadOutput => {
      const { clause, params } = scopeCondition()
      const stored = db.prepare(`SELECT * FROM discovery WHERE id = ?${clause}`).get(id, ...params) as StoredRow | null
      return { row: stored ? toDiscoveryRow(stored) : null }
    }),
)

/**
 * Update one discovery row by id; omitted fields are left unchanged. Returns
 * row null with isError when no such row exists in scope.
 */
export const discoveryUpdate = useTool(
  {
    name: 'discovery-update',
    description:
      'Update one discovery row by id (scoped to the provisioned space); omitted fields are left unchanged. Returns row null with isError when no such row exists.',
    inputSchema: DiscoveryUpdateInputSchema,
    outputSchema: DiscoveryUpdateOutputSchema,
  },
  ({ id, name, description, handle, metadata }) =>
    withStore((db): DiscoveryUpdateOutput => {
      const { clause, params } = scopeCondition()
      const existing = db
        .prepare(`SELECT * FROM discovery WHERE id = ?${clause}`)
        .get(id, ...params) as StoredRow | null
      if (!existing) {
        return { row: null, isError: true, message: `No discovery row with id ${id}` }
      }
      const next: StoredRow = {
        ...existing,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(handle === undefined ? {} : { handle }),
        ...(metadata === undefined ? {} : { metadata_json: JSON.stringify(metadata) }),
        updated_at: Date.now(),
      }
      db.prepare(
        'UPDATE discovery SET name = ?, description = ?, handle = ?, metadata_json = ?, updated_at = ? WHERE id = ?',
      ).run(next.name, next.description, next.handle, next.metadata_json, next.updated_at, next.id)
      return { row: toDiscoveryRow(next) }
    }),
)

/**
 * Delete one discovery row by id, scoped to the provisioned space. Returns
 * deleted false when no such row exists in scope.
 */
export const discoveryDelete = useTool(
  {
    name: 'discovery-delete',
    description:
      'Delete one discovery row by id, scoped to the provisioned space. Returns deleted false when no such row exists.',
    inputSchema: DiscoveryDeleteInputSchema,
    outputSchema: DiscoveryDeleteOutputSchema,
  },
  ({ id }) =>
    withStore((db): DiscoveryDeleteOutput => {
      const { clause, params } = scopeCondition()
      const result = db.prepare(`DELETE FROM discovery WHERE id = ?${clause}`).run(id, ...params)
      return { deleted: result.changes > 0 }
    }),
)

/**
 * Search the unified catalog (tier 1) by case-insensitive name/description
 * substring; an empty query matches all rows in scope. Optional kind filter
 * and limit (default 100). The model searches to find candidates, then loads
 * full content via skill-client / plugin-client / the artifact file itself.
 */
export const discoverySearch = useTool(
  {
    name: 'discovery-search',
    description:
      'Search the unified catalog (tier 1) by case-insensitive name/description substring; an empty query matches all rows. Optional kind filter and limit (default 100). Scoped to the provisioned space.',
    inputSchema: DiscoverySearchInputSchema,
    outputSchema: DiscoverySearchOutputSchema,
  },
  ({ query, kind, limit }) =>
    withStore((db): DiscoverySearchOutput => {
      const effectiveLimit = limit ?? DEFAULT_SEARCH_LIMIT
      // Case-insensitive LIKE over name + description. An empty query matches
      // all rows (tier-1 catalog). LIKE is case-insensitive for ASCII by
      // default; LOWER() covers non-ASCII consistently.
      let sql = 'SELECT * FROM discovery WHERE (LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?))'
      const params: (string | number)[] = [`%${query}%`, `%${query}%`]
      const scope = scopeCondition()
      sql += scope.clause
      params.push(...scope.params)
      if (kind) {
        sql += ' AND kind = ?'
        params.push(kind)
      }
      sql += ' ORDER BY name ASC LIMIT ?'
      params.push(effectiveLimit)
      const rows = db.prepare(sql).all(...params) as StoredRow[]
      return { rows: rows.map(toDiscoveryRow) }
    }),
)

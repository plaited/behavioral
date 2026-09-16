/**
 * Agent-facing discovery store — CRUD + search over a unified catalog of
 * remote MCP tools and local skills.
 *
 * @remarks
 * Flat, standalone `useTool` units — one per operation: `discovery-create`,
 * `discovery-read`, `discovery-update`, `discovery-delete`, and
 * `discovery-search`. Import a tool and call it; no provisioning layer, no
 * shared connection. Each call opens the SQLite store, ensures the table, runs
 * the operation, and closes. A CLI could dispatch to these directly.
 *
 * Backs the search-mediated progressive-disclosure loop: a kernel behavioral
 * thread populates the store via create/update from `mcp-client` / skill
 * discovery results, then searches it (tier 1) to surface candidates to the
 * model; the model picks and loads tier-2/tier-3 content through the relevant
 * client tool. These tools are the dumb primitives; the smarts live in the
 * thread.
 *
 * The store path is **derived, not supplied**: every tool takes the
 * provisioned `cwd` (same convention as the file tools and `skill-client`) and
 * resolves `<cwd>/.behavioral/discovery.sqlite`. There is deliberately no
 * `dbPath` input field, so a model cannot choose an absolute store path
 * (`additionalProperties: false` rejects it at the schema boundary). Unified
 * rows: `kind ∈ {'mcp-tool','skill'}`, plus `id`, `name`, `description`,
 * `handle` (server-url for mcp-tool, SKILL.md path for skill), `metadata_json`
 * (inputSchema for mcp-tool, frontmatter for skill), `updated_at`.
 *
 * Not git-backed — local SQLite, regenerable (re-scan filesystem, re-discover
 * servers).
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
import { useTool } from './use-tool.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveryKind = 'mcp-tool' | 'skill'

export type DiscoveryRow = {
  id: string
  kind: DiscoveryKind
  name: string
  description: string
  handle: string
  metadata: Record<string, unknown> | null
  updated_at: number
}

/** Every operation takes the provisioned cwd; the store path derives from it. */
type WithCwd = { cwd: string }

export type DiscoveryCreateInput = WithCwd & {
  kind: DiscoveryKind
  name: string
  description: string
  handle: string
  metadata?: Record<string, unknown>
}
export type DiscoveryCreateOutput = { row: DiscoveryRow }

export type DiscoveryReadInput = WithCwd & { id: string }
export type DiscoveryReadOutput = { row: DiscoveryRow | null }

export type DiscoveryUpdateInput = WithCwd & {
  id: string
  name?: string
  description?: string
  handle?: string
  metadata?: Record<string, unknown>
}
export type DiscoveryUpdateOutput = { row: DiscoveryRow | null; isError?: boolean; message?: string }

export type DiscoveryDeleteInput = WithCwd & { id: string }
export type DiscoveryDeleteOutput = { deleted: boolean }

export type DiscoverySearchInput = WithCwd & { query: string; kind?: DiscoveryKind; limit?: number }
export type DiscoverySearchOutput = { rows: DiscoveryRow[] }

// ---------------------------------------------------------------------------
// Tool JSON schemas — one schema pair per tool, no `mode` discriminator.
// `dbPath` is deliberately absent from every schema — the store path derives
// from `cwd`, so a model-supplied absolute path is rejected by
// `additionalProperties: false`. Cast through `unknown` where the open row
// shape exceeds `JSONSchemaType`'s static power; AJV validates at runtime.
// ---------------------------------------------------------------------------

const cwdJsonSchema = {
  type: 'string',
  minLength: 1,
  description: "the tool's provisioned cwd — the store resolves to <cwd>/.behavioral/discovery.sqlite",
} as const

const kindJsonSchema = { type: 'string', enum: ['mcp-tool', 'skill'] } as const
const metadataJsonSchema = {
  type: 'object',
  additionalProperties: true,
  nullable: true,
  description: 'metadata blob — inputSchema for mcp-tool, frontmatter for skill',
} as const

const discoveryRowJsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['mcp-tool', 'skill'] },
    name: { type: 'string' },
    description: { type: 'string' },
    handle: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true, nullable: true },
    updated_at: { type: 'integer' },
  },
  required: ['id', 'kind', 'name', 'description', 'handle', 'updated_at'],
  additionalProperties: false,
} as const

export const DiscoveryCreateInputSchema = {
  type: 'object',
  properties: {
    cwd: cwdJsonSchema,
    kind: kindJsonSchema,
    name: { type: 'string', minLength: 1, description: 'tool or skill name' },
    description: { type: 'string', description: 'short description for tier-1 search' },
    handle: {
      type: 'string',
      minLength: 1,
      description: 'server-url for mcp-tool, SKILL.md path for skill',
    },
    metadata: metadataJsonSchema,
  },
  required: ['cwd', 'kind', 'name', 'description', 'handle'],
  additionalProperties: false,
  description: 'Create one discovery row in <cwd>/.behavioral/discovery.sqlite.',
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
    cwd: cwdJsonSchema,
    id: { type: 'string', minLength: 1, description: 'row id' },
  },
  required: ['cwd', 'id'],
  additionalProperties: false,
  description: 'Read one discovery row by id.',
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
    cwd: cwdJsonSchema,
    id: { type: 'string', minLength: 1, description: 'row id' },
    name: { type: 'string', nullable: true, description: 'new name' },
    description: { type: 'string', nullable: true, description: 'new description' },
    handle: { type: 'string', nullable: true, description: 'new handle' },
    metadata: metadataJsonSchema,
  },
  required: ['cwd', 'id'],
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
    cwd: cwdJsonSchema,
    id: { type: 'string', minLength: 1, description: 'row id' },
  },
  required: ['cwd', 'id'],
  additionalProperties: false,
  description: 'Delete one discovery row by id.',
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
    cwd: cwdJsonSchema,
    query: { type: 'string', description: 'substring to match against name and description (empty = all)' },
    kind: { ...kindJsonSchema, nullable: true, description: 'optional kind filter' },
    limit: { type: 'integer', minimum: 1, nullable: true, description: 'max results (default 100)' },
  },
  required: ['cwd', 'query'],
  additionalProperties: false,
  description: 'Search the discovery store by name/description substring, optionally narrowed by kind.',
} as unknown as JSONSchemaType<DiscoverySearchInput>

export const DiscoverySearchOutputSchema = {
  type: 'object',
  properties: { rows: { type: 'array', items: discoveryRowJsonSchema } },
  required: ['rows'],
  additionalProperties: false,
} as unknown as JSONSchemaType<DiscoverySearchOutput>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_DIR = '.behavioral'
const STORE_FILE = 'discovery.sqlite'
const DEFAULT_SEARCH_LIMIT = 100

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS discovery (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('mcp-tool','skill')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  handle TEXT NOT NULL,
  metadata_json TEXT,
  updated_at INTEGER NOT NULL
)
`

// ---------------------------------------------------------------------------
// Row (de)serialization
// ---------------------------------------------------------------------------

type StoredRow = {
  id: string
  kind: DiscoveryKind
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
    name: row.name,
    description: row.description,
    handle: row.handle,
    metadata,
    updated_at: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Store lifecycle — <cwd>/.behavioral/discovery.sqlite, per-call connection
// ---------------------------------------------------------------------------

/**
 * Open the store for one operation, ensure the schema, run `operation`, and
 * close. The store path is `<cwd>/.behavioral/discovery.sqlite`; `cwd` is the
 * provisioned project root. No shared connection, no factory — the tools hold
 * no state.
 */
const withStore = async <T>(cwd: string, operation: (db: Database) => T): Promise<T> => {
  const dbPath = path.join(cwd, STORE_DIR, STORE_FILE)
  // bun:sqlite creates the file but not its parent directory — ensure the
  // store dir exists before opening (mirrors the `write` tool's mkdir -p).
  await Bun.$`mkdir -p ${path.dirname(dbPath)}`.quiet().nothrow()
  const db = new Database(dbPath)
  try {
    db.exec(CREATE_TABLE_SQL)
    return operation(db)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// useTool registration — flat, standalone tools (one per operation)
// ---------------------------------------------------------------------------

/**
 * Create a row in the unified catalog of remote MCP tools and local skills
 * (kind "mcp-tool" | "skill"). `handle` is the server-url for mcp-tool or the
 * SKILL.md path for skill; `metadata` carries the inputSchema (mcp-tool) or
 * frontmatter (skill).
 */
export const discoveryCreate = useTool(
  {
    name: 'discovery-create',
    description:
      'Create a row in the unified catalog of remote MCP tools and local skills (kind "mcp-tool" | "skill"). handle is the server-url for mcp-tool or the SKILL.md path for skill; metadata carries the inputSchema (mcp-tool) or frontmatter (skill).',
    inputSchema: DiscoveryCreateInputSchema,
    outputSchema: DiscoveryCreateOutputSchema,
  },
  ({ cwd, kind, name, description, handle, metadata }) =>
    withStore(cwd, (db): DiscoveryCreateOutput => {
      const id = crypto.randomUUID()
      const updatedAt = Date.now()
      const metadataJson = metadata ? JSON.stringify(metadata) : null
      db.prepare(
        'INSERT INTO discovery (id, kind, name, description, handle, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, kind, name, description, handle, metadataJson, updatedAt)
      const row = toDiscoveryRow(db.prepare('SELECT * FROM discovery WHERE id = ?').get(id) as StoredRow)
      return { row }
    }),
)

/**
 * Read one discovery row by id. Returns row null when no such row exists.
 */
export const discoveryRead = useTool(
  {
    name: 'discovery-read',
    description: 'Read one discovery row by id. Returns row null when no such row exists.',
    inputSchema: DiscoveryReadInputSchema,
    outputSchema: DiscoveryReadOutputSchema,
  },
  ({ cwd, id }) =>
    withStore(cwd, (db): DiscoveryReadOutput => {
      const stored = db.prepare('SELECT * FROM discovery WHERE id = ?').get(id) as StoredRow | null
      return { row: stored ? toDiscoveryRow(stored) : null }
    }),
)

/**
 * Update one discovery row by id; omitted fields are left unchanged. Returns
 * row null with isError when no such row exists.
 */
export const discoveryUpdate = useTool(
  {
    name: 'discovery-update',
    description:
      'Update one discovery row by id; omitted fields are left unchanged. Returns row null with isError when no such row exists.',
    inputSchema: DiscoveryUpdateInputSchema,
    outputSchema: DiscoveryUpdateOutputSchema,
  },
  ({ cwd, id, name, description, handle, metadata }) =>
    withStore(cwd, (db): DiscoveryUpdateOutput => {
      const existing = db.prepare('SELECT * FROM discovery WHERE id = ?').get(id) as StoredRow | null
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
 * Delete one discovery row by id. Returns deleted false when no such row exists.
 */
export const discoveryDelete = useTool(
  {
    name: 'discovery-delete',
    description: 'Delete one discovery row by id. Returns deleted false when no such row exists.',
    inputSchema: DiscoveryDeleteInputSchema,
    outputSchema: DiscoveryDeleteOutputSchema,
  },
  ({ cwd, id }) =>
    withStore(cwd, (db): DiscoveryDeleteOutput => {
      const result = db.prepare('DELETE FROM discovery WHERE id = ?').run(id)
      return { deleted: result.changes > 0 }
    }),
)

/**
 * Search the unified catalog (tier 1) by case-insensitive name/description
 * substring; an empty query matches all rows. Optional kind filter and limit
 * (default 100). The model searches to find candidates, then loads full
 * content via mcp-client / skill-client.
 */
export const discoverySearch = useTool(
  {
    name: 'discovery-search',
    description:
      'Search the unified catalog (tier 1) by case-insensitive name/description substring; an empty query matches all rows. Optional kind filter and limit (default 100). The model searches to find candidates, then loads full content via mcp-client / skill-client.',
    inputSchema: DiscoverySearchInputSchema,
    outputSchema: DiscoverySearchOutputSchema,
  },
  ({ cwd, query, kind, limit }) =>
    withStore(cwd, (db): DiscoverySearchOutput => {
      const effectiveLimit = limit ?? DEFAULT_SEARCH_LIMIT
      // Case-insensitive LIKE over name + description. An empty query matches
      // all rows (tier-1 catalog). LIKE is case-insensitive for ASCII by
      // default; LOWER() covers non-ASCII consistently.
      let sql = 'SELECT * FROM discovery WHERE (LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?))'
      const params: (string | number)[] = [`%${query}%`, `%${query}%`]
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

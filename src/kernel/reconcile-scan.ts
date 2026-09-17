/**
 * The reconcile scan — the sole discovery-store writer (plan.md Decision Log
 * 2026-09-17). Files + git are the authority; the db is a materialized view,
 * regenerable, never authoritative.
 *
 * @remarks
 * Runs post-turn / at-provisioning. Walks `~/.behavioral/<space>/{threads,
 * html}` (root's scan indexes all spaces), the project `.agents/skills/`, and
 * installed plugins; derives rows from BMeta + `git log -1` per artifact
 * (commitSha into metadata); upserts/deletes via the discovery tools.
 *
 * **Uncommitted means unlearned**: a thread/html artifact with no commit in
 * the `~/.behavioral` repo is correctly absent from the index — mid-turn
 * search missing a not-yet-committed artifact is the designed behavior.
 *
 * The scan relinquishes write-policy governors via the `scan.begin` event and
 * binds the provisioned space identity per write — it is the provisioner-side
 * caller of {@link provisionDiscoverySpace}, not an agent.
 *
 * MINIMAL: skills are scanned from the project `.agents/skills/` only (the
 * user-level `~/.agents/skills` scan is skill-client's discovery surface);
 * upgrade path: add the user-level walk when a consumer needs it.
 *
 * @packageDocumentation
 */

import * as path from 'node:path'
import {
  DISCOVERY_PLUGIN_SOURCE,
  discoveryCreate,
  discoveryDelete,
  discoverySearch,
  discoveryUpdate,
  provisionDiscoverySpace,
} from '../tools/discovery.ts'
import { pluginClient } from '../tools/plugin-client.ts'
import { ajv } from '../tools/use-tool.ts'
import { behavioralHomeRoot, ROOT_SPACE } from './behavioral-home.ts'
import { BMetaSchema } from './bmeta.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScanResult = {
  /** The spaces scanned (root included when present). */
  spaces: string[]
  created: number
  updated: number
  deleted: number
  /** Committed-but-invalid artifacts (malformed BMeta) — never indexed. */
  skippedInvalid: number
  /** Uncommitted thread/html artifacts — unlearned, correctly absent. */
  skippedUncommitted: number
}

export type ScanOptions = {
  /** Spaces to scan; default: every space directory in the home (root's scan indexes all spaces). */
  spaces?: string[]
  /** Project cwd for `.agents/skills/` + installed plugins; defaults to process.cwd(). */
  cwd?: string
}

/** A row the scan intends the store to hold, before reconciliation. */
type DerivedRow = {
  kind: 'thread' | 'html' | 'skill' | 'mcp-tool'
  space: string
  name: string
  description: string
  handle: string
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const listSpaces = async (home: string): Promise<string[]> => {
  const entries = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: home, onlyFiles: false }))
  const spaces: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (await Bun.file(path.join(home, entry)).exists()) continue // files are not spaces
    spaces.push(entry)
  }
  return spaces.sort()
}

/** `git log -1` for one artifact — null when never committed (unlearned). */
const commitShaFor = async (repo: string, relPath: string): Promise<string | null> => {
  const sha = await Bun.$`git -C ${repo} log -1 --format=%H -- ${relPath}`.quiet().nothrow().text()
  return sha.trim().length > 0 ? sha.trim() : null
}

/** Scan one glob from `cwd`; a missing cwd scans to nothing (valid absence). */
const scanGlob = async (glob: string, cwd: string): Promise<string[]> => {
  try {
    return await Array.fromAsync(new Bun.Glob(glob).scan({ cwd, onlyFiles: true }))
  } catch {
    return []
  }
}

const validateBMetaObject = ajv.compile(BMetaSchema)

/**
 * Read a thread artifact's `meta` export in a worker subprocess — fresh module
 * resolution per scan (no process module-cache staleness) and module side
 * effects stay out of the kernel process.
 */
const readThreadMeta = async (filePath: string): Promise<unknown> => {
  const script = `const m = await import(${JSON.stringify(filePath)}); await Bun.write(Bun.stdout, JSON.stringify(m.meta ?? null))`
  const out = await Bun.$`bun -e ${script}`.quiet().nothrow().text()
  try {
    return JSON.parse(out.trim())
  } catch {
    return null
  }
}

const extractBMetaBlock = (html: string): string | null => {
  const match = html.match(/<script(?=[^>]*type="application\/json")(?=[^>]*\bb-meta\b)[^>]*>([\s\S]*?)<\/script>/i)
  return match?.[1]?.trim() ?? null
}

const frontmatterField = (text: string, field: 'name' | 'description'): string | null => {
  const block = text.match(/^---\n([\s\S]*?)\n---/)
  if (!block) return null
  return block[1]?.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null
}

const scanThreadFile = async (
  filePath: string,
  relPath: string,
  space: string,
  result: ScanResult,
): Promise<DerivedRow | null> => {
  const home = behavioralHomeRoot()
  const sha = await commitShaFor(home, relPath)
  if (!sha) {
    result.skippedUncommitted++
    return null
  }
  const metaValue = await readThreadMeta(filePath)
  if (!validateBMetaObject(metaValue)) {
    result.skippedInvalid++
    return null
  }
  const meta = metaValue as { title: string; description: string }
  return {
    kind: 'thread',
    space,
    name: meta.title,
    description: meta.description,
    handle: filePath,
    metadata: { commitSha: sha },
  }
}

const scanHtmlFile = async (
  filePath: string,
  relPath: string,
  space: string,
  result: ScanResult,
): Promise<DerivedRow | null> => {
  const sha = await commitShaFor(behavioralHomeRoot(), relPath)
  if (!sha) {
    result.skippedUncommitted++
    return null
  }
  const block = extractBMetaBlock(await Bun.file(filePath).text())
  if (!block || !validateBMetaObject(JSON.parse(block || 'null'))) {
    result.skippedInvalid++
    return null
  }
  // parseBMeta already validated this shape via the same schema; re-parse for
  // the typed value (JSON.parse above guards the "not JSON at all" branch).
  const meta = JSON.parse(block) as { title: string; description: string }
  return {
    kind: 'html',
    space,
    name: meta.title,
    description: meta.description,
    handle: filePath,
    metadata: { commitSha: sha },
  }
}

const scanSpaceArtifacts = async (space: string, result: ScanResult): Promise<DerivedRow[]> => {
  const home = behavioralHomeRoot()
  const rows: DerivedRow[] = []
  const treeDirs: Array<{ dir: string; glob: string }> = [
    { dir: path.join(home, space, 'threads'), glob: '*.ts' },
    { dir: path.join(home, space, 'html'), glob: '*.html' },
  ]
  for (const { dir, glob } of treeDirs) {
    const files = (await scanGlob(glob, dir)).sort()
    for (const file of files.sort()) {
      const filePath = path.join(dir, file)
      const relPath = path.join(space, path.basename(dir), file)
      const row =
        glob === '*.ts'
          ? await scanThreadFile(filePath, relPath, space, result)
          : await scanHtmlFile(filePath, relPath, space, result)
      if (row) rows.push(row)
    }
  }
  return rows
}

const scanProjectSkills = async (cwd: string, result: ScanResult): Promise<DerivedRow[]> => {
  const rows: DerivedRow[] = []
  const skillsRoot = path.join(cwd, '.agents', 'skills')
  const skillDirs = (await scanGlob('*/SKILL.md', skillsRoot)).sort()
  for (const entry of skillDirs.sort()) {
    const skillName = entry.split('/')[0] as string
    const filePath = path.join(skillsRoot, entry)
    const sha = await commitShaFor(cwd, path.join('.agents', 'skills', entry))
    const text = await Bun.file(filePath).text()
    rows.push({
      kind: 'skill',
      space: ROOT_SPACE,
      name: frontmatterField(text, 'name') ?? skillName,
      description: frontmatterField(text, 'description') ?? '',
      handle: filePath,
      metadata: { ...(sha ? { commitSha: sha } : {}) },
    })
  }
  return rows
}

const scanPlugins = async (pluginRoots: string[]): Promise<DerivedRow[]> => {
  const rows: DerivedRow[] = []
  for (const pluginsDir of pluginRoots) {
    const manifests = (await scanGlob('*/plugin.json', pluginsDir)).sort()
    for (const entry of manifests.sort()) {
      const pluginDir = path.join(pluginsDir, path.dirname(entry))
      const manifest = await pluginClient({ path: 'plugin.json', cwd: pluginDir })
      if ('isError' in manifest) continue
      for (const skill of manifest.skills) {
        rows.push({
          kind: 'skill',
          space: ROOT_SPACE,
          name: skill,
          description: `Skill shipped by the ${manifest.name} plugin.`,
          handle: path.join(pluginDir, 'skills', skill, 'SKILL.md'),
          metadata: { source: DISCOVERY_PLUGIN_SOURCE },
        })
      }
      for (const [mcpName, config] of Object.entries(manifest.mcps)) {
        rows.push({
          kind: 'mcp-tool',
          space: ROOT_SPACE,
          name: mcpName,
          description: `MCP server shipped by the ${manifest.name} plugin.`,
          handle: config.url ?? config.command ?? mcpName,
          metadata: { source: DISCOVERY_PLUGIN_SOURCE },
        })
      }
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Reconcile the discovery store with the authority (files + git): derive rows
 * from committed artifacts, upsert changed ones, delete rows whose artifacts
 * vanished. The sole writer of the store.
 */
export const reconcileScan = async (options: ScanOptions = {}): Promise<ScanResult> => {
  const home = behavioralHomeRoot()
  const cwd = options.cwd ?? process.cwd()
  const result: ScanResult = {
    spaces: options.spaces ?? (await listSpaces(home)),
    created: 0,
    updated: 0,
    deleted: 0,
    skippedInvalid: 0,
    skippedUncommitted: 0,
  }

  const derived: DerivedRow[] = []
  for (const space of result.spaces) {
    derived.push(...(await scanSpaceArtifacts(space, result)))
  }
  derived.push(...(await scanProjectSkills(cwd, result)))
  derived.push(
    ...(await scanPlugins([
      path.join(cwd, '.agents', 'plugins'),
      path.join(behavioralHomeRoot(), '..', '.agents', 'plugins'),
    ])),
  )

  try {
    // Unscoped read: the whole store, keyed by (kind, space, handle).
    provisionDiscoverySpace(ROOT_SPACE)
    const existingRows = (await discoverySearch({ query: '' })).rows
    const existingKeys = new Map<string, (typeof existingRows)[number]>()
    for (const row of existingRows) {
      existingKeys.set(`${row.kind}|${row.space}|${row.handle}`, row)
    }

    const derivedKeys = new Set<string>()
    for (const row of derived) {
      const key = `${row.kind}|${row.space}|${row.handle}`
      derivedKeys.add(key)
      const existing = existingKeys.get(key)
      if (!existing) {
        provisionDiscoverySpace(row.space)
        await discoveryCreate({
          kind: row.kind,
          name: row.name,
          description: row.description,
          handle: row.handle,
          metadata: row.metadata,
        })
        result.created++
        continue
      }
      const changed =
        existing.name !== row.name ||
        existing.description !== row.description ||
        JSON.stringify(existing.metadata ?? {}) !== JSON.stringify(row.metadata)
      if (changed) {
        await discoveryUpdate({
          id: existing.id,
          name: row.name,
          description: row.description,
          metadata: row.metadata,
        })
        result.updated++
      }
    }

    // Delete rows whose artifacts vanished (scan-managed kinds, scanned spaces only).
    for (const row of existingRows) {
      if (!result.spaces.includes(row.space)) continue
      if (row.kind !== 'thread' && row.kind !== 'html' && row.kind !== 'skill' && row.kind !== 'mcp-tool') continue
      if (derivedKeys.has(`${row.kind}|${row.space}|${row.handle}`)) continue
      provisionDiscoverySpace(row.space)
      await discoveryDelete({ id: row.id })
      result.deleted++
    }
  } finally {
    provisionDiscoverySpace(ROOT_SPACE)
  }

  return result
}

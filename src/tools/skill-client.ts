/**
 * Agent-facing skill client — progressive disclosure over local skills.
 *
 * @remarks
 * Implements the agentskills.io three-tier progressive-disclosure pattern for
 * local skills, but with **search-on-demand** replacing the spec's recommended
 * static catalog-in-system-prompt (the deliberate 2026-09-07 decision). This
 * tool is the dumb primitive: it discovers, reads, and lists resources. The
 * catalog/search loop lives in a kernel behavioral thread, not here.
 *
 * Three tools (one per mode, no `mode` discriminator):
 * - {@link skillDiscover} — tier 1 metadata: scan `.agents/skills/` at project
 *   + user level, parse YAML frontmatter → `{ name, description, location, ... }`
 *   records (lenient validation per spec).
 * - {@link skillRead} — tier 2 full instructions: load the SKILL.md body with
 *   frontmatter stripped.
 * - {@link skillListResources} — tier 3 bundled-resource preview: enumerate
 *   bundled files in the skill directory without reading them.
 *
 * Returns data only; never writes. Own frontmatter parsing (does not import
 * the deleted `src/cli/markdown.ts` CLI). `cwd` is provisioner-supplied (same
 * trust-boundary treatment as `read`/`ls`/`write`).
 *
 * MINIMAL: no static skill catalog is emitted into any system prompt — the
 * search-mediated loop is the deliberate deviation from agentskills.io Step 3.
 * Upgrade path: none intended; search-on-demand is the chosen architecture.
 *
 * @packageDocumentation
 */

import { readdir, stat } from 'node:fs/promises'
import * as path from 'node:path'
import type { JSONSchemaType } from 'ajv'
import { YAML } from 'bun'
import { useTool } from './use-tool.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillRecord = {
  name: string
  description: string
  location: string
  [key: string]: unknown
}

type ResourceEntry = {
  /** Path relative to the skill directory, using forward slashes. */
  name: string
  type: 'file' | 'directory'
}

export type SkillDiscoverInput = { cwd: string }

export type SkillDiscoverOutput = {
  skills: SkillRecord[]
  warnings: string[]
}

export type SkillReadInput = { cwd: string; location: string }

export type SkillReadOutput = { name: string; body: string } | { isError: true; message: string }

export type SkillListResourcesInput = { cwd: string; location: string }

export type SkillListResourcesOutput = { resources: ResourceEntry[] }

// ---------------------------------------------------------------------------
// Tool JSON schemas — one schema pair per tool, no `mode` discriminator.
// AJV validates at runtime; `SkillRecord`'s open index signature means the
// discover output schema is cast through `unknown` (same precedent as
// frontier.ts / html.ts).
// ---------------------------------------------------------------------------

const skillRecordJsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    location: { type: 'string' },
  },
  required: ['name', 'description', 'location'],
  additionalProperties: true,
} as const

const cwdJsonSchema = {
  type: 'string',
  minLength: 1,
  description: "the tool's provisioned cwd",
} as const

export const SkillDiscoverInputSchema = {
  type: 'object',
  properties: { cwd: cwdJsonSchema },
  required: ['cwd'],
  additionalProperties: false,
  description:
    'Discover tier-1 metadata for local skills: scan `.agents/skills/` at project + user level and parse SKILL.md frontmatter.',
} as unknown as JSONSchemaType<SkillDiscoverInput>

export const SkillDiscoverOutputSchema = {
  type: 'object',
  properties: {
    skills: { type: 'array', items: skillRecordJsonSchema },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['skills', 'warnings'],
  additionalProperties: false,
} as unknown as JSONSchemaType<SkillDiscoverOutput>

export const SkillReadInputSchema = {
  type: 'object',
  properties: {
    cwd: cwdJsonSchema,
    location: {
      type: 'string',
      minLength: 1,
      description: 'path to the SKILL.md file — absolute, or relative to the provisioned cwd',
    },
  },
  required: ['cwd', 'location'],
  additionalProperties: false,
  description: 'Load a SKILL.md body (tier 2 full instructions) with frontmatter stripped.',
} as unknown as JSONSchemaType<SkillReadInput>

export const SkillReadOutputSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the skill name from frontmatter; empty when absent' },
        body: { type: 'string', description: 'the SKILL.md body with frontmatter stripped' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        isError: { type: 'boolean', const: true },
        message: { type: 'string', minLength: 1 },
      },
      required: ['isError', 'message'],
      additionalProperties: false,
    },
  ],
  description: 'On success: { name, body }. On failure: { isError: true, message }.',
} as unknown as JSONSchemaType<SkillReadOutput>

export const SkillListResourcesInputSchema = {
  type: 'object',
  properties: {
    cwd: cwdJsonSchema,
    location: {
      type: 'string',
      minLength: 1,
      description: 'path to the SKILL.md file whose directory to enumerate',
    },
  },
  required: ['cwd', 'location'],
  additionalProperties: false,
  description: 'Enumerate bundled files (tier 3) in a skill directory without reading them.',
} as unknown as JSONSchemaType<SkillListResourcesInput>

export const SkillListResourcesOutputSchema = {
  type: 'object',
  properties: {
    resources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'path relative to the skill directory, using forward slashes' },
          type: { type: 'string', enum: ['file', 'directory'] },
        },
        required: ['name', 'type'],
        additionalProperties: false,
      },
    },
  },
  required: ['resources'],
  additionalProperties: false,
} as unknown as JSONSchemaType<SkillListResourcesOutput>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_DIR_NAME = '.agents/skills'
const SKILL_FILE = 'SKILL.md'
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store'])
const NAME_MAX_LENGTH = 64

// ---------------------------------------------------------------------------
// Frontmatter parsing (own — does not import src/cli/markdown.ts)
// ---------------------------------------------------------------------------

type ParsedFrontmatter = {
  frontmatter: Record<string, unknown>
  body: string
}

/**
 * Parse a SKILL.md into frontmatter + body. Lenient: returns `null` when the
 * YAML block is absent or unparseable (e.g. an unquoted value containing a
 * colon — the common cross-client breakage the agentskills.io spec calls out).
 */
const parseSkillFrontmatter = (markdown: string): ParsedFrontmatter | null => {
  if (!markdown.startsWith('---')) return null

  // Find the opening delimiter end (skip trailing whitespace on the first line).
  let openEnd = 3
  while (openEnd < markdown.length && markdown[openEnd] !== '\n' && markdown[openEnd] !== '\r') {
    // Only whitespace allowed between the dashes and the line break.
    if (markdown[openEnd] !== ' ' && markdown[openEnd] !== '\t') return null
    openEnd++
  }
  if (openEnd >= markdown.length) return null
  // Skip the line break.
  const frontmatterStart = openEnd + (markdown[openEnd] === '\r' && markdown[openEnd + 1] === '\n' ? 2 : 1)

  // Find the closing `---` on its own line.
  let closeIndex = -1
  for (let i = frontmatterStart; i < markdown.length - 3; i++) {
    if (markdown[i] !== '\n' && markdown[i] !== '\r') continue
    // Must be at a line start: the char at i is a line break, so i+1 begins a line.
    const lineStart = i + 1
    if (markdown.startsWith('---', lineStart)) {
      // The delimiter must be followed by a line break or end-of-file, and only
      // whitespace may trail it on that line.
      const after = lineStart + 3
      if (after === markdown.length) {
        closeIndex = i
        break
      }
      const trailing = markdown[after]
      if (trailing === '\n' || trailing === '\r') {
        closeIndex = i
        break
      }
    }
  }
  if (closeIndex === -1) return null

  const frontmatterText = markdown.slice(frontmatterStart, closeIndex)
  let frontmatter: Record<string, unknown>
  try {
    const parsed = YAML.parse(frontmatterText)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    frontmatter = parsed as Record<string, unknown>
  } catch {
    return null
  }

  // Body = everything after the closing delimiter, trimmed.
  let bodyStart = closeIndex + 1 + 3 // past the line break + `---`
  while (bodyStart < markdown.length && (markdown[bodyStart] === ' ' || markdown[bodyStart] === '\t')) bodyStart++
  if (markdown[bodyStart] === '\r') bodyStart++
  if (markdown[bodyStart] === '\n') bodyStart++
  const body = markdown.slice(bodyStart).trim()

  return { frontmatter, body }
}

// ---------------------------------------------------------------------------
// discover (tier 1)
// ---------------------------------------------------------------------------

type DiscoveredSkill = {
  record: SkillRecord
  scope: 'project' | 'user'
}

const scanSkillsDir = async (
  skillsRoot: string,
  scope: 'project' | 'user',
  warnings: string[],
): Promise<DiscoveredSkill[]> => {
  const found: DiscoveredSkill[] = []
  let topEntries: import('node:fs').Dirent[]
  try {
    topEntries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    // No skills dir at this scope — not an error, just nothing to discover.
    return found
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const skillDir = path.join(skillsRoot, entry.name)
    const skillFile = path.join(skillDir, SKILL_FILE)
    const file = Bun.file(skillFile)
    if (!(await file.exists())) {
      // Not a skill directory (no SKILL.md) — skip silently.
      continue
    }
    const markdown = await file.text()
    const parsed = parseSkillFrontmatter(markdown)
    if (!parsed) {
      warnings.push(`Skipped skill "${entry.name}" at ${skillFile}: unparseable YAML frontmatter`)
      continue
    }
    const name = parsed.frontmatter.name
    const description = parsed.frontmatter.description
    if (typeof name !== 'string' || name.length === 0) {
      warnings.push(`Skipped skill at ${skillFile}: missing or empty name`)
      continue
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      warnings.push(`Skipped skill "${name}" at ${skillFile}: missing or empty description`)
      continue
    }
    // Lenient validation (warn, load anyway): name vs parent dir, name length.
    if (name !== entry.name) {
      warnings.push(`Skill "${name}" at ${skillFile}: name does not match parent directory "${entry.name}"`)
    }
    if (name.length > NAME_MAX_LENGTH) {
      warnings.push(`Skill "${name}" at ${skillFile}: name exceeds ${NAME_MAX_LENGTH} characters`)
    }

    const { name: _n, description: _d, ...rest } = parsed.frontmatter
    const record: SkillRecord = {
      name,
      description,
      location: skillFile,
      ...rest,
    }
    found.push({ record, scope })
  }
  return found
}

const discoverSkills = async (cwd: string): Promise<{ skills: SkillRecord[]; warnings: string[] }> => {
  const warnings: string[] = []
  const projectRoot = path.join(cwd, SKILL_DIR_NAME)
  const userRoot = path.join(Bun.env.HOME ?? Bun.env.USERPROFILE ?? '.', SKILL_DIR_NAME)

  // User-level first, then project-level, so project wins on collision.
  const user = await scanSkillsDir(userRoot, 'user', warnings)
  const project = await scanSkillsDir(projectRoot, 'project', warnings)

  // Deterministic precedence: project-level overrides user-level (same name).
  // Within a scope, first-found wins (directories read in fs order).
  const byName = new Map<string, DiscoveredSkill>()
  for (const s of user) byName.set(s.record.name, s)
  for (const s of project) {
    const existing = byName.get(s.record.name)
    if (existing && existing.scope === 'user') {
      warnings.push(`Skill "${s.record.name}": project-level overrides user-level`)
    }
    byName.set(s.record.name, s)
  }

  const skills = [...byName.values()].map((s) => s.record)
  // Stable order by name.
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, warnings }
}

// ---------------------------------------------------------------------------
// read-skill (tier 2)
// ---------------------------------------------------------------------------

const readSkillBody = async (cwd: string, location: string): Promise<SkillReadOutput> => {
  const resolved = path.resolve(cwd, location)
  const file = Bun.file(resolved)
  if (!(await file.exists())) {
    return { isError: true, message: `Skill file not found: ${resolved}` }
  }
  const markdown = await file.text()
  const parsed = parseSkillFrontmatter(markdown)
  // No frontmatter is allowed for read-skill (the whole file is the body); only
  // unparseable frontmatter (a malformed block that begins with ---) is an error.
  if (parsed === null && markdown.startsWith('---')) {
    return { isError: true, message: `Unparseable YAML frontmatter: ${resolved}` }
  }
  if (parsed === null) {
    return { name: '', body: markdown.trim() }
  }
  return { name: String(parsed.frontmatter.name ?? ''), body: parsed.body }
}

// ---------------------------------------------------------------------------
// list-resources (tier 3)
// ---------------------------------------------------------------------------

const walkSkillDir = async (dir: string, prefix: string, out: ResourceEntry[]): Promise<void> => {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    // SKILL.md is the instruction file (tier 2), not a bundled resource.
    if (!prefix && entry.name === SKILL_FILE) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push({ name: rel, type: 'directory' })
      await walkSkillDir(path.join(dir, entry.name), rel, out)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push({ name: rel, type: 'file' })
    }
  }
}

const listResources = async (cwd: string, location: string): Promise<ResourceEntry[]> => {
  const resolved = path.resolve(cwd, location)
  const skillDir = path.dirname(resolved)
  const stats = await stat(skillDir).catch(() => undefined)
  if (!stats?.isDirectory()) return []
  const out: ResourceEntry[] = []
  await walkSkillDir(skillDir, '', out)
  // Sort for stable output.
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// ---------------------------------------------------------------------------
// useTool registration — one tool per mode
// ---------------------------------------------------------------------------

/**
 * Discover tier-1 metadata for local skills: scan `.agents/skills/` at project
 * + user level, parse SKILL.md frontmatter, and return metadata records plus
 * warnings for skills that were skipped. Returns data only — never writes.
 */
export const skillDiscover = useTool(
  {
    name: 'skill-discover',
    description:
      'Discover local skills (tier 1 metadata): scan .agents/skills/ at project + user level, parse frontmatter into name/description/location records, and report skipped-skill warnings. Returns data only — never writes.',
    inputSchema: SkillDiscoverInputSchema,
    outputSchema: SkillDiscoverOutputSchema,
  },
  ({ cwd }) => discoverSkills(cwd),
)

/**
 * Load a SKILL.md body (tier 2 full instructions) with frontmatter stripped.
 * A missing file or unparseable frontmatter returns `{ isError, message }`.
 */
export const skillRead = useTool(
  {
    name: 'skill-read',
    description:
      "Load a local skill's SKILL.md body (tier 2 full instructions) with frontmatter stripped. Returns { name, body }, or { isError, message } when the file is missing or its frontmatter is unparseable.",
    inputSchema: SkillReadInputSchema,
    outputSchema: SkillReadOutputSchema,
  },
  ({ cwd, location }) => readSkillBody(cwd, location),
)

/**
 * Enumerate bundled files (tier 3) in a skill directory without reading them.
 * SKILL.md itself is excluded (it is the tier-2 instruction file).
 */
export const skillListResources = useTool(
  {
    name: 'skill-list-resources',
    description:
      'Enumerate bundled resources (tier 3) in a local skill directory as relative paths without reading them. SKILL.md is excluded — it is the tier-2 instruction file.',
    inputSchema: SkillListResourcesInputSchema,
    outputSchema: SkillListResourcesOutputSchema,
  },
  async ({ cwd, location }) => ({ resources: await listResources(cwd, location) }),
)

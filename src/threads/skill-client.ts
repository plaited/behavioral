/**
 * The skill-client thread library — the ICL replacement for the skill-discover
 * tool: a boot thread requests the scan recipe through the tools worker
 * (`bun run -`, the recipe on stdin, `format: 'json'`), and a transform
 * threads the result into the store as the skills CATALOG TENANT.
 *
 * The architecture per the rulings (plan.md, 2026-09-19/21): threads
 * orchestrate, the conventions skill teaches, the shell worker executes,
 * the store holds the catalog. The recipe carries the lenient per-skill
 * rules (skip + warn on unparseable YAML, missing name/description,
 * name/dir mismatch, >64 chars; project overrides user); the thread's
 * detailSchema gate enforces the coarse catalog envelope before the put —
 * validate-before-put as a hard gate, strictness scoped to `jsonData`.
 *
 * MINIMAL: the whole catalog is ONE store value (`skills`/`catalog`) —
 * per-skill row fan-out would need a transform-per-row shape the engine's
 * one-target-event-per-transform rule does not carry today. Upgrade path:
 * a row fan-out thread when a consumer needs per-skill keys.
 *
 * @packageDocumentation
 */

import type { Thread } from '../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../workers/workers.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The logical scan executor name — routes through the tools worker (`bun run -`). */
export const SKILL_SCAN_TOOL = 'skill-scan'

/** The boot scan call's correlation id — the catalog transform matches on it via the store value. */
export const SKILL_SCAN_CALL_ID = 'skill-scan-catalog'

/** The store collection holding the skills catalog. */
export const SKILL_CATALOG_COLLECTION = 'skills'

/** The catalog's store key — one value, the whole catalog (v1). */
export const SKILL_CATALOG_KEY = 'catalog'

// ── The catalog schema — schema-data: one shape, three uses (thread gate,
// store admission, future model-facing context) ──────────────────────────────

/** A validated catalog record — one skill's tier-1 metadata. */
export const SKILL_CATALOG_RECORD_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    location: { type: 'string', minLength: 1 },
  },
  required: ['name', 'description', 'location'],
  // Frontmatter is open — extra fields ride along verbatim.
  additionalProperties: true,
} as const

/**
 * The recipe→store contract: the coarse catalog envelope, enforced by the
 * catalog transform's detailSchema BEFORE the put — validate-before-put as a
 * hard gate. A malformed catalog fails the whole put (fail-closed), never
 * partial admission. Strictness is scoped to `jsonData`; the surrounding
 * ToolsResult fields stay loose (their schema home is the tools family).
 */
export const SKILL_CATALOG_SCHEMA = {
  type: 'object',
  properties: {
    skills: { type: 'array', items: SKILL_CATALOG_RECORD_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['skills', 'warnings'],
  additionalProperties: false,
} as const

// ── The scan recipe (stored-recipe flavor: contract-pinned, replayed verbatim) ─

/**
 * The skill-scan recipe — executed by the tools worker as `bun run -` stdin.
 *
 * For each SKILL.md: read the file → slice the `---` frontmatter fence →
 * `YAML.parse` the slice ONLY (never the whole file). Lenient per-skill
 * validation mirrors the retired tool: skip + warn on unparseable YAML,
 * missing or empty name/description; warn but load on name/dir mismatch
 * and name length. User scope scans first, then project — project wins on
 * collision (same precedence as the tool). Output is one JSON object on
 * stdout: `{ skills: [...], warnings: [...] }`, sorted by name.
 */
export const SKILL_SCAN_SCRIPT = `
import { readdirSync } from 'node:fs'
import { YAML } from 'bun'

const SKILL_DIR_NAME = '.agents/skills'
const SKILL_FILE = 'SKILL.md'
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const NAME_MAX_LENGTH = 64

const skills = new Map()
const warnings = []

const parseFrontmatter = (markdown) => {
  const match = markdown.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/)
  if (!match) return null
  try {
    const parsed = YAML.parse(match[1])
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

const scanRoot = async (skillsRoot, scope, skills, warnings) => {
  let entries
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    const skillFile = skillsRoot + '/' + entry.name + '/' + SKILL_FILE
    const file = Bun.file(skillFile)
    if (!(await file.exists())) continue
    const markdown = await file.text()
    const frontmatter = parseFrontmatter(markdown)
    if (frontmatter === null) {
      warnings.push('Skipped skill "' + entry.name + '" at ' + skillFile + ': unparseable YAML frontmatter')
      continue
    }
    const name = frontmatter.name
    const description = frontmatter.description
    if (typeof name !== 'string' || name.length === 0) {
      warnings.push('Skipped skill at ' + skillFile + ': missing or empty name')
      continue
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      warnings.push('Skipped skill "' + name + '" at ' + skillFile + ': missing or empty description')
      continue
    }
    if (name !== entry.name) {
      warnings.push('Skill "' + name + '" at ' + skillFile + ': name does not match parent directory "' + entry.name + '"')
    }
    if (name.length > NAME_MAX_LENGTH) {
      warnings.push('Skill "' + name + '" at ' + skillFile + ': name exceeds ' + NAME_MAX_LENGTH + ' characters')
    }
    const existing = skills.get(name)
    if (existing !== undefined && existing.scope === 'user' && scope === 'project') {
      warnings.push('Skill "' + name + '": project-level overrides user-level')
    }
    const rest = {}
    for (const key of Object.keys(frontmatter)) {
      if (key !== 'name' && key !== 'description') rest[key] = frontmatter[key]
    }
    skills.set(name, { record: { name, description, location: skillFile, ...rest }, scope })
  }
}

const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
await scanRoot(home + '/' + SKILL_DIR_NAME, 'user', skills, warnings)
await scanRoot(process.cwd() + '/' + SKILL_DIR_NAME, 'project', skills, warnings)

const sorted = [...skills.values()].map((s) => s.record).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
console.log(JSON.stringify({ skills: sorted, warnings }))
`

// ── Threads ───────────────────────────────────────────────────────────────────

/** scan-boot — once: the scan recipe is requested at boot; the tools worker pipes it. */
const skillScanBoot: Thread = {
  label: 'skill/scan-boot',
  once: true,
  rules: [
    {
      request: {
        type: WORKER_MESSAGE_KINDS.tool_call,
        detail: {
          id: SKILL_SCAN_CALL_ID,
          tool: SKILL_SCAN_TOOL,
          input: { script: 'bun run -', stdin: SKILL_SCAN_SCRIPT, format: 'json' },
        },
      },
    },
  ],
}

/** catalog — a scan result carrying a skills catalog is put into the store as one value. */
const skillCatalog: Thread = {
  label: 'skill/catalog',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.tool_call_result,
          query:
            '. as $d | select($d.result.jsonData.skills? != null) | {id: $d.id, op: "put", input: {collection: "skills", key: "catalog", value: $d.result.jsonData}}',
          target: WORKER_MESSAGE_KINDS.store_request,
          // The validate-before-put gate: the envelope schema nests under
          // jsonData — strict at the payload, loose around it (absent
          // jsonData passes and the query rejects instead).
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              result: {
                type: 'object',
                properties: { jsonData: SKILL_CATALOG_SCHEMA },
                required: ['jsonData'],
                additionalProperties: true,
              },
            },
            required: ['id', 'result'],
          },
        },
      ],
    },
  ],
}

/** The skill-client thread library — add to the program alongside the satellites. */
export const skillThreads: Thread[] = [skillScanBoot, skillCatalog]

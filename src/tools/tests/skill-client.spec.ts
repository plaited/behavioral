import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import {
  SkillDiscoverInputSchema,
  SkillDiscoverOutputSchema,
  SkillListResourcesInputSchema,
  SkillListResourcesOutputSchema,
  SkillReadInputSchema,
  SkillReadOutputSchema,
  skillDiscover,
  skillListResources,
  skillRead,
} from '../skill-client.ts'
import { ajv } from '../use-tool.ts'

const validateDiscoverInput = ajv.compile(SkillDiscoverInputSchema)
const validateDiscoverOutput = ajv.compile(SkillDiscoverOutputSchema)
const validateReadInput = ajv.compile(SkillReadInputSchema)
const validateReadOutput = ajv.compile(SkillReadOutputSchema)
const validateListResourcesInput = ajv.compile(SkillListResourcesInputSchema)
const validateListResourcesOutput = ajv.compile(SkillListResourcesOutputSchema)

const FIXTURE_PROJECT = path.resolve(import.meta.dir, 'fixtures/skills-project')
const ECHO_SKILL = path.join(FIXTURE_PROJECT, '.agents/skills/echo/SKILL.md')

describe('skill-client tools — schema contract (RED)', () => {
  test('skill-discover takes { cwd } and nothing else', () => {
    expect(validateDiscoverInput({ cwd: FIXTURE_PROJECT })).toBe(true)
    expect(validateDiscoverInput({})).toBe(false)
    expect(validateDiscoverInput({ cwd: FIXTURE_PROJECT, mode: 'discover' })).toBe(false)
  })

  test('skill-read takes { cwd, location }', () => {
    expect(validateReadInput({ cwd: FIXTURE_PROJECT, location: ECHO_SKILL })).toBe(true)
    expect(validateReadInput({ cwd: FIXTURE_PROJECT })).toBe(false)
    expect(validateReadInput({ location: ECHO_SKILL })).toBe(false)
    expect(validateReadInput({ cwd: FIXTURE_PROJECT, location: ECHO_SKILL, mode: 'read-skill' })).toBe(false)
  })

  test('skill-list-resources takes { cwd, location }', () => {
    expect(validateListResourcesInput({ cwd: FIXTURE_PROJECT, location: ECHO_SKILL })).toBe(true)
    expect(validateListResourcesInput({ cwd: FIXTURE_PROJECT })).toBe(false)
    expect(validateListResourcesInput({ location: ECHO_SKILL })).toBe(false)
  })

  test('each tool names itself distinctly', () => {
    expect(skillDiscover.name).toBe('skill-discover')
    expect(skillRead.name).toBe('skill-read')
    expect(skillListResources.name).toBe('skill-list-resources')
  })
})

describe('skill-client tool — discover (tier 1 metadata)', () => {
  test('discovers project-level skills with parsed frontmatter', async () => {
    const result = (await skillDiscover({ cwd: FIXTURE_PROJECT })) as {
      skills: { name: string; description: string; location: string; [k: string]: unknown }[]
      warnings: string[]
    }
    expect(validateDiscoverOutput(result)).toBe(true)
    const names = result.skills.map((s) => s.name)
    expect(names).toContain('echo')
    const echo = result.skills.find((s) => s.name === 'echo')!
    expect(echo.description).toBe('Echo back messages for testing skill discovery.')
    expect(echo.location).toBe(ECHO_SKILL)
    // Optional frontmatter fields pass through.
    expect(echo.license).toBe('ISC')
  })

  test('skips skills with unparseable YAML and records a warning', async () => {
    const result = (await skillDiscover({ cwd: FIXTURE_PROJECT })) as {
      skills: { name: string }[]
      warnings: string[]
    }
    const names = result.skills.map((s) => s.name)
    expect(names).not.toContain('broken-yaml')
    expect(result.warnings.some((w) => w.includes('broken-yaml'))).toBe(true)
  })

  test('skips skills with a missing/empty description and records a warning', async () => {
    const result = (await skillDiscover({ cwd: FIXTURE_PROJECT })) as {
      skills: { name: string }[]
      warnings: string[]
    }
    const names = result.skills.map((s) => s.name)
    expect(names).not.toContain('no-desc')
    expect(result.warnings.some((w) => w.includes('no-desc'))).toBe(true)
  })

  test('project-level skills override user-level skills with the same name', async () => {
    // The echo skill exists at both project and user level (~/.agents/skills/
    // has no echo, so we verify precedence indirectly: project echo is present
    // and uniquely identified by its project location).
    const result = (await skillDiscover({ cwd: FIXTURE_PROJECT })) as {
      skills: { name: string; location: string }[]
    }
    const echoes = result.skills.filter((s) => s.name === 'echo')
    expect(echoes).toHaveLength(1)
    expect(echoes[0]!.location).toBe(ECHO_SKILL)
  })
})

describe('skill-client tool — read-skill (tier 2 full instructions)', () => {
  test('returns the SKILL.md body with frontmatter stripped', async () => {
    const result = (await skillRead({ cwd: FIXTURE_PROJECT, location: ECHO_SKILL })) as {
      name: string
      body: string
    }
    expect(validateReadOutput(result)).toBe(true)
    expect(result.name).toBe('echo')
    // Body starts with the heading, not the frontmatter delimiter.
    expect(result.body.startsWith('---')).toBe(false)
    expect(result.body).toContain('# Echo Skill')
    expect(result.body).toContain('scripts/echo.ts')
  })

  test('returns an error when the location does not exist', async () => {
    const result = (await skillRead({
      cwd: FIXTURE_PROJECT,
      location: path.join(FIXTURE_PROJECT, '.agents/skills/missing/SKILL.md'),
    })) as { isError?: boolean; message?: string }
    expect(result.isError).toBe(true)
    expect(result.message).toBeDefined()
  })
})

describe('skill-client tool — list-resources (tier 3 bundled-resource preview)', () => {
  test('enumerates bundled files in the skill directory without reading them', async () => {
    const result = (await skillListResources({
      cwd: FIXTURE_PROJECT,
      location: ECHO_SKILL,
    })) as { resources: { name: string; type: string }[] }
    expect(validateListResourcesOutput(result)).toBe(true)
    const names = result.resources.map((r) => r.name)
    // Directory entries are included; SKILL.md (the instructions) is not.
    expect(names).toContain('scripts')
    expect(names).toContain('references')
    expect(names).not.toContain('SKILL.md')
  })

  test('resources under subdirectories are enumerated as relative paths', async () => {
    const result = (await skillListResources({
      cwd: FIXTURE_PROJECT,
      location: ECHO_SKILL,
    })) as { resources: { name: string; type: string }[] }
    // Walk the skill dir tree — files appear as relative paths.
    const scriptFile = result.resources.find((r) => r.name === 'scripts/echo.ts')
    const refFile = result.resources.find((r) => r.name === 'references/notes.md')
    expect(scriptFile).toBeDefined()
    expect(scriptFile!.type).toBe('file')
    expect(refFile).toBeDefined()
    expect(refFile!.type).toBe('file')
  })
})

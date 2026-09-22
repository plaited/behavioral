import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { ajv } from '../define-tool.ts'
import {
  SkillDiscoverInputSchema,
  SkillDiscoverOutputSchema,
  SkillListResourcesInputSchema,
  SkillListResourcesOutputSchema,
  SkillReadInputSchema,
  SkillReadOutputSchema,
  skillDiscover as skillDiscoverBinder,
  skillExtractLinks as skillExtractLinksBinder,
  skillListResources as skillListResourcesBinder,
  skillRead as skillReadBinder,
  skillValidateLinks as skillValidateLinksBinder,
} from '../skill-client.ts'

// Defined once, bound late — the test context carries no capabilities.
const skillDiscover = skillDiscoverBinder(undefined)
const skillRead = skillReadBinder(undefined)
const skillListResources = skillListResourcesBinder(undefined)
const skillExtractLinks = skillExtractLinksBinder(undefined)
const skillValidateLinks = skillValidateLinksBinder(undefined)

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

// ---------------------------------------------------------------------------
// skill-extract-links — local markdown link extraction (ported from the old
// src/cli/markdown.ts extract-links mode)
// ---------------------------------------------------------------------------

describe('skill-client — skill-extract-links', () => {
  test('tool contract: kebab name and link-extraction description', () => {
    expect(skillExtractLinks.name).toBe('skill-extract-links')
    expect(skillExtractLinks.description.toLowerCase()).toContain('link')
  })

  test('returns sorted, de-duplicated local links with display text', async () => {
    const output = (await skillExtractLinks({
      markdown: 'See [b](scripts/b.ts) and [a](scripts/a.ts) ![d](assets/d.png) [a again](scripts/a.ts)',
    })) as { links: unknown[] }
    expect(output.links).toEqual([
      { value: 'assets/d.png', text: 'd' },
      { value: 'scripts/a.ts', text: 'a' },
      { value: 'scripts/b.ts', text: 'b' },
    ])
  })

  test('drops external and fragment-only links; keeps inline HTML', async () => {
    const output = (await skillExtractLinks({
      markdown:
        '[site](https://example.com) [mail](mailto:a@b.c) [frag](#section) <a href="docs/guide.md">guide</a> <img src="assets/logo.png" alt="logo">',
    })) as { links: unknown[] }
    expect(output.links).toEqual([
      { value: 'assets/logo.png', text: 'logo' },
      { value: 'docs/guide.md', text: 'guide' },
    ])
  })

  test('empty result for markdown with no local links', async () => {
    const output = (await skillExtractLinks({ markdown: 'No links here, just text.' })) as { links: unknown[] }
    expect(output.links).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// skill-validate-links — resolve local links against a cwd (ported from the
// old src/cli/markdown.ts validate-links mode)
// ---------------------------------------------------------------------------

describe('skill-client — skill-validate-links', () => {
  const tempDir = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'behavioral-skill-links-'))

  test('tool contract: kebab name and link-validation description', () => {
    expect(skillValidateLinks.name).toBe('skill-validate-links')
    expect(skillValidateLinks.description.toLowerCase()).toContain('missing')
  })

  test('returns present and missing links resolved against cwd', async () => {
    const baseDir = await tempDir()
    try {
      await mkdir(path.join(baseDir, 'docs'), { recursive: true })
      await Bun.write(path.join(baseDir, 'docs', 'guide.md'), '# guide')

      const output = (await skillValidateLinks({
        cwd: baseDir,
        markdownBody: 'See [guide](docs/guide.md) and [missing](docs/missing.md)',
      })) as { present: unknown[]; missing: unknown[] }
      expect(output.present).toEqual([{ value: 'docs/guide.md', text: 'guide' }])
      expect(output.missing).toEqual([{ value: 'docs/missing.md', text: 'missing' }])
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test('rootRelative resolves leading-slash links against cwd', async () => {
    const baseDir = await tempDir()
    try {
      await mkdir(path.join(baseDir, 'tables'), { recursive: true })
      await Bun.write(path.join(baseDir, 'tables', 'customers.md'), '# customers')

      const output = (await skillValidateLinks({
        cwd: baseDir,
        markdownBody: 'See [customers](/tables/customers.md) and [gone](/tables/gone.md)',
        rootRelative: true,
      })) as { present: unknown[]; missing: unknown[] }
      expect(output.present).toEqual([{ value: '/tables/customers.md', text: 'customers' }])
      expect(output.missing).toEqual([{ value: '/tables/gone.md', text: 'gone' }])
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test('without rootRelative, leading-slash links resolve against the filesystem root (legacy)', async () => {
    const baseDir = await tempDir()
    try {
      await mkdir(path.join(baseDir, 'tables'), { recursive: true })
      await Bun.write(path.join(baseDir, 'tables', 'customers.md'), '# customers')

      const output = (await skillValidateLinks({
        cwd: baseDir,
        markdownBody: 'See [customers](/tables/customers.md)',
      })) as { present: unknown[]; missing: unknown[] }
      expect(output.present).toEqual([])
      expect(output.missing).toEqual([{ value: '/tables/customers.md', text: 'customers' }])
    } finally {
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})

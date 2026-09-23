import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../load-config.ts'

const withConfig = async (source: string | undefined, run: (path: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'behavioral-config-'))
  const file = join(dir, 'config.ts')
  try {
    if (source !== undefined) await Bun.write(file, source)
    await run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('loadConfig', () => {
  test('a missing config file yields the empty config (defaults apply)', async () => {
    await withConfig(undefined, async (file) => {
      expect(await loadConfig(file)).toEqual({})
    })
  })

  test('a present config file yields its default export', async () => {
    await withConfig(`export default { faculties: ['shell'] }`, async (file) => {
      expect(await loadConfig(file)).toEqual({ faculties: ['shell'] })
    })
  })

  test('accepts a useFaculty-style function override', async () => {
    await withConfig(`const shell = () => 'wired'\nexport default { shell }`, async (file) => {
      const config = await loadConfig(file)
      expect(typeof config.shell).toBe('function')
    })
  })

  test('rejects a non-object default export', async () => {
    await withConfig(`export default 42`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/invalid config/)
    })
  })

  test('rejects an unknown faculty name with the allowed set', async () => {
    await withConfig(`export default { faculties: ['nope'] }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/unknown faculty "nope".*expected one of: shell, store, mcp/)
    })
  })

  test('defaults to <BEHAVIORAL_HOME>/config.ts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'behavioral-home-'))
    const previous = process.env.BEHAVIORAL_HOME
    process.env.BEHAVIORAL_HOME = home
    try {
      await Bun.write(join(home, 'config.ts'), `export default { faculties: ['store'] }`)
      expect(await loadConfig()).toEqual({ faculties: ['store'] })
    } finally {
      if (previous === undefined) delete process.env.BEHAVIORAL_HOME
      else process.env.BEHAVIORAL_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('an unloadable config fails fast with the path', async () => {
    await withConfig(`export default {`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/failed to load/)
    })
  })

  test('rejects a non-function shell override', async () => {
    await withConfig(`export default { shell: 'not-a-function' }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/shell/)
    })
  })
})

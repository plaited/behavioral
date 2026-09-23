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
    await withConfig(`export default { behaviors: ['responses'] }`, async (file) => {
      expect(await loadConfig(file)).toEqual({ behaviors: ['responses'] })
    })
  })

  test('accepts a useBehavior-style function override', async () => {
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

  test('rejects an unknown behavior name', async () => {
    await withConfig(`export default { behaviors: ['nope'] }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/nope/)
    })
  })

  test('rejects a non-function shell override', async () => {
    await withConfig(`export default { shell: 'not-a-function' }`, async (file) => {
      await expect(loadConfig(file)).rejects.toThrow(/shell/)
    })
  })
})

import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../../..')
const binPath = path.join(repoRoot, 'bin/behavioral.ts')

const runInit = async (
  args: string[],
  cwd = repoRoot,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(['bun', binPath, 'init', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

describe('behavioral init — home-skeleton-only provisioning', () => {
  test('--help exits 0 and documents idempotent home provisioning', async () => {
    const { code, stderr } = await runInit(['--help'])
    expect(code).toBe(0)
    expect(stderr).toContain('Usage: init')
    expect(stderr).toContain('~/.behavioral')
  })

  test('--schema input emits the input JSON schema', async () => {
    const { code, stdout } = await runInit(['--schema', 'input'])
    expect(code).toBe(0)
    const schema = JSON.parse(stdout)
    expect(schema.type).toBe('object')
    // plugin install and you-web auth died with src/plugin — the input is empty
    expect(schema.properties).toEqual({})
    expect(schema.additionalProperties).toBe(false)
  })

  test('provisions the ~/.behavioral home idempotently (HOME overridden)', async () => {
    const tmpHome = path.resolve((await Bun.$`mktemp -d`.quiet().text()).trim())
    try {
      const { code, stdout } = await runInit([JSON.stringify({})], repoRoot, { HOME: tmpHome })
      expect(code).toBe(0)
      const result = JSON.parse(stdout)
      const homeRoot = path.join(tmpHome, '.behavioral')
      expect(result.home.root).toBe(homeRoot)
      expect(result.home.gitInitialized).toBe(true)
      expect(result.home.configSeeded).toBe(true)
      expect((await Bun.$`test -d ${path.join(homeRoot, 'root', 'threads')}`.quiet()).exitCode).toBe(0)
      expect((await Bun.$`test -d ${path.join(homeRoot, 'root', 'html')}`.quiet()).exitCode).toBe(0)
      expect((await Bun.$`test -d ${path.join(homeRoot, 'root', 'logs', 'archive')}`.quiet()).exitCode).toBe(0)
      expect(await Bun.file(path.join(homeRoot, '.gitignore')).text()).toBe('db.sqlite\nlogs/\n')
      expect(JSON.parse(await Bun.file(path.join(homeRoot, 'config.json')).text())).toEqual({ models: [] })
      // the at-provisioning reconcile scan ran and is reported
      expect(result.scan.spaces).toContain('root')
      expect(typeof result.scan.created).toBe('number')
      // no plugin install — the growth model has no bundled plugin
      expect(result.installed).toBeUndefined()

      // second run: provisioning is idempotent and reports nothing new
      const second = await runInit([JSON.stringify({})], repoRoot, { HOME: tmpHome })
      expect(second.code).toBe(0)
      const secondResult = JSON.parse(second.stdout)
      expect(secondResult.isError).toBeUndefined()
      expect(secondResult.home.gitInitialized).toBe(false)
      expect(secondResult.home.configSeeded).toBe(false)
      expect(secondResult.scan.spaces).toContain('root')
    } finally {
      await Bun.$`rm -rf ${tmpHome}`.quiet().nothrow()
    }
  })

  test('init command is registered in the router --schema listing', async () => {
    const proc = Bun.spawn(['bun', binPath, '--schema'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: repoRoot,
    })
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code).toBe(0)
    const listing = JSON.parse(out) as { commands: string[] }
    expect(listing.commands).toContain('init')
    expect(listing.commands).toContain('turn')
  })
})

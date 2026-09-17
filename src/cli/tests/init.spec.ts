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

describe('behavioral init', () => {
  test('--help exits 0 and documents force', async () => {
    const { code, stderr } = await runInit(['--help'])
    expect(code).toBe(0)
    expect(stderr).toContain('Usage: init')
    expect(stderr).toContain('force')
  })

  test('--schema input emits the input JSON schema with scope and force', async () => {
    const { code, stdout } = await runInit(['--schema', 'input'])
    expect(code).toBe(0)
    const schema = JSON.parse(stdout)
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('scope')
    expect(schema.properties).toHaveProperty('force')
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

      // second run: already-installed plugin errors, but home provisioning
      // is idempotent and reports nothing new
      const second = await runInit([JSON.stringify({})], repoRoot, { HOME: tmpHome })
      expect(second.code).toBe(0)
      const secondResult = JSON.parse(second.stdout)
      expect(secondResult.isError).toBe(true)
      expect(secondResult.home.gitInitialized).toBe(false)
      expect(secondResult.home.configSeeded).toBe(false)
      expect(secondResult.scan.spaces).toContain('root')
    } finally {
      await Bun.$`rm -rf ${tmpHome}`.quiet().nothrow()
    }
  })

  test('installs to project scope and copies plugin.json + skills/ + mcp.json', async () => {
    const tmpDir = path.resolve((await Bun.$`mktemp -d`.quiet().text()).trim())
    try {
      const { code, stdout } = await runInit([JSON.stringify({ scope: 'project' })], tmpDir)
      expect(code).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.scope).toBe('project')
      expect(result.force).toBe(false)
      expect(result.auth).toBe('unresolved')
      expect(result.installed).toContain('.agents/plugins/behavioral')
      expect(await Bun.file(path.join(result.installed, 'plugin.json')).exists()).toBe(true)
      // portable-only manifest: no client-extension block installed
      const installedManifest = JSON.parse(await Bun.file(path.join(result.installed, 'plugin.json')).text())
      expect(installedManifest).not.toHaveProperty('extensions')
      expect(await Bun.file(path.join(result.installed, 'mcp.json')).exists()).toBe(true)
      expect(await Bun.file(path.join(result.installed, 'skills', 'behavioral', 'SKILL.md')).exists()).toBe(true)
    } finally {
      await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow()
    }
  })
})

test('re-run without force returns isError', async () => {
  const tmpDir = path.resolve((await Bun.$`mktemp -d`.quiet().text()).trim())
  try {
    const first = await runInit([JSON.stringify({ scope: 'project' })], tmpDir)
    expect(first.code).toBe(0)
    const second = await runInit([JSON.stringify({ scope: 'project' })], tmpDir)
    expect(second.code).toBe(0)
    const result = JSON.parse(second.stdout)
    expect(result.isError).toBe(true)
    expect(result.message).toContain('force')
  } finally {
    await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow()
  }
})

test('re-run with force overwrites and reports force: true', async () => {
  const tmpDir = path.resolve((await Bun.$`mktemp -d`.quiet().text()).trim())
  try {
    const first = await runInit([JSON.stringify({ scope: 'project' })], tmpDir)
    expect(first.code).toBe(0)
    const second = await runInit([JSON.stringify({ scope: 'project', force: true })], tmpDir)
    expect(second.code).toBe(0)
    const result = JSON.parse(second.stdout)
    expect(result.isError).toBeUndefined()
    expect(result.force).toBe(true)
  } finally {
    await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow()
  }
})

test('installed plugin parses via the conformant plugin-client', async () => {
  const tmpDir = path.resolve((await Bun.$`mktemp -d`.quiet().text()).trim())
  try {
    const { code, stdout } = await runInit([JSON.stringify({ scope: 'project' })], tmpDir)
    expect(code).toBe(0)
    const result = JSON.parse(stdout)
    const { pluginClient } = await import('../../tools/plugin-client.ts')
    const manifest = await pluginClient({ path: 'plugin.json', cwd: result.installed })
    expect('isError' in manifest).toBe(false)
    if (!('isError' in manifest)) {
      expect(manifest.name).toBe('behavioral')
      expect(manifest.skills).toContain('behavioral')
      // portable-only output shape: no models/spaces fields
      expect('models' in manifest).toBe(false)
      expect('spaces' in manifest).toBe(false)
    }
  } finally {
    await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow()
  }
})

test('--dry-run shows the request without installing', async () => {
  const tmpDir = path.resolve((await Bun.$`mktemp -d`.quiet().text()).trim())
  try {
    const { code, stdout } = await runInit([JSON.stringify({ scope: 'project' }), '--dry-run'], tmpDir)
    expect(code).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.command).toBe('init')
    expect(result.input.scope).toBe('project')
    expect(result.dryRun).toBe(true)
    // Nothing should have been installed
    expect(await Bun.file(path.join(tmpDir, '.agents', 'plugins', 'behavioral', 'plugin.json')).exists()).toBe(false)
  } finally {
    await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow()
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

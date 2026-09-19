import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../../..')
const binPath = path.join(repoRoot, 'bin/behavioral.ts')

const runTools = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(['bun', binPath, 'tools', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: repoRoot,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

describe('behavioral tools', () => {
  test('--help exits 0 and lists fleet tools with descriptions', async () => {
    const { code, stderr } = await runTools(['--help'])

    expect(code).toBe(0)
    expect(stderr).toContain('Usage: tools')
    expect(stderr).toContain('git-status')
    expect(stderr).toContain('git-history')
    expect(stderr).toContain('git-worktrees')
    expect(stderr).toContain('git-context')
    expect(stderr).toContain('typescript-execute')
    expect(stderr).toContain('typescript-discover')
    expect(stderr).toContain('plugin-client')
    expect(stderr).toContain('skill-extract-links')
    expect(stderr).toContain('skill-validate-links')
  })

  test('bare --schema prints the fleet index with name + description per tool', async () => {
    const { code, stdout } = await runTools(['--schema'])

    expect(code).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.command).toBe('tools')
    expect(Array.isArray(output.tools)).toBe(true)
    expect(output.tools.length).toBeGreaterThanOrEqual(32)
    const gitHistory = output.tools.find((t: { name: string }) => t.name === 'git-history')
    expect(gitHistory?.description).toBeString()
    const names = output.tools.map((t: { name: string }) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('--schema input --tool git-history resolves the tool input schema', async () => {
    const { code, stdout } = await runTools(['--schema', 'input', '--tool', 'git-history'])

    expect(code).toBe(0)
    const schema = JSON.parse(stdout)
    expect(schema.properties).toHaveProperty('base')
    expect(schema.properties).toHaveProperty('paths')
  })

  test('--schema output --tool typescript-lsp-discover resolves the tool output schema', async () => {
    const { code, stdout } = await runTools(['--schema', 'output', '--tool', 'typescript-discover'])

    expect(code).toBe(0)
    const schema = JSON.parse(stdout)
    expect(schema.properties).toHaveProperty('capabilities')
  })

  test('--schema input without --tool prints the dispatch envelope schema', async () => {
    const { code, stdout } = await runTools(['--schema', 'input'])

    expect(code).toBe(0)
    const schema = JSON.parse(stdout)
    expect(schema.properties).toHaveProperty('tool')
    expect(schema.properties).toHaveProperty('input')
  })

  test('--schema input --tool <unknown> exits 2', async () => {
    const { code, stderr } = await runTools(['--schema', 'input', '--tool', 'nope'])

    expect(code).toBe(2)
    expect(stderr).toContain('Unknown tool')
  })

  test('invokes a tool by name and prints its validated output', async () => {
    const { code, stdout } = await runTools([JSON.stringify({ tool: 'typescript-discover', input: {} })])

    expect(code).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.capabilities.length).toBeGreaterThan(0)
  })

  test('applies declared input defaults at dispatch (git-history)', async () => {
    const { code, stdout } = await runTools([
      JSON.stringify({ tool: 'git-history', input: { cwd: repoRoot, base: 'dev' } }),
    ])

    expect(code).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.paths).toEqual([])
    expect(output.summary.commitCountSinceBase).toBeGreaterThanOrEqual(0)
  })

  test('rejects an unknown tool name with exit 2', async () => {
    const { code } = await runTools([JSON.stringify({ tool: 'nope', input: {} })])

    expect(code).toBe(2)
  })

  test('rejects input that fails the named tool input schema with exit 2', async () => {
    const { code, stderr } = await runTools([JSON.stringify({ tool: 'git-history', input: { cwd: repoRoot } })])

    expect(code).toBe(2)
    expect(stderr).toContain('required')
  })

  test('--dry-run prints the dispatch envelope without executing', async () => {
    const { code, stdout } = await runTools([JSON.stringify({ tool: 'typescript-discover', input: {} }), '--dry-run'])

    expect(code).toBe(0)
    const output = JSON.parse(stdout)
    expect(output).toEqual({
      command: 'tools',
      input: { tool: 'typescript-discover', input: {} },
      dryRun: true,
    })
  })
})

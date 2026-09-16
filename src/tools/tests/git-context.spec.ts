import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type GitContextToolOutput, gitContext } from '../git-context.ts'
import { ajv } from '../use-tool.ts'

const tempDirs: string[] = []

const trackTempDir = (path: string): string => {
  tempDirs.push(path)
  return path
}

const runGit = async ({ cwd, args }: { cwd: string; args: string[] }): Promise<void> => {
  const result = await Bun.$`git ${args}`.cwd(cwd).quiet().nothrow()
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim()
    const stdout = result.stdout.toString().trim()
    throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout || `exit ${result.exitCode}`}`)
  }
}

const writeFile = async ({ cwd, path, content }: { cwd: string; path: string; content: string }): Promise<void> => {
  const absolutePath = join(cwd, path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await Bun.write(absolutePath, content)
}

const createTempGitRepo = async (): Promise<string> => {
  const rootDir = trackTempDir(await mkdtemp(join(tmpdir(), 'behavioral-git-tool-')))
  await runGit({ cwd: rootDir, args: ['init'] })
  await runGit({ cwd: rootDir, args: ['config', 'user.email', 'behavioral-git@example.com'] })
  await runGit({ cwd: rootDir, args: ['config', 'user.name', 'Behavioral Git Test'] })
  await runGit({ cwd: rootDir, args: ['config', 'commit.gpgsign', 'false'] })
  await runGit({ cwd: rootDir, args: ['checkout', '-b', 'dev'] })

  await writeFile({ cwd: rootDir, path: 'README.md', content: '# temp\n' })
  await runGit({ cwd: rootDir, args: ['add', '.'] })
  await runGit({ cwd: rootDir, args: ['commit', '-m', 'chore: baseline'] })
  await runGit({ cwd: rootDir, args: ['checkout', '-b', 'feature/git-tool'] })
  await writeFile({
    cwd: rootDir,
    path: 'src/tracked.ts',
    content: `export const tracked = 'initial'\n`,
  })
  await runGit({ cwd: rootDir, args: ['add', 'src/tracked.ts'] })
  await runGit({ cwd: rootDir, args: ['commit', '-m', 'feat: add tracked file'] })

  return rootDir
}

const compileInput = () => ajv.compile(gitContext.inputSchema)

/** Branch-assert then narrow — same pattern as plugin-loader.spec.ts. */
const ofMode = <M extends GitContextToolOutput['mode']>(
  output: GitContextToolOutput,
  expected: M,
): Extract<GitContextToolOutput, { mode: M }> => {
  if (output.mode !== expected) {
    throw new Error(`expected mode '${expected}', got '${output.mode}'`)
  }
  return output as Extract<GitContextToolOutput, { mode: M }>
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop()
    if (path) {
      await rm(path, { recursive: true, force: true })
    }
  }
})

describe('gitContext', () => {
  test('tool contract: kebab name and a description covering all four modes', () => {
    expect(gitContext.name).toBe('git-context')
    const description = gitContext.description.toLowerCase()
    expect(description).toContain('status')
    expect(description).toContain('history')
    expect(description).toContain('worktrees')
    expect(description).toContain('context')
  })

  test('mode=status reports staged, unstaged, and untracked files', async () => {
    const repoRoot = await createTempGitRepo()
    const canonicalRepoRoot = await realpath(repoRoot)

    await writeFile({
      cwd: repoRoot,
      path: 'src/staged.ts',
      content: `export const staged = true\n`,
    })
    await runGit({ cwd: repoRoot, args: ['add', 'src/staged.ts'] })
    await writeFile({
      cwd: repoRoot,
      path: 'src/tracked.ts',
      content: `export const tracked = 'modified'\n`,
    })
    await writeFile({
      cwd: repoRoot,
      path: 'tmp-untracked.txt',
      content: 'untracked\n',
    })

    const output = ofMode(await gitContext({ mode: 'status', cwd: repoRoot }), 'status')
    expect(output.ok).toBe(true)
    expect(output.repoRoot).toBe(canonicalRepoRoot)
    expect(output.dirty.isDirty).toBeTrue()
    expect(output.dirty.stagedFiles).toContain('src/staged.ts')
    expect(output.dirty.unstagedFiles).toContain('src/tracked.ts')
    expect(output.dirty.untrackedFiles).toContain('tmp-untracked.txt')
  })

  test('input schema rejects mode=history without base', () => {
    const validate = compileInput()
    const valid = validate({ mode: 'history', cwd: '/tmp' })
    expect(valid).toBeFalse()
  })

  test('mode=worktrees returns current worktree and parsed entries', async () => {
    const repoRoot = await createTempGitRepo()
    const output = ofMode(await gitContext({ mode: 'worktrees', cwd: repoRoot }), 'worktrees')

    expect(output.ok).toBe(true)
    expect(output.currentWorktree).toBe('.')
    expect(output.worktrees.length).toBeGreaterThanOrEqual(1)
    expect(output.worktrees.some((entry) => entry.isCurrent)).toBeTrue()
    expect(output.worktrees.every((entry) => entry.exists)).toBeTrue()
  })

  test('mode=context omits worktrees unless includeWorktrees is true', async () => {
    const repoRoot = await createTempGitRepo()

    const defaultOutput = ofMode(await gitContext({ mode: 'context', cwd: repoRoot, base: 'dev' }), 'context')
    expect(defaultOutput.worktrees).toHaveLength(0)
    expect(defaultOutput.summary.worktreeCount).toBe(0)

    const withWorktreesOutput = ofMode(
      await gitContext({
        mode: 'context',
        cwd: repoRoot,
        base: 'dev',
        includeWorktrees: true,
      }),
      'context',
    )
    expect(withWorktreesOutput.worktrees.length).toBeGreaterThanOrEqual(1)
    expect(withWorktreesOutput.summary.worktreeCount).toBeGreaterThanOrEqual(1)
  })

  test('mode=history rejects paths that escape repository root', async () => {
    const repoRoot = await createTempGitRepo()
    const promise = gitContext({
      mode: 'history',
      cwd: repoRoot,
      base: 'dev',
      paths: ['../escape.ts'],
    })

    await expect(promise).rejects.toThrow('path escapes repository root')
  })

  test('file lists are capped at 200 entries with truncation warnings', async () => {
    const repoRoot = await createTempGitRepo()

    for (let index = 0; index < 205; index += 1) {
      await writeFile({
        cwd: repoRoot,
        path: `tmp/untracked-${index}.txt`,
        content: `file-${index}\n`,
      })
    }

    const output = ofMode(await gitContext({ mode: 'status', cwd: repoRoot }), 'status')

    expect(output.dirty.untrackedCount).toBe(205)
    expect(output.dirty.untrackedFiles).toHaveLength(200)
    expect(output.warnings.some((warning) => warning.includes('truncated to 200'))).toBeTrue()
  })

  test('mode=history returns merge-base history for supplied base', async () => {
    const repoRoot = await createTempGitRepo()
    const output = ofMode(
      await gitContext({
        mode: 'history',
        cwd: repoRoot,
        base: 'dev',
        paths: ['src/tracked.ts'],
        limit: 20,
      }),
      'history',
    )
    expect(output.base).toBe('dev')
    expect(output.baseHead).not.toBeNull()
    expect(output.mergeBase).not.toBeNull()
    expect(output.summary.commitCountSinceBase).toBeGreaterThanOrEqual(1)
    expect(output.summary.changedFileCountSinceBase).toBeGreaterThanOrEqual(1)
    expect(output.changedFilesSinceBase.some((entry) => entry.path === 'src/tracked.ts')).toBeTrue()
    expect(output.pathHistory).toHaveLength(1)
    expect(output.pathHistory[0]?.path).toBe('src/tracked.ts')
    expect(output.pathHistory[0]?.commits.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  test('status preserves unquoted paths with spaces', async () => {
    const repoRoot = await createTempGitRepo()
    await writeFile({
      cwd: repoRoot,
      path: 'src/space name.ts',
      content: `export const spaced = true\n`,
    })

    const output = ofMode(await gitContext({ mode: 'status', cwd: repoRoot }), 'status')

    expect(output.dirty.untrackedFiles).toContain('src/space name.ts')
    expect(output.dirty.untrackedFiles).not.toContain('"src/space name.ts"')
  })

  test('input schema is a oneOf across all four modes with declared defaults', () => {
    const schema = gitContext.inputSchema as { oneOf?: Array<{ properties?: Record<string, { default?: unknown }> }> }
    expect(schema.oneOf).toHaveLength(4)
    const historyBranch = schema.oneOf?.find((branch) => Object.hasOwn(branch.properties ?? {}, 'base'))
    expect(historyBranch).toBeDefined()
    expect(historyBranch?.properties?.paths?.default).toEqual([])
    expect(historyBranch?.properties?.limit?.default).toBe(20)
    const contextBranch = schema.oneOf?.find((branch) => Object.hasOwn(branch.properties ?? {}, 'includeWorktrees'))
    expect(contextBranch?.properties?.includeWorktrees?.default).toBe(false)
  })

  test('output schema is a oneOf across all four mode outputs', () => {
    const schema = gitContext.outputSchema as { oneOf?: unknown[] }
    expect(schema.oneOf).toHaveLength(4)
  })
})

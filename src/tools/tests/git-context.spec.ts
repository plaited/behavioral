import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitContext, gitHistory, gitStatus, gitWorktrees } from '../git-context.ts'
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

const propertyOf = (tool: { inputSchema: object }, name: string) =>
  (tool.inputSchema as { properties?: Record<string, unknown> }).properties?.[name]

afterEach(async () => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop()
    if (path) {
      await rm(path, { recursive: true, force: true })
    }
  }
})

describe('gitStatus', () => {
  test('tool contract: kebab name and a status-flavored description', () => {
    expect(gitStatus.name).toBe('git-status')
    expect(gitStatus.description.toLowerCase()).toContain('untracked')
  })

  test('reports staged, unstaged, and untracked files', async () => {
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

    const output = await gitStatus({ cwd: repoRoot })
    expect(output.ok).toBe(true)
    expect(output.repoRoot).toBe(canonicalRepoRoot)
    expect(output.dirty.isDirty).toBeTrue()
    expect(output.dirty.stagedFiles).toContain('src/staged.ts')
    expect(output.dirty.unstagedFiles).toContain('src/tracked.ts')
    expect(output.dirty.untrackedFiles).toContain('tmp-untracked.txt')
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

    const output = await gitStatus({ cwd: repoRoot })

    expect(output.dirty.untrackedCount).toBe(205)
    expect(output.dirty.untrackedFiles).toHaveLength(200)
    expect(output.warnings.some((warning) => warning.includes('truncated to 200'))).toBeTrue()
  })

  test('preserves unquoted paths with spaces', async () => {
    const repoRoot = await createTempGitRepo()
    await writeFile({
      cwd: repoRoot,
      path: 'src/space name.ts',
      content: `export const spaced = true\n`,
    })

    const output = await gitStatus({ cwd: repoRoot })

    expect(output.dirty.untrackedFiles).toContain('src/space name.ts')
    expect(output.dirty.untrackedFiles).not.toContain('"src/space name.ts"')
  })
})

describe('gitHistory', () => {
  test('tool contract: kebab name and a history-flavored description', () => {
    expect(gitHistory.name).toBe('git-history')
    expect(gitHistory.description.toLowerCase()).toContain('merge-base')
  })

  test('input schema requires base and declares paths/limit defaults', () => {
    const validate = ajv.compile(gitHistory.inputSchema)
    expect(validate({})).toBeFalse()
    expect(propertyOf(gitHistory, 'paths')).toMatchObject({ default: [] })
    expect(propertyOf(gitHistory, 'limit')).toMatchObject({ default: 20 })
  })

  test('returns merge-base history for supplied base', async () => {
    const repoRoot = await createTempGitRepo()
    const output = await gitHistory({ cwd: repoRoot, base: 'dev', paths: ['src/tracked.ts'], limit: 20 })

    expect(output.ok).toBe(true)
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

  test('rejects paths that escape repository root', async () => {
    const repoRoot = await createTempGitRepo()
    await expect(gitHistory({ cwd: repoRoot, base: 'dev', paths: ['../escape.ts'] })).rejects.toThrow(
      'path escapes repository root',
    )
  })
})

describe('gitWorktrees', () => {
  test('tool contract: kebab name and a worktree-flavored description', () => {
    expect(gitWorktrees.name).toBe('git-worktrees')
    expect(gitWorktrees.description.toLowerCase()).toContain('worktree')
  })

  test('returns current worktree and parsed entries', async () => {
    const repoRoot = await createTempGitRepo()
    const output = await gitWorktrees({ cwd: repoRoot })

    expect(output.ok).toBe(true)
    expect(output.currentWorktree).toBe('.')
    expect(output.worktrees.length).toBeGreaterThanOrEqual(1)
    expect(output.worktrees.some((entry) => entry.isCurrent)).toBeTrue()
    expect(output.worktrees.every((entry) => entry.exists)).toBeTrue()
  })
})

describe('gitContext', () => {
  test('tool contract: kebab name and a combined-context description', () => {
    expect(gitContext.name).toBe('git-context')
    expect(gitContext.description.toLowerCase()).toContain('status')
    expect(gitContext.description.toLowerCase()).toContain('history')
  })

  test('input schema requires base and declares includeWorktrees default', () => {
    const validate = ajv.compile(gitContext.inputSchema)
    expect(validate({})).toBeFalse()
    expect(propertyOf(gitContext, 'includeWorktrees')).toMatchObject({ default: false })
  })

  test('omits worktrees unless includeWorktrees is true', async () => {
    const repoRoot = await createTempGitRepo()

    const defaultOutput = await gitContext({ cwd: repoRoot, base: 'dev' })
    expect(defaultOutput.ok).toBe(true)
    expect(defaultOutput.worktrees).toHaveLength(0)
    expect(defaultOutput.summary.worktreeCount).toBe(0)

    const withWorktreesOutput = await gitContext({ cwd: repoRoot, base: 'dev', includeWorktrees: true })
    expect(withWorktreesOutput.worktrees.length).toBeGreaterThanOrEqual(1)
    expect(withWorktreesOutput.summary.worktreeCount).toBeGreaterThanOrEqual(1)
  })
})

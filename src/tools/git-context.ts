/**
 * Structured git context tools.
 *
 * @remarks
 * Four `useTool` units — git-status, git-history, git-worktrees, and the
 * combined git-context — returning structured JSON instead of raw git
 * output so agents can consume results directly without parsing.
 *
 * Ported from the removed `src/cli/git-context.ts` (Zod CLI): same logic and
 * output shapes minus the old `mode` discriminant, which the per-tool split
 * makes redundant.
 *
 * @internal
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { JSONSchemaType } from 'ajv'
import { useTool } from './use-tool.ts'

// ============================================================================
// Constants
// ============================================================================

export const GIT_STATUS_TOOL_NAME = 'git-status'
export const GIT_HISTORY_TOOL_NAME = 'git-history'
export const GIT_WORKTREES_TOOL_NAME = 'git-worktrees'
export const GIT_CONTEXT_TOOL_NAME = 'git-context'

const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 200
const MAX_FILE_LIST_ENTRIES = 200
const BROAD_CHANGED_FILE_THRESHOLD = 80
const BROAD_COMMIT_THRESHOLD = 40

// ============================================================================
// Types
// ============================================================================

class GitCommandError extends Error {
  readonly command: string
  readonly exitCode: number
  readonly stderr: string

  constructor({ command, exitCode, stderr }: { command: string; exitCode: number; stderr: string }) {
    super(`Git command failed (${exitCode}): ${command}`)
    this.command = command
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

type GitResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type WorktreeAccumulator = {
  path: string
  head: string
  branch: string | null
  detached: boolean
  bare: boolean
  lockedReason: string | null
  prunableReason: string | null
}

export type GitChangedFile = {
  status: 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'X'
  rawStatus: string
  path: string
  oldPath?: string
}

export type GitCommit = {
  fullSha: string
  shortSha: string
  committedAt: string
  subject: string
}

export type GitPathHistoryEntry = {
  path: string
  commits: GitCommit[]
}

export type GitWorktreeEntry = {
  path: string
  head: string
  branch: string | null
  detached: boolean
  bare: boolean
  lockedReason: string | null
  prunableReason: string | null
  exists: boolean
  isCurrent: boolean
}

export type GitDirtySummary = {
  isDirty: boolean
  stagedCount: number
  unstagedCount: number
  untrackedCount: number
  stagedFiles: string[]
  unstagedFiles: string[]
  untrackedFiles: string[]
}

export type GitStatusOutput = {
  ok: true
  repoRoot: string
  branch: string | null
  head: string
  upstream: string | null
  dirty: GitDirtySummary
  warnings: string[]
  suggestedNextCommands: string[]
}

export type GitHistoryOutput = {
  ok: true
  repoRoot: string
  base: string
  baseHead: string | null
  mergeBase: string | null
  paths: string[]
  commitsSinceBase: GitCommit[]
  changedFilesSinceBase: GitChangedFile[]
  pathHistory: GitPathHistoryEntry[]
  summary: {
    commitCountSinceBase: number
    changedFileCountSinceBase: number
    deletedFileCountSinceBase: number
  }
  warnings: string[]
  suggestedNextCommands: string[]
}

export type GitWorktreesOutput = {
  ok: true
  repoRoot: string
  currentWorktree: string
  worktrees: GitWorktreeEntry[]
  warnings: string[]
  suggestedNextCommands: string[]
}

export type GitContextOutput = {
  ok: true
  repoRoot: string
  branch: string | null
  head: string
  upstream: string | null
  base: string
  baseHead: string | null
  mergeBase: string | null
  dirty: GitDirtySummary
  commitsSinceBase: GitCommit[]
  changedFilesSinceBase: GitChangedFile[]
  pathHistory: GitPathHistoryEntry[]
  worktrees: GitWorktreeEntry[]
  summary: {
    commitCountSinceBase: number
    changedFileCountSinceBase: number
    deletedFileCountSinceBase: number
    worktreeCount: number
  }
  warnings: string[]
  suggestedNextCommands: string[]
}

export type GitStatusInput = { cwd?: string }

export type GitHistoryInput = {
  cwd?: string
  base: string
  paths?: string[]
  limit?: number
}

export type GitWorktreesInput = { cwd?: string }

export type GitContextInput = {
  cwd?: string
  base: string
  paths?: string[]
  limit?: number
  includeWorktrees?: boolean
}

// ============================================================================
// Schemas
// ============================================================================

const GitChangedFileSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['A', 'C', 'D', 'M', 'R', 'T', 'U', 'X'] },
    rawStatus: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    oldPath: { type: 'string', minLength: 1 },
  },
  required: ['status', 'rawStatus', 'path'],
  additionalProperties: false,
} as const

const GitCommitSchema = {
  type: 'object',
  properties: {
    fullSha: { type: 'string', minLength: 1 },
    shortSha: { type: 'string', minLength: 1 },
    committedAt: { type: 'string', minLength: 1 },
    subject: { type: 'string', minLength: 1 },
  },
  required: ['fullSha', 'shortSha', 'committedAt', 'subject'],
  additionalProperties: false,
} as const

const GitPathHistoryEntrySchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    commits: { type: 'array', items: GitCommitSchema },
  },
  required: ['path', 'commits'],
  additionalProperties: false,
} as const

const GitWorktreeEntrySchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    head: { type: 'string', minLength: 1 },
    branch: { type: 'string', nullable: true },
    detached: { type: 'boolean' },
    bare: { type: 'boolean' },
    lockedReason: { type: 'string', nullable: true },
    prunableReason: { type: 'string', nullable: true },
    exists: { type: 'boolean' },
    isCurrent: { type: 'boolean' },
  },
  required: ['path', 'head', 'branch', 'detached', 'bare', 'lockedReason', 'prunableReason', 'exists', 'isCurrent'],
  additionalProperties: false,
} as const

const GitDirtySummarySchema = {
  type: 'object',
  properties: {
    isDirty: { type: 'boolean' },
    stagedCount: { type: 'integer', minimum: 0 },
    unstagedCount: { type: 'integer', minimum: 0 },
    untrackedCount: { type: 'integer', minimum: 0 },
    stagedFiles: { type: 'array', items: { type: 'string' } },
    unstagedFiles: { type: 'array', items: { type: 'string' } },
    untrackedFiles: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'isDirty',
    'stagedCount',
    'unstagedCount',
    'untrackedCount',
    'stagedFiles',
    'unstagedFiles',
    'untrackedFiles',
  ],
  additionalProperties: false,
} as const

const GitStatusOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
    repoRoot: { type: 'string', minLength: 1 },
    branch: { type: 'string', nullable: true },
    head: { type: 'string', minLength: 1 },
    upstream: { type: 'string', nullable: true },
    dirty: GitDirtySummarySchema,
    warnings: { type: 'array', items: { type: 'string' } },
    suggestedNextCommands: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'repoRoot', 'branch', 'head', 'upstream', 'dirty', 'warnings', 'suggestedNextCommands'],
  additionalProperties: false,
} as const

const GitHistoryOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
    repoRoot: { type: 'string', minLength: 1 },
    base: { type: 'string', minLength: 1 },
    baseHead: { type: 'string', nullable: true },
    mergeBase: { type: 'string', nullable: true },
    paths: { type: 'array', items: { type: 'string' } },
    commitsSinceBase: { type: 'array', items: GitCommitSchema },
    changedFilesSinceBase: { type: 'array', items: GitChangedFileSchema },
    pathHistory: { type: 'array', items: GitPathHistoryEntrySchema },
    summary: {
      type: 'object',
      properties: {
        commitCountSinceBase: { type: 'integer', minimum: 0 },
        changedFileCountSinceBase: { type: 'integer', minimum: 0 },
        deletedFileCountSinceBase: { type: 'integer', minimum: 0 },
      },
      required: ['commitCountSinceBase', 'changedFileCountSinceBase', 'deletedFileCountSinceBase'],
      additionalProperties: false,
    },
    warnings: { type: 'array', items: { type: 'string' } },
    suggestedNextCommands: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'ok',
    'repoRoot',
    'base',
    'baseHead',
    'mergeBase',
    'paths',
    'commitsSinceBase',
    'changedFilesSinceBase',
    'pathHistory',
    'summary',
    'warnings',
    'suggestedNextCommands',
  ],
  additionalProperties: false,
} as const

const GitWorktreesOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
    repoRoot: { type: 'string', minLength: 1 },
    currentWorktree: { type: 'string', minLength: 1 },
    worktrees: { type: 'array', items: GitWorktreeEntrySchema },
    warnings: { type: 'array', items: { type: 'string' } },
    suggestedNextCommands: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'repoRoot', 'currentWorktree', 'worktrees', 'warnings', 'suggestedNextCommands'],
  additionalProperties: false,
} as const

const GitContextOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
    repoRoot: { type: 'string', minLength: 1 },
    branch: { type: 'string', nullable: true },
    head: { type: 'string', minLength: 1 },
    upstream: { type: 'string', nullable: true },
    base: { type: 'string', minLength: 1 },
    baseHead: { type: 'string', nullable: true },
    mergeBase: { type: 'string', nullable: true },
    dirty: GitDirtySummarySchema,
    commitsSinceBase: { type: 'array', items: GitCommitSchema },
    changedFilesSinceBase: { type: 'array', items: GitChangedFileSchema },
    pathHistory: { type: 'array', items: GitPathHistoryEntrySchema },
    worktrees: { type: 'array', items: GitWorktreeEntrySchema },
    summary: {
      type: 'object',
      properties: {
        commitCountSinceBase: { type: 'integer', minimum: 0 },
        changedFileCountSinceBase: { type: 'integer', minimum: 0 },
        deletedFileCountSinceBase: { type: 'integer', minimum: 0 },
        worktreeCount: { type: 'integer', minimum: 0 },
      },
      required: ['commitCountSinceBase', 'changedFileCountSinceBase', 'deletedFileCountSinceBase', 'worktreeCount'],
      additionalProperties: false,
    },
    warnings: { type: 'array', items: { type: 'string' } },
    suggestedNextCommands: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'ok',
    'repoRoot',
    'branch',
    'head',
    'upstream',
    'base',
    'baseHead',
    'mergeBase',
    'dirty',
    'commitsSinceBase',
    'changedFilesSinceBase',
    'pathHistory',
    'worktrees',
    'summary',
    'warnings',
    'suggestedNextCommands',
  ],
  additionalProperties: false,
} as const

const GitStatusInputSchema = {
  type: 'object',
  properties: {
    cwd: { type: 'string', minLength: 1 },
  },
  required: [],
  additionalProperties: false,
} as const

const GitHistoryInputSchema = {
  type: 'object',
  properties: {
    cwd: { type: 'string', minLength: 1 },
    base: { type: 'string', minLength: 1 },
    paths: { type: 'array', items: { type: 'string', minLength: 1 }, default: [] },
    limit: { type: 'integer', minimum: 1, maximum: MAX_HISTORY_LIMIT, default: DEFAULT_HISTORY_LIMIT },
  },
  required: ['base'],
  additionalProperties: false,
} as const

const GitWorktreesInputSchema = {
  type: 'object',
  properties: {
    cwd: { type: 'string', minLength: 1 },
  },
  required: [],
  additionalProperties: false,
} as const

const GitContextInputSchema = {
  type: 'object',
  properties: {
    cwd: { type: 'string', minLength: 1 },
    base: { type: 'string', minLength: 1 },
    paths: { type: 'array', items: { type: 'string', minLength: 1 }, default: [] },
    limit: { type: 'integer', minimum: 1, maximum: MAX_HISTORY_LIMIT, default: DEFAULT_HISTORY_LIMIT },
    includeWorktrees: { type: 'boolean', default: false },
  },
  required: ['base'],
  additionalProperties: false,
} as const

// ============================================================================
// Helpers
// ============================================================================

const toPosix = (value: string): string => value.replace(/\\/g, '/')

const quoteArg = (value: string): string => {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

const formatCommand = (argv: string[]): string => argv.map((arg) => quoteArg(arg)).join(' ')

const formatGitCommand = (args: string[]): string => formatCommand(['git', ...args])

const unique = (items: string[]): string[] => [...new Set(items)]

const isPathWithinRoot = ({ candidate, rootPath }: { candidate: string; rootPath: string }): boolean => {
  const relativePath = relative(rootPath, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

const toRepoPath = ({ repoRoot, absolutePath }: { repoRoot: string; absolutePath: string }): string => {
  if (!isPathWithinRoot({ candidate: absolutePath, rootPath: repoRoot })) {
    return absolutePath
  }

  const relativePath = toPosix(relative(repoRoot, absolutePath))
  return relativePath === '' ? '.' : relativePath
}

const resolvePathWithinRepo = ({ repoRoot, value }: { repoRoot: string; value: string }): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`Invalid path '${value}': empty paths are not allowed.`)
  }

  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(repoRoot, trimmed)
  if (!isPathWithinRoot({ candidate: absolutePath, rootPath: repoRoot })) {
    throw new Error(`Invalid path '${value}': path escapes repository root.`)
  }

  return toRepoPath({ repoRoot, absolutePath })
}

const resolvePathListWithinRepo = ({ repoRoot, paths }: { repoRoot: string; paths: string[] }): string[] => {
  const entries = new Set<string>()
  for (const path of paths) {
    entries.add(resolvePathWithinRepo({ repoRoot, value: path }))
  }

  return [...entries]
}

const runGit = async ({
  cwd,
  args,
  allowFailure = false,
}: {
  cwd: string
  args: string[]
  allowFailure?: boolean
}): Promise<GitResult> => {
  const result = await Bun.$`git ${args}`.cwd(cwd).quiet().nothrow()
  const stdout = result.stdout.toString().trimEnd()
  const stderr = result.stderr.toString().trim()

  if (result.exitCode !== 0 && !allowFailure) {
    throw new GitCommandError({
      command: formatGitCommand(args),
      exitCode: result.exitCode,
      stderr,
    })
  }

  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
  }
}

const resolveGitRepoRoot = async (cwd: string): Promise<string> => {
  const result = await runGit({
    cwd,
    args: ['rev-parse', '--show-toplevel'],
  })

  return resolve(result.stdout.trim())
}

const resolveCurrentBranch = async ({ cwd }: { cwd: string }): Promise<string | null> => {
  const result = await runGit({
    cwd,
    args: ['branch', '--show-current'],
  })

  const branch = result.stdout.trim()
  return branch ? branch : null
}

const resolveHead = async ({ cwd }: { cwd: string }): Promise<string> => {
  const result = await runGit({
    cwd,
    args: ['rev-parse', 'HEAD'],
  })

  return result.stdout.trim()
}

const resolveUpstream = async ({ cwd }: { cwd: string }): Promise<string | null> => {
  const result = await runGit({
    cwd,
    args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    return null
  }

  const upstream = result.stdout.trim()
  return upstream ? upstream : null
}

const resolveGitRef = async ({ cwd, ref }: { cwd: string; ref: string }): Promise<string | null> => {
  const result = await runGit({
    cwd,
    args: ['rev-parse', '--verify', `${ref}^{commit}`],
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    return null
  }

  return result.stdout.trim()
}

const resolveMergeBase = async ({ cwd, baseRef }: { cwd: string; baseRef: string }): Promise<string | null> => {
  const result = await runGit({
    cwd,
    args: ['merge-base', 'HEAD', baseRef],
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    return null
  }

  return result.stdout.trim()
}

const parseGitLogRows = (stdout: string): GitCommit[] => {
  if (!stdout.trim()) {
    return []
  }

  const commits: GitCommit[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const [fullSha = '', shortSha = '', committedAt = '', ...subjectParts] = trimmed.split('\t')
    const subject = subjectParts.join('\t').trim()
    if (!fullSha || !shortSha || !committedAt || !subject) {
      continue
    }

    commits.push({
      fullSha,
      shortSha,
      committedAt,
      subject,
    })
  }

  return commits
}

const parseNameStatusRows = ({ stdout, repoRoot }: { stdout: string; repoRoot: string }): GitChangedFile[] => {
  if (!stdout.trim()) {
    return []
  }

  const rows: GitChangedFile[] = []

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const parts = line.split('\t')
    const rawStatus = parts[0]?.trim() ?? ''
    const normalizedStatus = rawStatus[0] as GitChangedFile['status'] | undefined
    if (!rawStatus || !normalizedStatus || !['A', 'C', 'D', 'M', 'R', 'T', 'U', 'X'].includes(normalizedStatus)) {
      continue
    }

    if ((normalizedStatus === 'R' || normalizedStatus === 'C') && parts.length >= 3) {
      const oldPathRaw = parts[1]?.trim()
      const pathRaw = parts[2]?.trim()
      if (!oldPathRaw || !pathRaw) {
        continue
      }

      rows.push({
        status: normalizedStatus,
        rawStatus,
        path: resolvePathWithinRepo({ repoRoot, value: pathRaw }),
        oldPath: resolvePathWithinRepo({ repoRoot, value: oldPathRaw }),
      })
      continue
    }

    const pathRaw = parts[1]?.trim()
    if (!pathRaw) {
      continue
    }

    rows.push({
      status: normalizedStatus,
      rawStatus,
      path: resolvePathWithinRepo({ repoRoot, value: pathRaw }),
    })
  }

  return rows
}

const collectCommits = async ({
  cwd,
  range,
  limit,
}: {
  cwd: string
  range: string
  limit: number
}): Promise<GitCommit[]> => {
  const result = await runGit({
    cwd,
    args: ['log', '--no-decorate', '--date=iso-strict', '--pretty=format:%H%x09%h%x09%cI%x09%s', `-n${limit}`, range],
  })

  return parseGitLogRows(result.stdout)
}

const collectPathHistory = async ({
  cwd,
  paths,
  limit,
}: {
  cwd: string
  paths: string[]
  limit: number
}): Promise<GitPathHistoryEntry[]> => {
  const rows: GitPathHistoryEntry[] = []
  for (const path of paths) {
    const result = await runGit({
      cwd,
      args: [
        'log',
        '--no-decorate',
        '--date=iso-strict',
        '--pretty=format:%H%x09%h%x09%cI%x09%s',
        `-n${limit}`,
        '--',
        path,
      ],
    })

    rows.push({
      path,
      commits: parseGitLogRows(result.stdout),
    })
  }

  return rows
}

const collectChangedFiles = async ({
  cwd,
  mergeBase,
  repoRoot,
}: {
  cwd: string
  mergeBase: string
  repoRoot: string
}): Promise<GitChangedFile[]> => {
  const result = await runGit({
    cwd,
    args: ['diff', '--name-status', `${mergeBase}...HEAD`],
  })

  return parseNameStatusRows({ stdout: result.stdout, repoRoot })
}

const parseStatusPath = (rawPath: string): string => {
  const path = rawPath.includes(' -> ') ? (rawPath.split(' -> ').at(-1)?.trim() ?? rawPath) : rawPath
  return path
}

const collectDirtyState = async ({
  cwd,
  repoRoot,
}: {
  cwd: string
  repoRoot: string
}): Promise<{
  stagedFiles: string[]
  unstagedFiles: string[]
  untrackedFiles: string[]
}> => {
  const args = ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']
  const command = formatGitCommand(args)
  const process = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdoutBuffer, stderrText, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new GitCommandError({
      command,
      exitCode,
      stderr: stderrText.trim(),
    })
  }

  const stagedFiles = new Set<string>()
  const unstagedFiles = new Set<string>()
  const untrackedFiles = new Set<string>()

  const records = new TextDecoder().decode(stdoutBuffer).split('\u0000')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.startsWith('## ')) {
      continue
    }

    if (record.startsWith('?? ')) {
      const path = record.slice(3)
      if (path) {
        untrackedFiles.add(resolvePathWithinRepo({ repoRoot, value: parseStatusPath(path) }))
      }
      continue
    }

    if (record.startsWith('!! ')) {
      continue
    }

    const x = record[0] ?? ' '
    const y = record[1] ?? ' '
    const rawPath = record.slice(3)
    if (!rawPath) {
      continue
    }

    const path = resolvePathWithinRepo({ repoRoot, value: parseStatusPath(rawPath) })
    if (x !== ' ') {
      stagedFiles.add(path)
    }
    if (y !== ' ') {
      unstagedFiles.add(path)
    }

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      index += 1
    }
  }

  return {
    stagedFiles: [...stagedFiles].sort(),
    unstagedFiles: [...unstagedFiles].sort(),
    untrackedFiles: [...untrackedFiles].sort(),
  }
}

const pathExists = async (value: string): Promise<boolean> => {
  try {
    await stat(value)
    return true
  } catch {
    return false
  }
}

const createWorktreeAccumulator = (path: string): WorktreeAccumulator => ({
  path,
  head: '',
  branch: null,
  detached: false,
  bare: false,
  lockedReason: null,
  prunableReason: null,
})

const parseWorktreeList = (stdout: string): WorktreeAccumulator[] => {
  const rows: WorktreeAccumulator[] = []
  let current: WorktreeAccumulator | null = null

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }

    if (line.startsWith('worktree ')) {
      if (current) {
        rows.push(current)
      }
      current = createWorktreeAccumulator(line.slice('worktree '.length))
      continue
    }

    if (!current) {
      continue
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
      continue
    }
    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim()
      continue
    }
    if (line === 'detached') {
      current.detached = true
      continue
    }
    if (line === 'bare') {
      current.bare = true
      continue
    }
    if (line === 'locked') {
      current.lockedReason = ''
      continue
    }
    if (line.startsWith('locked ')) {
      current.lockedReason = line.slice('locked '.length)
      continue
    }
    if (line === 'prunable') {
      current.prunableReason = ''
      continue
    }
    if (line.startsWith('prunable ')) {
      current.prunableReason = line.slice('prunable '.length)
    }
  }

  if (current) {
    rows.push(current)
  }

  return rows
}

const collectWorktrees = async ({
  cwd,
  repoRoot,
  currentWorktree,
}: {
  cwd: string
  repoRoot: string
  currentWorktree: string
}): Promise<GitWorktreeEntry[]> => {
  const result = await runGit({
    cwd,
    args: ['worktree', 'list', '--porcelain'],
  })

  const parsed = parseWorktreeList(result.stdout)
  const entries: GitWorktreeEntry[] = []

  for (const row of parsed) {
    const absolutePath = resolve(row.path)

    entries.push({
      path: toRepoPath({ repoRoot, absolutePath }),
      head: row.head,
      branch: row.branch,
      detached: row.detached,
      bare: row.bare,
      lockedReason: row.lockedReason,
      prunableReason: row.prunableReason,
      exists: await pathExists(absolutePath),
      isCurrent: absolutePath === currentWorktree,
    })
  }

  return entries
}

const capList = <T>({ entries, label, warnings }: { entries: T[]; label: string; warnings: string[] }): T[] => {
  if (entries.length <= MAX_FILE_LIST_ENTRIES) {
    return entries
  }

  warnings.push(`${label} list was truncated to ${MAX_FILE_LIST_ENTRIES} entries.`)
  return entries.slice(0, MAX_FILE_LIST_ENTRIES)
}

// ============================================================================
// Mode collectors
// ============================================================================

const collectStatus = async ({ cwd }: { cwd: string }): Promise<GitStatusOutput> => {
  const repoRoot = await resolveGitRepoRoot(cwd)
  const [branch, head, upstream, dirtyState] = await Promise.all([
    resolveCurrentBranch({ cwd: repoRoot }),
    resolveHead({ cwd: repoRoot }),
    resolveUpstream({ cwd: repoRoot }),
    collectDirtyState({ cwd: repoRoot, repoRoot }),
  ])

  const warnings: string[] = []

  const stagedFiles = capList({ entries: dirtyState.stagedFiles, label: 'staged files', warnings })
  const unstagedFiles = capList({ entries: dirtyState.unstagedFiles, label: 'unstaged files', warnings })
  const untrackedFiles = capList({ entries: dirtyState.untrackedFiles, label: 'untracked files', warnings })

  const dirty = {
    isDirty:
      dirtyState.stagedFiles.length > 0 || dirtyState.unstagedFiles.length > 0 || dirtyState.untrackedFiles.length > 0,
    stagedCount: dirtyState.stagedFiles.length,
    unstagedCount: dirtyState.unstagedFiles.length,
    untrackedCount: dirtyState.untrackedFiles.length,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
  }

  if (dirty.isDirty) {
    warnings.push(
      `Dirty worktree detected: ${dirty.stagedCount} staged, ${dirty.unstagedCount} unstaged, ${dirty.untrackedCount} untracked.`,
    )
  }

  if (!upstream) {
    warnings.push('Current branch has no configured upstream tracking ref.')
  }

  return {
    ok: true,
    repoRoot,
    branch,
    head,
    upstream,
    dirty,
    warnings,
    suggestedNextCommands: unique([
      formatGitCommand(['status', '--short', '--branch']),
      formatGitCommand(['diff', '--stat']),
      formatGitCommand(['log', '--oneline', '-20']),
    ]),
  }
}

const buildHistorySuggestedCommands = ({
  base,
  mergeBase,
  paths,
  limit,
}: {
  base: string
  mergeBase: string | null
  paths: string[]
  limit: number
}): string[] => {
  const commands: string[] = [
    formatGitCommand(['merge-base', 'HEAD', base]),
    formatGitCommand(['log', '--oneline', `-${limit}`]),
  ]

  if (mergeBase) {
    commands.push(formatGitCommand(['log', '--oneline', `-${limit}`, `${mergeBase}..HEAD`]))
    commands.push(formatGitCommand(['diff', '--stat', `${mergeBase}...HEAD`]))
    commands.push(formatGitCommand(['diff', '--name-status', `${mergeBase}...HEAD`]))
  } else {
    commands.push(formatGitCommand(['rev-parse', '--verify', `${base}^{commit}`]))
  }

  for (const path of paths) {
    commands.push(formatGitCommand(['log', '--oneline', `-${limit}`, '--', path]))
  }

  return unique(commands)
}

const collectHistory = async ({
  cwd,
  base,
  paths,
  limit,
}: {
  cwd: string
  base: string
  paths?: string[]
  limit?: number
}): Promise<GitHistoryOutput> => {
  const resolvedLimit = limit ?? DEFAULT_HISTORY_LIMIT
  const repoRoot = await resolveGitRepoRoot(cwd)
  const validatedPaths = resolvePathListWithinRepo({
    repoRoot,
    paths: paths ?? [],
  })

  const warnings: string[] = []
  const baseHead = await resolveGitRef({ cwd: repoRoot, ref: base })

  if (!baseHead) {
    warnings.push(`Base ref '${base}' could not be resolved in this repository.`)
  }

  const mergeBase = baseHead
    ? await resolveMergeBase({
        cwd: repoRoot,
        baseRef: base,
      })
    : null

  if (baseHead && !mergeBase) {
    warnings.push(`Merge-base between HEAD and '${base}' could not be resolved.`)
  }

  const commitsSinceBase = mergeBase
    ? await collectCommits({
        cwd: repoRoot,
        range: `${mergeBase}..HEAD`,
        limit: resolvedLimit,
      })
    : []

  const changedFilesSinceBaseRaw = mergeBase
    ? await collectChangedFiles({
        cwd: repoRoot,
        mergeBase,
        repoRoot,
      })
    : []

  const changedFilesSinceBase = capList({
    entries: changedFilesSinceBaseRaw,
    label: 'changed files',
    warnings,
  })

  const pathHistory = await collectPathHistory({
    cwd: repoRoot,
    paths: validatedPaths,
    limit: resolvedLimit,
  })

  const deletedFileCountSinceBase = changedFilesSinceBaseRaw.filter((entry) => entry.status === 'D').length
  if (deletedFileCountSinceBase > 0) {
    warnings.push(`Branch includes ${deletedFileCountSinceBase} deleted file change(s) since merge-base.`)
  }

  if (changedFilesSinceBaseRaw.length > BROAD_CHANGED_FILE_THRESHOLD) {
    warnings.push(
      `Broad change surface: ${changedFilesSinceBaseRaw.length} changed files since merge-base (${BROAD_CHANGED_FILE_THRESHOLD}+).`,
    )
  }

  if (commitsSinceBase.length > BROAD_COMMIT_THRESHOLD) {
    warnings.push(
      `Broad commit range: ${commitsSinceBase.length} commits since merge-base (${BROAD_COMMIT_THRESHOLD}+).`,
    )
  }

  if (baseHead && mergeBase && baseHead !== mergeBase) {
    warnings.push(
      `Current branch merge-base (${mergeBase.slice(0, 12)}) differs from ${base} head (${baseHead.slice(0, 12)}).`,
    )
  }

  return {
    ok: true,
    repoRoot,
    base,
    baseHead,
    mergeBase,
    paths: validatedPaths,
    commitsSinceBase,
    changedFilesSinceBase,
    pathHistory,
    summary: {
      commitCountSinceBase: commitsSinceBase.length,
      changedFileCountSinceBase: changedFilesSinceBaseRaw.length,
      deletedFileCountSinceBase,
    },
    warnings,
    suggestedNextCommands: buildHistorySuggestedCommands({
      base,
      mergeBase,
      paths: validatedPaths,
      limit: resolvedLimit,
    }),
  }
}

const collectWorktreeContext = async ({ cwd }: { cwd: string }): Promise<GitWorktreesOutput> => {
  const repoRoot = await resolveGitRepoRoot(cwd)
  const currentWorktree = repoRoot

  const worktrees = await collectWorktrees({
    cwd: repoRoot,
    repoRoot,
    currentWorktree,
  })

  const warnings: string[] = []
  for (const worktree of worktrees) {
    if (!worktree.exists) {
      warnings.push(`Worktree path is missing on disk: ${worktree.path}`)
    }
    if (worktree.prunableReason !== null) {
      warnings.push(`Worktree may be stale or prunable: ${worktree.path}`)
    }
  }

  return {
    ok: true,
    repoRoot,
    currentWorktree: toRepoPath({ repoRoot, absolutePath: currentWorktree }),
    worktrees,
    warnings,
    suggestedNextCommands: unique([
      formatGitCommand(['worktree', 'list', '--porcelain']),
      formatGitCommand(['branch', '--all', '--verbose']),
      formatGitCommand(['status', '--short', '--branch']),
    ]),
  }
}

const collectContext = async (input: GitContextInput): Promise<GitContextOutput> => {
  const cwd = resolve(input.cwd ?? process.cwd())

  const [status, history] = await Promise.all([
    collectStatus({ cwd }),
    collectHistory({
      cwd,
      base: input.base,
      paths: input.paths,
      limit: input.limit,
    }),
  ])
  const worktreeContext = input.includeWorktrees ? await collectWorktreeContext({ cwd }) : null

  return {
    ok: true,
    repoRoot: history.repoRoot,
    branch: status.branch,
    head: status.head,
    upstream: status.upstream,
    base: history.base,
    baseHead: history.baseHead,
    mergeBase: history.mergeBase,
    dirty: status.dirty,
    commitsSinceBase: history.commitsSinceBase,
    changedFilesSinceBase: history.changedFilesSinceBase,
    pathHistory: history.pathHistory,
    worktrees: worktreeContext?.worktrees ?? [],
    summary: {
      commitCountSinceBase: history.summary.commitCountSinceBase,
      changedFileCountSinceBase: history.summary.changedFileCountSinceBase,
      deletedFileCountSinceBase: history.summary.deletedFileCountSinceBase,
      worktreeCount: worktreeContext?.worktrees.length ?? 0,
    },
    warnings: unique([...status.warnings, ...history.warnings, ...(worktreeContext?.warnings ?? [])]),
    suggestedNextCommands: unique([...status.suggestedNextCommands, ...history.suggestedNextCommands]),
  }
}

// ============================================================================
// Tools
// ============================================================================

const resolveCwd = (cwd?: string): string => resolve(cwd ?? process.cwd())

/** git status — branch, HEAD, upstream, and dirty file lists as structured JSON. */
export const gitStatus = useTool(
  {
    name: GIT_STATUS_TOOL_NAME,
    description:
      'Run git status — branch, HEAD, upstream, and staged/unstaged/untracked file lists as structured JSON, with dirty and missing-upstream warnings plus suggested next git commands.',
    inputSchema: GitStatusInputSchema as unknown as JSONSchemaType<GitStatusInput>,
    outputSchema: GitStatusOutputSchema as unknown as JSONSchemaType<GitStatusOutput>,
  },
  (input) => collectStatus({ cwd: resolveCwd(input.cwd) }),
)

/** git history — merge-base, commits, changed files, and per-path history against a base ref. */
export const gitHistory = useTool(
  {
    name: GIT_HISTORY_TOOL_NAME,
    description:
      'Run git history against a base ref — merge-base, commits since base, changed files, and per-path history as structured JSON, with broad-change and deleted-file warnings plus suggested next git commands.',
    inputSchema: GitHistoryInputSchema as unknown as JSONSchemaType<GitHistoryInput>,
    outputSchema: GitHistoryOutputSchema as unknown as JSONSchemaType<GitHistoryOutput>,
  },
  (input) =>
    collectHistory({
      cwd: resolveCwd(input.cwd),
      base: input.base,
      paths: input.paths,
      limit: input.limit,
    }),
)

/** git worktrees — parsed worktree list with lock/prune metadata. */
export const gitWorktrees = useTool(
  {
    name: GIT_WORKTREES_TOOL_NAME,
    description:
      'List git worktrees — parsed porcelain entries with lock/prune metadata, on-disk existence checks, and the current worktree flagged, as structured JSON.',
    inputSchema: GitWorktreesInputSchema as unknown as JSONSchemaType<GitWorktreesInput>,
    outputSchema: GitWorktreesOutputSchema as unknown as JSONSchemaType<GitWorktreesOutput>,
  },
  (input) => collectWorktreeContext({ cwd: resolveCwd(input.cwd) }),
)

/** git context — combined status + history against a base ref in one call. */
export const gitContext = useTool(
  {
    name: GIT_CONTEXT_TOOL_NAME,
    description:
      'Combined git context — status (branch, HEAD, upstream, dirty files) plus history against a base ref (merge-base, commits, changed files, per-path history) in one call, with optional worktrees included.',
    inputSchema: GitContextInputSchema as unknown as JSONSchemaType<GitContextInput>,
    outputSchema: GitContextOutputSchema as unknown as JSONSchemaType<GitContextOutput>,
  },
  collectContext,
)

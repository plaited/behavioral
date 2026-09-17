/**
 * `behavioral init` — first-time setup command.
 *
 * @remarks
 * Provisions the `~/.behavioral` growth-model home (idempotent) and runs the
 * reconcile scan at-provisioning, printing the result as JSON. Uses the
 * shared {@link makeCli} framework — no new CLI machinery.
 *
 * Home provisioning:
 * 1. Root-space skeleton (`root/{threads,html,logs/archive}`)
 * 2. `git init ~/.behavioral` if absent (the learning-log repo)
 * 3. `.gitignore` (`db.sqlite`, `logs/`) and a seed `config.json` if absent
 *
 * There is no plugin install — the growth model has no bundled plugin.
 * Growth lives in the home tree and workspace skills; plugin packaging
 * remains a deferred distribution format read by `plugin-client`.
 *
 * @internal
 */

import type { JSONSchemaType } from 'ajv'
import { behavioralHomeRoot, type ProvisionResult, provisionBehavioralHome } from '../kernel/behavioral-home.ts'
import { reconcileScan, type ScanResult } from '../kernel/reconcile-scan.ts'
import { makeCli } from './cli.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InitCliInput = Record<string, never>

type InitCliOutput = {
  home: ProvisionResult
  scan: ScanResult
}

// ---------------------------------------------------------------------------
// JSON Schemas (AJV — matching useTool's convention)
// ---------------------------------------------------------------------------

const scanSchema = {
  type: 'object',
  properties: {
    spaces: { type: 'array', items: { type: 'string' }, description: 'the spaces scanned' },
    created: { type: 'integer', description: 'rows created' },
    updated: { type: 'integer', description: 'rows updated' },
    deleted: { type: 'integer', description: 'rows deleted (artifacts vanished)' },
    skippedInvalid: { type: 'integer', description: 'committed artifacts with malformed BMeta — never indexed' },
    skippedUncommitted: { type: 'integer', description: 'uncommitted artifacts — unlearned, correctly absent' },
  },
  required: ['spaces', 'created', 'updated', 'deleted', 'skippedInvalid', 'skippedUncommitted'],
  additionalProperties: false,
  description: 'reconcile-scan result — the sole discovery-store writer, run at provisioning',
} as const

const InitCliInputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
  description: 'Init CLI input — provision the ~/.behavioral home (idempotent)',
} as unknown as JSONSchemaType<InitCliInput>

const InitCliOutputSchema = {
  type: 'object',
  properties: {
    home: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'the behavioral home root (~/.behavioral)' },
        gitInitialized: { type: 'boolean', description: 'whether git init ran this invocation' },
        gitignoreWritten: { type: 'boolean', description: 'whether .gitignore was written this invocation' },
        configSeeded: { type: 'boolean', description: 'whether config.json was seeded this invocation' },
      },
      required: ['root', 'gitInitialized', 'gitignoreWritten', 'configSeeded'],
      additionalProperties: false,
      description: 'idempotent provisioning result for the ~/.behavioral growth-model home',
    },
    scan: scanSchema,
  },
  required: ['home', 'scan'],
  additionalProperties: false,
  description: 'Init CLI output — the home provisioning result and the reconcile-scan result',
} as unknown as JSONSchemaType<InitCliOutput>

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const run = async (_input: InitCliInput): Promise<InitCliOutput> => {
  // Idempotent home provisioning, then the reconcile scan — at-provisioning
  // is one of the scan's two run points (post-turn is the other).
  const home = await provisionBehavioralHome(behavioralHomeRoot())
  const scan = await reconcileScan({ cwd: process.cwd() })
  return { home, scan }
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export const initCli = makeCli({
  name: 'init',
  inputSchema: InitCliInputSchema,
  outputSchema: InitCliOutputSchema,
  help: [
    'First-time setup — provision the ~/.behavioral growth-model home (idempotent)',
    'and run the reconcile scan.',
    '',
    'Home provisioning (~/.behavioral):',
    '  - root space skeleton: root/{threads,html,logs/archive}',
    '  - git init (the learning log repo) if absent',
    '  - .gitignore (db.sqlite, logs/) and seed config.json if absent',
    '  - never clobbers existing files or user edits',
    '',
    'The reconcile scan walks ~/.behavioral/<space>/{threads,html}, the project',
    '.agents/skills/, and installed plugins, and upserts the discovery index',
    '(~/.behavioral/db.sqlite) — the sole writer.',
    '',
    'Examples:',
    "  behavioral init '{}'  # provision + scan",
  ].join('\n'),
  run,
})

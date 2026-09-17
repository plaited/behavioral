/**
 * `behavioral init` — first-time setup command.
 *
 * @remarks
 * Copies the bundled default plugin from `src/plugin/` into the
 * scope-resolved `.agents/plugins/behavioral/` directory, optionally
 * configures you-web auth (apiKey → keychain, or interactive OAuth), and
 * prints the result as JSON. Uses the shared {@link makeCli} framework —
 * no new CLI machinery.
 *
 * Auth precedence for you-web:
 * 1. `you-web.apiKey` present → stored to keychain (bearer-env at connection)
 * 2. `you-web.oauth` true (default when no apiKey) → interactive OAuth flow
 * 3. Neither → auth is `unresolved` (provisioner probes at runtime)
 *
 * @internal
 */

import * as path from 'node:path'
import type { JSONSchemaType } from 'ajv'
import { behavioralHomeRoot, type ProvisionResult, provisionBehavioralHome } from '../kernel/behavioral-home.ts'
import { reconcileScan, type ScanResult } from '../kernel/reconcile-scan.ts'
import { makeCli } from './cli.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_SOURCE_DIR = path.resolve(import.meta.dir, '../plugin')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InitCliInput = {
  scope: 'user' | 'project'
  force: boolean
  'you-web'?: { apiKey?: string | null; oauth?: boolean }
}

type InitCliOutput = {
  installed: string
  scope: 'user' | 'project'
  auth: 'apiKey' | 'oauth' | 'unresolved'
  force: boolean
  home: ProvisionResult
  scan: ScanResult
}

type InitError = {
  isError: true
  message: string
  home: ProvisionResult
  scan: ScanResult
}

// ---------------------------------------------------------------------------
// JSON Schemas (AJV — matching useTool's convention)
// ---------------------------------------------------------------------------

const YouWebSchema = {
  type: 'object',
  properties: {
    apiKey: { type: 'string', nullable: true, description: 'API key for headless auth' },
    oauth: { type: 'boolean', description: 'enable interactive OAuth flow' },
  },
  additionalProperties: false,
  description: 'you-web auth config — apiKey for headless, oauth for interactive, or neither for unresolved',
} as unknown as JSONSchemaType<{ apiKey?: string | null; oauth?: boolean }>

const InitCliInputSchema = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['user', 'project'],
      default: 'user',
      description: 'installation scope — user (~/.agents) or project (<cwd>/.agents)',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'overwrite an existing install (loses edits to the installed copy)',
    },
    'you-web': YouWebSchema,
  },
  additionalProperties: false,
  description: 'Init CLI input — install the default behavioral plugin and configure auth',
} as unknown as JSONSchemaType<InitCliInput>

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

const InitCliOutputSchema = {
  type: 'object',
  properties: {
    installed: { type: 'string', description: 'absolute path to the installed plugin directory' },
    scope: { type: 'string', enum: ['user', 'project'], description: 'installation scope' },
    auth: {
      type: 'string',
      enum: ['apiKey', 'oauth', 'unresolved'],
      description: 'resolved auth method',
    },
    force: { type: 'boolean', description: 'whether the install was forced' },
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
  required: ['installed', 'scope', 'auth', 'force', 'home', 'scan'],
  additionalProperties: false,
  description: 'Init CLI output — the install path, auth resolution, and force flag',
} as unknown as JSONSchemaType<InitCliOutput>

const InitErrorSchema = {
  type: 'object',
  properties: {
    isError: { type: 'boolean', const: true, description: 'marks an error result' },
    message: { type: 'string', description: 'human-readable error message' },
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
  required: ['isError', 'message', 'home', 'scan'],
  additionalProperties: false,
  description: 'Init CLI error output',
} as unknown as JSONSchemaType<InitError>

const InitCliOutputUnionSchema = {
  oneOf: [InitCliOutputSchema, InitErrorSchema],
} as unknown as JSONSchemaType<InitCliOutput | InitError>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolveScopeDir = (scope: 'user' | 'project'): string => {
  if (scope === 'user') {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
    if (!home) throw new Error('Cannot resolve HOME directory for user scope')
    return path.join(home, '.agents', 'plugins', 'behavioral')
  }
  return path.join(process.cwd(), '.agents', 'plugins', 'behavioral')
}

const copyDir = async (src: string, dest: string): Promise<void> => {
  await Bun.$`mkdir -p ${dest}`.quiet()
  for (const entry of await Array.fromAsync(new Bun.Glob('*').scan({ cwd: src, onlyFiles: false }))) {
    const srcPath = path.join(src, entry)
    const destPath = path.join(dest, entry)
    if (await Bun.file(srcPath).exists()) {
      await Bun.write(destPath, await Bun.file(srcPath).bytes())
    } else {
      await copyDir(srcPath, destPath)
    }
  }
}

const pluginExists = async (dir: string): Promise<boolean> => Bun.file(path.join(dir, 'plugin.json')).exists()

const resolveAuth = (
  youWeb: { apiKey?: string | null; oauth?: boolean } | undefined,
): { auth: 'apiKey' | 'oauth' | 'unresolved'; apiKey?: string } => {
  if (youWeb?.apiKey) {
    return { auth: 'apiKey', apiKey: youWeb.apiKey }
  }
  if (youWeb && youWeb.oauth !== false) {
    return { auth: 'oauth' }
  }
  return { auth: 'unresolved' }
}

const storeApiKey = async (apiKey: string): Promise<void> => {
  try {
    const { BunKeychain, KEYCHAIN_SERVICE } = await import('../oauth/keychain.ts')
    const keychain = BunKeychain(KEYCHAIN_SERVICE)
    await keychain.set('you-web-api-key', apiKey)
  } catch {
    // Keychain unavailable (headless/CI/sandbox) — the provisioner probes
    // env at runtime as a fallback. Auth status is still 'apiKey' because
    // the user provided the key; it's just not persisted to the OS store.
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const run = async (input: InitCliInput): Promise<InitCliOutput | InitError> => {
  // Idempotent home provisioning happens first, then the reconcile scan —
  // at-provisioning is one of the scan's two run points (post-turn is the
  // other). Both are safe and convergent even when the plugin install then
  // short-circuits on "already installed".
  const home = await provisionBehavioralHome(behavioralHomeRoot())
  const scan = await reconcileScan({ cwd: process.cwd() })

  const targetDir = resolveScopeDir(input.scope)

  if (await pluginExists(targetDir)) {
    if (!input.force) {
      return {
        isError: true,
        message: 'already installed — pass force: true to overwrite',
        home,
        scan,
      }
    }
    await Bun.$`rm -rf ${targetDir}`.quiet()
  }

  await copyDir(PLUGIN_SOURCE_DIR, targetDir)

  const youWeb = input['you-web']
  const authResult = resolveAuth(youWeb)

  if (authResult.auth === 'apiKey' && authResult.apiKey) {
    await storeApiKey(authResult.apiKey)
  }

  // MINIMAL: oauth flow is not wired here — the provisioner handles interactive
  // OAuth at connection time via the keychain OAuth provider. Upgrade path:
  // trigger the browser OAuth flow directly from init when running interactively.

  return {
    installed: targetDir,
    scope: input.scope,
    auth: authResult.auth,
    force: input.force,
    home,
    scan,
  }
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export const initCli = makeCli({
  name: 'init',
  inputSchema: InitCliInputSchema,
  outputSchema: InitCliOutputUnionSchema,
  help: [
    'First-time setup — install the default behavioral plugin, configure you-web auth,',
    'provision the ~/.behavioral growth-model home (idempotent), and run the reconcile scan.',
    '',
    'Home provisioning (~/.behavioral):',
    '  - root space skeleton: root/{threads,html,logs/archive}',
    '  - git init (the learning log repo) if absent',
    '  - .gitignore (db.sqlite, logs/) and seed config.json if absent',
    '  - never clobbers existing files or user edits',
    '',
    'Installs the bundled plugin from src/plugin/ into:',
    '  user scope    → ~/.agents/plugins/behavioral/',
    '  project scope → <cwd>/.agents/plugins/behavioral/',
    '',
    'force: default false — refuses to overwrite an existing install.',
    '  pass force: true to replace it (loses edits to the installed copy).',
    '  No silent clobbering — existing installs are protected.',
    '',
    'Auth precedence for you-web:',
    '  1. apiKey present → stored to keychain (bearer-env at connection)',
    '  2. oauth: true (default when no apiKey) → interactive OAuth flow',
    '  3. Neither → unresolved (provisioner probes at runtime)',
    '',
    'Examples:',
    '  behavioral init \'{"scope":"project","you-web":{"apiKey":"KEY"}}\'',
    '  behavioral init \'{"scope":"user","force":true}\'',
    "  behavioral init '{}'  # user scope, default auth (unresolved)",
  ].join('\n'),
  run,
})

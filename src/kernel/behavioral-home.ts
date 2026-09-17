/**
 * The `~/.behavioral` growth-model home — host-side, NOT agent-facing
 * surface. The kernel reads config.json at provisioning; the fleet tools
 * never see this module (host config is not agent surface).
 *
 * @remarks
 * Tree shape (plan.md Decision Log 2026-09-17 — space-first):
 *
 * ```
 * ~/.behavioral/
 *   config.json               # host config: models + future host settings (git-tracked)
 *   db.sqlite                 # gitignored; single discovery db
 *   root/                     # the $root space — name reserved
 *     threads/ html/ logs/ logs/archive/
 *   <space-name>/             # identical shape per space
 * ```
 *
 * `~/.behavioral` is its own git repository — the learning log. `threads/`,
 * `html/`, `config.json` are tracked; `db.sqlite` and `logs/` gitignored
 * (exhaust is data for the teacher, not the learning log).
 *
 * @packageDocumentation
 */

import * as path from 'node:path'
import type { JSONSchemaType } from 'ajv'
import { ajv } from '../tools/use-tool.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BEHAVIORAL_HOME_DIR = '.behavioral'
/** The $root space — name reserved (root is the unscoped identity). */
export const ROOT_SPACE = 'root'
export const THREADS_DIR = 'threads'
export const HTML_DIR = 'html'
export const LOGS_DIR = 'logs'
export const ARCHIVE_DIR = 'archive'
export const CONFIG_FILE = 'config.json'
export const DB_FILE = 'db.sqlite'
export const GITIGNORE_CONTENT = `${DB_FILE}\n${LOGS_DIR}/\n`

// Precedent: skill-client's user-level scan uses Bun.env.HOME ?? Bun.env.USERPROFILE.
const userHome = (): string => {
  const home = Bun.env.HOME ?? Bun.env.USERPROFILE
  if (!home) throw new Error('Cannot resolve the user home directory (HOME/USERPROFILE unset)')
  return home
}

/** The user-level behavioral home root: `~/.behavioral`. */
export const behavioralHomeRoot = (): string => path.join(userHome(), BEHAVIORAL_HOME_DIR)

/** The identical per-space folder shape under the home root. */
export const spacePaths = (home: string, space: string) => ({
  space: path.join(home, space),
  threads: path.join(home, space, THREADS_DIR),
  html: path.join(home, space, HTML_DIR),
  logs: path.join(home, space, LOGS_DIR),
  logsArchive: path.join(home, space, LOGS_DIR, ARCHIVE_DIR),
})

// ---------------------------------------------------------------------------
// config.json — host config: model declarations (apiKeyRef, never raw apiKey)
// ---------------------------------------------------------------------------

export type BehavioralModelConfig = {
  provider: string
  modelId: string
  endpointUrl: string
  apiKeyRef?: string
  locality?: string
}

export type BehavioralHomeConfig = {
  models: BehavioralModelConfig[]
}

// additionalProperties: false rejects a raw `apiKey` on a model entry — the
// apiKeyRef-not-raw-apiKey rule moved here from the deleted sh.behavioral
// extension validation.
const ModelConfigSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string', minLength: 1 },
    modelId: { type: 'string', minLength: 1 },
    endpointUrl: { type: 'string', minLength: 1 },
    apiKeyRef: { type: 'string', nullable: true },
    locality: { type: 'string', nullable: true },
  },
  required: ['provider', 'modelId', 'endpointUrl'],
  additionalProperties: false,
} as const

export const BehavioralHomeConfigSchema = {
  type: 'object',
  properties: {
    models: { type: 'array', items: ModelConfigSchema },
  },
  required: ['models'],
  additionalProperties: false,
} as unknown as JSONSchemaType<BehavioralHomeConfig>

export type ConfigLoadResult = { ok: true; config: BehavioralHomeConfig } | { ok: false; message: string }

const validateConfig = ajv.compile(BehavioralHomeConfigSchema)

/**
 * Load + validate the home config. Raw `apiKey` entries are rejected —
 * models must reference the keychain/env via `apiKeyRef`.
 */
export const parseBehavioralConfig = (text: string): ConfigLoadResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, message: `config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  // Explicit raw-apiKey check — a clear error instead of a generic
  // "additional properties" ajv message.
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const models = (parsed as { models?: unknown }).models
    if (Array.isArray(models)) {
      for (const m of models) {
        if (typeof m === 'object' && m !== null && 'apiKey' in m) {
          return { ok: false, message: 'config.json models must use apiKeyRef, not a raw apiKey' }
        }
      }
    }
  }
  if (!validateConfig(parsed)) {
    return { ok: false, message: `Invalid config.json: ${ajv.errorsText(validateConfig.errors)}` }
  }
  return { ok: true, config: parsed as BehavioralHomeConfig }
}

/** Read the home config from disk; absent file = empty model fleet. */
export const loadBehavioralConfig = async (home: string): Promise<ConfigLoadResult> => {
  const file = Bun.file(path.join(home, CONFIG_FILE))
  if (!(await file.exists())) return { ok: true, config: { models: [] } }
  return parseBehavioralConfig(await file.text())
}

// ---------------------------------------------------------------------------
// Provisioning — idempotent: skeleton + git init + .gitignore + seed config
// ---------------------------------------------------------------------------

export type ProvisionResult = {
  root: string
  gitInitialized: boolean
  gitignoreWritten: boolean
  configSeeded: boolean
}

const CONFIG_SEED = JSON.stringify({ models: [] })

/**
 * Idempotently provision the behavioral home: create the root-space
 * skeleton, `git init` if absent, write `.gitignore` (db.sqlite, logs/) and
 * a seed config.json — each only if missing. Never clobbers user edits.
 */
export const provisionBehavioralHome = async (home: string = behavioralHomeRoot()): Promise<ProvisionResult> => {
  const tree = spacePaths(home, ROOT_SPACE)
  await Bun.$`mkdir -p ${tree.threads} ${tree.html} ${tree.logsArchive}`.quiet()

  let gitInitialized = false
  const gitDir = path.join(home, '.git')
  const isRepo = (await Bun.$`test -d ${gitDir}`.quiet().nothrow()).exitCode === 0
  if (!isRepo) {
    await Bun.$`git init -q ${home}`.quiet()
    gitInitialized = true
  }

  let gitignoreWritten = false
  const gitignorePath = path.join(home, '.gitignore')
  if (!(await Bun.file(gitignorePath).exists())) {
    await Bun.write(gitignorePath, GITIGNORE_CONTENT)
    gitignoreWritten = true
  }

  let configSeeded = false
  const configPath = path.join(home, CONFIG_FILE)
  if (!(await Bun.file(configPath).exists())) {
    await Bun.write(configPath, CONFIG_SEED)
    configSeeded = true
  }

  return { root: home, gitInitialized, gitignoreWritten, configSeeded }
}

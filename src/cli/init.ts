/**
 * `behavioral init` — generate the harness config (and optional custom
 * provider entries) under the behavioral home.
 *
 * @remarks
 * Two surfaces over one runner:
 *
 * - **agents** — the framework-native JSON command: `behavioral init '{...}'`
 *   with `--schema input|output`, `--dry-run`, `--help`. Absent faculties
 *   default on (TypeSafe/OpenAI urls); `null` omits a faculty; api keys ride as
 *   env-var-NAME references that fail fast when unset — never literals.
 * - **humans** — with no input and a TTY (or `--interactive`), a prompt tour
 *   collects the same {@link InitInput} through an injectable `ask` seam and
 *   hands it to the same runner.
 *
 * Provider scaffolding writes `<home>/providers/<file>` — a provider entry
 * that imports the faculty factory by bare specifier (resolvable anywhere under
 * the global install) — and points the faculty's `entry` at it (relative paths
 * resolve against the home, per `resolveFacultyEntry`).
 *
 * @packageDocumentation
 */

import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { JSONSchemaType } from 'ajv'
import { behavioralHome } from '../faculties/behavioral-home.ts'
import { makeCli } from './cli.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A System One endpoint spec — every field has a default; `apiKeyEnv` is an env var NAME, never a key. */
export type SystemOneEndpointInit = {
  url?: string
  model?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
}

/** A System Two endpoint spec (one per provider label) — `url` is required; `apiKeyEnv` is an env var NAME. */
export type SystemTwoEndpointInit = {
  url: string
  apiKeyEnv?: string
  headers?: Record<string, string>
}

/** A custom provider entry to scaffold under `<home>/providers/`. */
export type ProviderScaffold = {
  faculty: 'systemOne' | 'systemTwo'
  /** A bare file name (no path components) ending in `.ts`. */
  file: string
}

export type InitInput = {
  /** Absent → the default TypeSafe endpoint; `null` → the faculty is omitted. */
  systemOne?: SystemOneEndpointInit | null
  /** Absent → the default OpenAI endpoint; `null` → the faculty is omitted. */
  systemTwo?: { endpoints?: Record<string, SystemTwoEndpointInit> } | null
  providers?: ProviderScaffold[]
  /** Overwrite an existing config (and provider files). */
  force?: boolean
}

export type InitOutput = {
  home: string
  configPath: string
  files: string[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SYSTEM_ONE_DEFAULTS: Required<Omit<SystemOneEndpointInit, 'headers'>> = {
  url: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  apiKeyEnv: 'TYPESAFE_API_KEY',
}

const SYSTEM_TWO_DEFAULT_LABEL = 'openai'
const SYSTEM_TWO_DEFAULTS = {
  url: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
}

// ---------------------------------------------------------------------------
// Schemas (the CLI trust boundary — `--schema input|output` reflects these)
// ---------------------------------------------------------------------------

const systemOneEndpointSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    model: { type: 'string' },
    apiKeyEnv: { type: 'string' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
  },
  additionalProperties: false,
} as const

const systemTwoEndpointSchema = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    apiKeyEnv: { type: 'string' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['url'],
  additionalProperties: false,
} as const

export const InitInputSchema = {
  type: 'object',
  properties: {
    systemOne: { oneOf: [systemOneEndpointSchema, { type: 'null' }] },
    systemTwo: {
      oneOf: [
        {
          type: 'object',
          properties: { endpoints: { type: 'object', additionalProperties: systemTwoEndpointSchema } },
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    providers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          faculty: { type: 'string', enum: ['systemOne', 'systemTwo'] },
          // Bare file names only — no path components, no traversal.
          file: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*\\.ts$' },
        },
        required: ['faculty', 'file'],
        additionalProperties: false,
      },
    },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
} as unknown as JSONSchemaType<InitInput>

const InitOutputSchema = {
  type: 'object',
  properties: {
    home: { type: 'string' },
    configPath: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['home', 'configPath', 'files'],
  additionalProperties: false,
} as unknown as JSONSchemaType<InitOutput>

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const providerTemplate = (faculty: 'systemOne' | 'systemTwo'): string => {
  const factory = faculty === 'systemOne' ? 'configSystemOne' : 'configSystemTwo'
  const respondType = faculty === 'systemOne' ? 'SystemOneRespond' : 'SystemTwoRespond'
  return `/**
 * A custom System ${faculty === 'systemOne' ? 'One' : 'Two'} provider entry.
 * ${factory} owns the wire plumbing (inbound lane, result envelope, cancel and
 * timeout); you own only the model call below.
 */
import { ${factory}, type ${respondType} } from '@behavioral/sh/faculties'

// MINIMAL: stub transport — replace with your call. Keep the contract: one
// validated input in; the output shape or { isError: true, message } out.
const respond: ${respondType} = async (input, { endpoint, signal }) => {
  return { model: 'custom', answers: {} }
}

if (import.meta.main) ${factory}(respond)
`
}

const envHelper = (): string =>
  [
    '// Fails fast with the variable name when a referenced secret is unset.',
    'const env = (name: string): string => {',
    '  const value = process.env[name]',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted into the generated config, not interpolated here
    '  if (value === undefined) throw new Error(`missing required environment variable ${name}`)',
    '  return value',
    '}',
    '',
  ].join('\n')

/** A single-quoted TS string literal — the generated file follows repo style. */
const ts = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** A single-line TS object literal over string values. */
const tsObject = (record: Record<string, string>): string =>
  `{ ${Object.entries(record)
    .map(([key, value]) => `${ts(key)}: ${ts(value)}`)
    .join(', ')} }`

const renderConfig = ({
  systemOne,
  systemTwo,
  entryByFaculty,
}: {
  systemOne?: Required<Omit<SystemOneEndpointInit, 'headers'>> & { headers?: Record<string, string> }
  systemTwo?: { endpoints: Record<string, SystemTwoEndpointInit> }
  entryByFaculty: Map<'systemOne' | 'systemTwo', string>
}): string => {
  const usesEnv =
    (systemOne !== undefined && systemOne.apiKeyEnv !== undefined) ||
    (systemTwo !== undefined && Object.values(systemTwo.endpoints).some((spec) => spec.apiKeyEnv !== undefined))

  const helpers = useHelpers(systemOne, systemTwo)
  const imports = [
    "import { defineConfig } from '@behavioral/sh'",
    `import { ${helpers.sort().join(', ')} } from '@behavioral/sh/faculties'`,
  ]
  const lines: string[] = [
    '// Generated by `behavioral init` — executable config; edit freely.',
    ...imports,
    '',
    ...(usesEnv ? [envHelper()] : []),
    'export default defineConfig({',
  ]

  if (systemOne !== undefined) {
    lines.push('  systemOne: useSystemOne({', '    endpoint: {')
    lines.push(`      url: ${ts(systemOne.url)},`)
    lines.push(`      model: ${ts(systemOne.model)},`)
    if (systemOne.apiKeyEnv !== undefined) lines.push(`      apiKey: env(${ts(systemOne.apiKeyEnv)}),`)
    if (systemOne.headers !== undefined) lines.push(`      headers: ${tsObject(systemOne.headers)},`)
    lines.push('    },')
    const entry = entryByFaculty.get('systemOne')
    if (entry !== undefined) lines.push(`    entry: ${ts(entry)},`)
    lines.push('  }),')
  }

  if (systemTwo !== undefined) {
    lines.push('  systemTwo: useSystemTwo({', '    endpoints: {')
    for (const [label, spec] of Object.entries(systemTwo.endpoints)) {
      lines.push(`      ${ts(label)}: {`)
      lines.push(`        url: ${ts(spec.url)},`)
      if (spec.apiKeyEnv !== undefined) lines.push(`        apiKey: env(${ts(spec.apiKeyEnv)}),`)
      if (spec.headers !== undefined) lines.push(`        headers: ${tsObject(spec.headers)},`)
      lines.push('      },')
    }
    lines.push('    },')
    const entry = entryByFaculty.get('systemTwo')
    if (entry !== undefined) lines.push(`    entry: ${ts(entry)},`)
    lines.push('  }),')
  }

  lines.push('})', '')
  return lines.join('\n')
}

const useHelpers = (systemOne: unknown, systemTwo: unknown): string[] => [
  ...(systemOne === undefined ? [] : ['useSystemOne']),
  ...(systemTwo === undefined ? [] : ['useSystemTwo']),
]

// ---------------------------------------------------------------------------
// The runner (shared by the JSON command and the interactive tour)
// ---------------------------------------------------------------------------

export const runInit = async (input: InitInput): Promise<InitOutput> => {
  const home = behavioralHome()
  const files: string[] = []

  const configPath = join(home, 'config.ts')
  if ((await Bun.file(configPath).exists()) && input.force !== true) {
    throw new Error(`config already exists at ${configPath} — rerun with {"force": true} to overwrite`)
  }

  // Scaffold provider entries first — the config references their paths.
  const entryByFaculty = new Map<'systemOne' | 'systemTwo', string>()
  if (input.providers !== undefined) {
    for (const provider of input.providers) {
      if (entryByFaculty.has(provider.faculty)) {
        throw new Error(`only one provider per faculty — a second ${provider.faculty} entry was requested`)
      }
      const providerPath = `providers/${provider.file}`
      await Bun.write(join(home, providerPath), providerTemplate(provider.faculty))
      files.push(providerPath)
      entryByFaculty.set(provider.faculty, providerPath)
    }
  }

  const systemOne = input.systemOne === null ? undefined : { ...SYSTEM_ONE_DEFAULTS, ...(input.systemOne ?? {}) }
  const systemTwo =
    input.systemTwo === null
      ? undefined
      : input.systemTwo?.endpoints === undefined
        ? { endpoints: { [SYSTEM_TWO_DEFAULT_LABEL]: SYSTEM_TWO_DEFAULTS } }
        : { endpoints: input.systemTwo.endpoints }

  await Bun.write(configPath, renderConfig({ systemOne, systemTwo, entryByFaculty }))
  files.unshift('config.ts')
  return { home, configPath, files }
}

// ---------------------------------------------------------------------------
// The interactive tour (injectable ask — scripted in tests, readline at the bin)
// ---------------------------------------------------------------------------

/** One prompt: a question with an optional default (empty answer keeps it). */
export type Ask = (question: string, defaultValue?: string) => Promise<string>

const answered = (value: string, fallback: boolean): boolean => {
  const trimmed = value.trim().toLowerCase()
  return trimmed === '' ? fallback : trimmed === 'y' || trimmed === 'yes'
}

/** The ask contract: an empty answer means the prompt's default. */
const withDefault = (value: string, defaultValue: string): string => {
  const trimmed = value.trim()
  return trimmed === '' ? defaultValue : trimmed
}

/** Collect an {@link InitInput} through the given `ask` seam — a confirmation tour, defaults pre-filled. */
export const collectInitInput = async (ask: Ask): Promise<InitInput> => {
  const input: InitInput = {}

  if (answered(await ask('Enable System One (TypeSafe Decisions)? [Y/n]', 'y'), true)) {
    const url = withDefault(await ask('System One URL', SYSTEM_ONE_DEFAULTS.url), SYSTEM_ONE_DEFAULTS.url)
    const model = withDefault(await ask('System One model', SYSTEM_ONE_DEFAULTS.model), SYSTEM_ONE_DEFAULTS.model)
    const apiKeyEnv = withDefault(
      await ask('System One API key env var', SYSTEM_ONE_DEFAULTS.apiKeyEnv),
      SYSTEM_ONE_DEFAULTS.apiKeyEnv,
    )
    input.systemOne = { url, model, apiKeyEnv }
  } else {
    input.systemOne = null
  }

  if (answered(await ask('Enable System Two (Open Responses)? [Y/n]', 'y'), true)) {
    const url = withDefault(await ask('System Two URL', SYSTEM_TWO_DEFAULTS.url), SYSTEM_TWO_DEFAULTS.url)
    const apiKeyEnv = withDefault(
      await ask('System Two API key env var', SYSTEM_TWO_DEFAULTS.apiKeyEnv),
      SYSTEM_TWO_DEFAULTS.apiKeyEnv,
    )
    input.systemTwo = { endpoints: { [SYSTEM_TWO_DEFAULT_LABEL]: { url, apiKeyEnv } } }
  } else {
    input.systemTwo = null
  }

  if (answered(await ask('Scaffold a custom provider entry? [y/N]', 'n'), false)) {
    const faculty = withDefault(await ask('Provider faculty (systemOne | systemTwo)', 'systemOne'), 'systemOne') as
      | 'systemOne'
      | 'systemTwo'
    const file = withDefault(await ask('Provider file name', 'my-one.faculty.ts'), 'my-one.faculty.ts')
    input.providers = [{ faculty, file }]
  }

  return input
}

// ---------------------------------------------------------------------------
// The command: interactive when empty+TTY (or forced); JSON otherwise
// ---------------------------------------------------------------------------

const INIT_HELP = `Generate <BEHAVIORAL_HOME>/config.ts (plus optional provider entries).

Run with no input at a terminal for the interactive tour; piped stdin or a JSON
positional is the agent path. Input fields (all optional):
  systemOne  {"url", "model", "apiKeyEnv", "headers"} | null   null omits the faculty
  systemTwo  {"endpoints": {"<label>": {"url", "apiKeyEnv", "headers"}}} | null
  providers  [{"faculty": "systemOne" | "systemTwo", "file": "name.faculty.ts"}]
  force      Overwrite an existing config

Absent faculties default on (TypeSafe + OpenAI urls, env-var-name api keys).`

const command = makeCli({
  name: 'init',
  inputSchema: InitInputSchema,
  outputSchema: InitOutputSchema,
  help: INIT_HELP,
  run: runInit,
})

/**
 * The `init` entry: the interactive tour when there is no input and stdin is a
 * TTY; the framework JSON command otherwise (piped stdin is the agent path).
 */
export const init = async (args: string[]): Promise<void> => {
  const hasPositional = args.some((arg) => !arg.startsWith('-'))
  if (!hasPositional && process.stdin.isTTY) {
    // MINIMAL: the readline ask is the one untested sliver — the collector it
    // feeds is scripted in the specs, and the PTY e2e drives the real prompts;
    // upgrade path: none needed unless prompt rendering itself regresses.
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const ask: Ask = (question, defaultValue) =>
        new Promise((resolve) => {
          const suffix = defaultValue === undefined ? '' : ` [${defaultValue}]`
          rl.question(`${question}${suffix}: `, (answer) => resolve(answer))
        })
      const input = await collectInitInput(ask)
      console.log(JSON.stringify(await runInit(input), null, 2))
    } finally {
      rl.close()
    }
    return
  }
  await command.init(args)
}

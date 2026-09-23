import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { behavioralHome } from '../faculties/behavioral-home.ts'
import type { bProgram } from './b-program.ts'

/**
 * The host config shape — the {@link bProgram} options a `config.ts` may
 * set. A config file default-exports a value of this shape.
 *
 * @public
 */
export type BehavioralConfig = Parameters<typeof bProgram>[0]

/** The selectable faculties a config may enable (mirrors the `Faculty` union). */
const KNOWN_FACULTIES: readonly string[] = ['shell', 'store', 'mcp']

const invalid = (configPath: string, detail: string): never => {
  throw new Error(`invalid config at ${configPath}: ${detail}`)
}

/** Validate the trusted config's shape — fail fast with the path and a fix hint. */
const validate = (value: unknown, configPath: string): BehavioralConfig => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(configPath, 'expected a default-exported object like `export default { faculties: [...] }`')
  }
  const config = value as Record<string, unknown>
  if (config.faculties !== undefined) {
    const faculties = config.faculties
    if (!Array.isArray(faculties) || faculties.some((name) => typeof name !== 'string')) {
      invalid(configPath, '"faculties" must be an array of faculty names')
    }
    const unknown = (faculties as string[]).filter((name) => !KNOWN_FACULTIES.includes(name))
    if (unknown.length > 0) {
      invalid(
        configPath,
        `unknown faculty ${unknown.map((name) => `"${name}"`).join(', ')} — expected one of: ${KNOWN_FACULTIES.join(', ')}`,
      )
    }
  }
  for (const key of ['shell', 'store', 'systemOne', 'systemTwo'] as const) {
    const override = config[key]
    if (override !== undefined && typeof override !== 'function') {
      const got = override === null ? 'null' : typeof override
      invalid(configPath, `"${key}" must be a useFaculty(...) override (a curried function), got ${got}`)
    }
  }
  return config as BehavioralConfig
}

/**
 * Load the harness config from `configPath`, defaulting to `<BEHAVIORAL_HOME>/config.ts`.
 *
 * @remarks
 * The file is **executable config** — trusted, user-owned machine state,
 * dynamically imported so it can carry live values (the `faculties` array and
 * `useFaculty(...)` overrides). A missing file yields the empty config, so the
 * composition defaults apply; an unloadable file or an invalid shape throws
 * with the path and a fix hint.
 *
 * @public
 */
export const loadConfig = async (
  configPath: string = join(behavioralHome(), 'config.ts'),
): Promise<BehavioralConfig> => {
  if (!(await Bun.file(configPath).exists())) return {}
  let module: { default?: unknown }
  try {
    module = (await import(pathToFileURL(configPath).href)) as { default?: unknown }
  } catch (error) {
    throw new Error(`invalid config at ${configPath}: failed to load — ${(error as Error).message}`)
  }
  if (module.default === undefined) invalid(configPath, 'no default export — add `export default { ... }`')
  return validate(module.default, configPath)
}

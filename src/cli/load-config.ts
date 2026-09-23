import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { behavioralHome } from '../behaviors/behavioral-home.ts'
import type { getBehavioral } from '../behaviors/get-behavioral.ts'

/**
 * The host config shape — the {@link getBehavioral} options a `config.ts` may
 * set. A config file default-exports a value of this shape.
 *
 * @public
 */
export type BehavioralConfig = Parameters<typeof getBehavioral>[0]

/** The selectable behaviors a config may enable (mirrors the `Behavior` union). */
const KNOWN_BEHAVIORS: readonly string[] = ['shell', 'responses', 'store', 'mcp']

const invalid = (configPath: string, detail: string): never => {
  throw new Error(`invalid config at ${configPath}: ${detail}`)
}

/** Validate the trusted config's shape — fail fast with the path and a fix hint. */
const validate = (value: unknown, configPath: string): BehavioralConfig => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(configPath, 'expected a default-exported object like `export default { behaviors: [...] }`')
  }
  const config = value as Record<string, unknown>
  if (config.behaviors !== undefined) {
    const behaviors = config.behaviors
    if (!Array.isArray(behaviors) || behaviors.some((name) => typeof name !== 'string')) {
      invalid(configPath, '"behaviors" must be an array of behavior names')
    }
    const unknown = (behaviors as string[]).filter((name) => !KNOWN_BEHAVIORS.includes(name))
    if (unknown.length > 0) {
      invalid(
        configPath,
        `unknown behavior ${unknown.map((name) => `"${name}"`).join(', ')} — expected one of: ${KNOWN_BEHAVIORS.join(', ')}`,
      )
    }
  }
  for (const key of ['shell', 'store'] as const) {
    const override = config[key]
    if (override !== undefined && typeof override !== 'function') {
      const got = override === null ? 'null' : typeof override
      invalid(configPath, `"${key}" must be a useBehavior(...) override (a curried function), got ${got}`)
    }
  }
  return config as BehavioralConfig
}

/**
 * Load the harness config from `configPath`, defaulting to `<BEHAVIORAL_HOME>/config.ts`.
 *
 * @remarks
 * The file is **executable config** — trusted, user-owned machine state,
 * dynamically imported so it can carry live values (the `behaviors` array and
 * `useBehavior(...)` overrides). A missing file yields the empty config, so the
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

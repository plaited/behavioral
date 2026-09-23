import { pathToFileURL } from 'node:url'
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

/** Validate the trusted config's shape — fail fast with the path on any deviation. */
const validate = (value: unknown, configPath: string): BehavioralConfig => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(configPath, 'expected a default-exported object')
  }
  const config = value as Record<string, unknown>
  if (config.behaviors !== undefined) {
    const behaviors = config.behaviors
    if (!Array.isArray(behaviors) || behaviors.some((b) => typeof b !== 'string' || !KNOWN_BEHAVIORS.includes(b))) {
      invalid(configPath, `unknown behavior in ${JSON.stringify(behaviors)}`)
    }
  }
  for (const key of ['shell', 'store'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'function') {
      invalid(configPath, `"${key}" must be a useBehavior(...) override`)
    }
  }
  return config as BehavioralConfig
}

/**
 * Load the harness config from `configPath` (by default `<BEHAVIORAL_HOME>/config.ts`).
 *
 * @remarks
 * The file is **executable config** — trusted, user-owned machine state,
 * dynamically imported so it can carry live values (the `behaviors` array and
 * `useBehavior(...)` overrides). A missing file yields the empty config, so the
 * composition defaults apply; a present file with an invalid shape throws with
 * the path.
 *
 * @public
 */
export const loadConfig = async (configPath: string): Promise<BehavioralConfig> => {
  if (!(await Bun.file(configPath).exists())) return {}
  const module = (await import(pathToFileURL(configPath).href)) as { default?: unknown }
  if (module.default === undefined) invalid(configPath, 'no default export')
  return validate(module.default, configPath)
}

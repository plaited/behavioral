import { isAbsolute, resolve } from 'node:path'
import { behavioralHome } from './behavioral-home.ts'

/**
 * Resolve a system behavior's provider entry path for its spawn command.
 *
 * @remarks
 * Three cases, in order: no `entry` keeps the bundled provider (this package's
 * own `src/behaviors/` directory); an absolute path is used verbatim; a
 * relative path resolves against the {@link behavioralHome} — where
 * `behavioral init` scaffolds user provider entries — never the package's
 * spawn cwd.
 *
 * @public
 */
export const resolveBehaviorEntry = (entry: string | undefined, bundled: string): string => {
  if (entry === undefined) return resolve(import.meta.dir, bundled)
  return isAbsolute(entry) ? entry : resolve(behavioralHome(), entry)
}

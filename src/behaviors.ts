/**
 * The behaviors public surface — what a `config.ts` override composes with.
 *
 * @remarks
 * Exposes the override thread packs (`shellThreads`, `mcpThreads`), their
 * schemas and types, the `Behavior` union, and `useBehavior`. The default root
 * pack (`behaviorsThreads`) is internal — the composition always mounts it — and
 * is intentionally NOT exported. The runtime composition itself (`bProgram`)
 * lives in `src/cli/b-program.ts`.
 *
 * @packageDocumentation
 */

/** The selectable capability families (the `bProgram` allow-list). */
export type Behavior = 'shell' | 'responses' | 'store' | 'mcp'

export * from './behaviors/behaviors.types.ts'
export { mcpThreads } from './behaviors/mcp.threads.ts'
export { shellThreads } from './behaviors/shell.threads.ts'
export * from './behaviors/shell.types.ts'
export * from './behaviors/store.types.ts'
export { useBehavior } from './behaviors/use-behavior.ts'

/**
 * The behaviors public surface — the types, schemas, thread packs, and the
 * process primitive a `config.ts` composes with.
 *
 * @remarks
 * The runtime composition itself (`bProgram`) lives in the host
 * (`src/cli/b-program.ts`); this boundary is what a config imports:
 * `useBehavior`, the wire validators/schemas, and the shipped thread packs.
 *
 * @packageDocumentation
 */

/** The selectable capability families (the `bProgram` allow-list). */
export type Behavior = 'shell' | 'responses' | 'store' | 'mcp'

export { behaviorsThreads } from './behaviors/behaviors.threads.ts'
export * from './behaviors/behaviors.types.ts'
export { mcpThreads } from './behaviors/mcp.threads.ts'
export { shellThreads } from './behaviors/shell.threads.ts'
export { useBehavior } from './behaviors/use-behavior.ts'

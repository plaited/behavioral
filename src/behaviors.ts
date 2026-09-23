/**
 * The behaviors public surface — what a `config.ts` override composes with.
 *
 * @remarks
 * Exposes the override thread packs (`shellThreads`, `mcpThreads`), their
 * schemas and types, the `Behavior` union, `useBehavior`, and the System Two
 * config surface (`configSystemTwo` for a provider entry; `useSystemTwo` for
 * the host). The default root pack (`behaviorsThreads`) is internal — the
 * composition always mounts it — and is intentionally NOT exported. The runtime
 * composition itself (`bProgram`) lives in `src/cli/b-program.ts`.
 *
 * @packageDocumentation
 */

/** The selectable capability behaviors (the `bProgram` allow-list). */
export type Behavior = 'shell' | 'store' | 'mcp'

export * from './behaviors/behaviors.types.ts'
export * from './behaviors/mcp/threads.ts'
export * from './behaviors/mcp/types.ts'
export * from './behaviors/shell/threads.ts'
export * from './behaviors/shell/types.ts'
export * from './behaviors/store/threads.ts'
export * from './behaviors/store/types.ts'
export * from './behaviors/system-one/config.ts'
export * from './behaviors/system-one/types.ts'
export * from './behaviors/system-two/config.ts'
export * from './behaviors/system-two/types.ts'
export * from './behaviors/use-behavior.ts'

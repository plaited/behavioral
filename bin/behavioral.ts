#!/usr/bin/env bun

// ============================================================================
// Command Registry
// ============================================================================

import { makeCliRouter } from '../src/cli/cli.ts'

export const runCli = makeCliRouter({
  name: 'behavioral',
  description: 'Agent-facing CLI for the behavioral agent harness',
  commands: {
    serve: async () => {
      // Lazy: --help/--version must not load the composition graph.
      const { serve } = await import('../src/cli/serve.ts')
      await serve()
    },
    init: async (args) => {
      // Lazy: --help/--version must not load the config/composition graph.
      const { init } = await import('../src/cli/init.ts')
      await init(args)
    },
  },
})

await runCli(Bun.argv)

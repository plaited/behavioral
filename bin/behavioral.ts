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
  },
})

await runCli(Bun.argv)

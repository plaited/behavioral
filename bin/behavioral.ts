#!/usr/bin/env bun

// ============================================================================
// Command Registry
// ============================================================================

import { makeCliRouter } from '../src/cli/cli.ts'
import { toolsCli } from '../src/cli/tools.ts'

export const runCli = makeCliRouter({
  name: 'behavioral',
  description: 'Agent-facing skill discovery CLI for the behavioral agent harness',
  commands: {
    ...toolsCli,
  },
})

await runCli(Bun.argv)

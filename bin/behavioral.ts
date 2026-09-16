#!/usr/bin/env bun

// ============================================================================
// Command Registry
// ============================================================================

import { makeCliRouter } from '../src/cli/cli.ts'
import { initCli } from '../src/cli/init.ts'
import { toolsCli } from '../src/cli/tools.ts'
import { turnCli } from '../src/cli/turn.ts'

export const runCli = makeCliRouter({
  name: 'behavioral',
  description: 'Agent-facing skill discovery CLI for the behavioral agent harness',
  commands: {
    ...initCli,
    ...toolsCli,
    ...turnCli,
  },
})

await runCli(Bun.argv)

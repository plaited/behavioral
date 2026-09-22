#!/usr/bin/env bun

// ============================================================================
// Command Registry
// ============================================================================

import { makeCliRouter } from '../src/cli/cli.ts'

export const runCli = makeCliRouter({
  name: 'behavioral',
  description: 'Agent-facing CLI for the behavioral agent harness',
  commands: {},
})

await runCli(Bun.argv)

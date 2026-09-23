#!/usr/bin/env bun
/**
 * @module betterleaks/run
 *
 * Regenerate `src/cli/credential-patterns.ts` from the pinned betterleaks
 * binary's resolved ruleset (`betterleaks config show`, invoked via `Bun.$`).
 *
 * Usage:
 *   bun run betterleaks:generate
 *
 * Prerequisite: `bun run betterleaks:install`. `config show` is resolved in a
 * clean temp cwd so a project `.betterleaks.toml` cannot leak into the output.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateCredentialPatterns } from './generate.ts'
import { BIN_NAME, RELEASE_VERSION } from './install.ts'

const repoRoot = join(import.meta.dir, '../..')
const binary = join(import.meta.dir, '.bin', BIN_NAME)
const output = join(repoRoot, 'src/cli/credential-patterns.ts')

if (!(await Bun.file(binary).exists())) {
  console.error('betterleaks not installed — run: bun run betterleaks:install')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'betterleaks-generate-'))
try {
  const configToml = await Bun.$`${binary} config show`.cwd(work).text()
  const { source, count, skipped } = generateCredentialPatterns(configToml, { version: RELEASE_VERSION })
  await Bun.write(output, source)
  console.log(`wrote ${count} rules to ${output}`)
  for (const entry of skipped) console.log(`  skipped ${entry.id}: ${entry.reason}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

#!/usr/bin/env bun
/**
 * @module css-schemas/run
 *
 * Standalone script to generate or diff-check CSS property schemas from @webref/css.
 *
 * Usage:
 *   bun run scripts/css-schemas/run.ts generate [--dry-run]
 *   bun run scripts/css-schemas/run.ts diff
 *
 * Intended for use in `.github/workflows/` CI and via package.json scripts.
 * This is NOT a user-facing CLI — it is a repo-internal dev tool.
 */

import * as path from 'node:path'
import { generateCssSchemas } from './generate.ts'

// ============================================================================
// Config
// ============================================================================

const DEFAULT_OUTPUT_PATH = 'src/controller/css.schemas.ts'

// ============================================================================
// Helpers
// ============================================================================

/**
 * Produce a minimal unified-style line diff between two strings.
 * MINIMAL: line-diff, upgrade to `diff` npm pkg if richer output needed.
 */
const lineDiff = (a: string, b: string): string => {
  if (a === b) return ''

  const aLines = a.split('\n')
  const bLines = b.split('\n')
  const maxLen = Math.max(aLines.length, bLines.length)
  const lines: string[] = []

  for (let i = 0; i < maxLen; i++) {
    const aLine = aLines[i]
    const bLine = bLines[i]
    if (aLine === bLine) {
      if (aLine !== undefined) lines.push(` ${aLine}`)
    } else {
      if (aLine !== undefined) lines.push(`-${aLine}`)
      if (bLine !== undefined) lines.push(`+${bLine}`)
    }
  }

  return ['--- original', '+++ generated', ...lines].join('\n')
}

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  const args = process.argv.slice(2)
  const mode = args[0] as 'generate' | 'diff' | undefined
  const isDryRun = args.includes('--dry-run')
  const outputPath = DEFAULT_OUTPUT_PATH

  if (!mode || (mode !== 'generate' && mode !== 'diff')) {
    console.error('Usage: bun run scripts/css-schemas/run.ts <generate|diff> [--dry-run]')
    process.exit(1)
  }

  // Resolve paths relative to repo root (two levels up from this script)
  const repoRoot = path.resolve(import.meta.dir, '../..')
  const cssDataPath = Bun.resolveSync('@webref/css/css.json', import.meta.dir)
  const outputPathResolved = path.resolve(repoRoot, outputPath)

  // Read @webref/css data
  const cssFile = Bun.file(cssDataPath)
  if (!(await cssFile.exists())) {
    console.error('@webref/css not installed — run `bun add -d @webref/css css-tree` from a repo checkout.')
    process.exit(1)
  }
  const cssJson = await cssFile.json()

  // Generate the schema
  const { code: rawCode, propertyCount, keywordEnumCount } = generateCssSchemas(cssJson)

  // Format through biome to match git pre-commit hook style
  const tmpFile = path.resolve('/tmp/.css-schemas-tmp.ts')
  await Bun.$`mkdir -p ${path.dirname(tmpFile)}`.quiet().nothrow()
  await Bun.write(tmpFile, rawCode)
  const fmtResult = await Bun.$`bunx biome check --write --unsafe ${tmpFile}`.quiet().nothrow()
  const code = fmtResult.exitCode === 0 ? await Bun.file(tmpFile).text() : rawCode
  await Bun.write(tmpFile, '').catch(() => {})

  if (mode === 'generate') {
    if (isDryRun) {
      const existingContent = await Bun.file(outputPathResolved).text()
      const changed = existingContent !== code
      const result = {
        path: outputPath,
        bytes: new TextEncoder().encode(code).length,
        propertyCount,
        keywordEnumCount,
        changed,
        dryRun: true,
      }
      console.log(JSON.stringify(result, null, 2))
    } else {
      await Bun.write(outputPathResolved, code)
      const result = {
        path: outputPath,
        bytes: new TextEncoder().encode(code).length,
        propertyCount,
        keywordEnumCount,
        changed: true,
      }
      console.log(JSON.stringify(result, null, 2))
    }
  } else {
    // mode: diff
    const committedFile = Bun.file(outputPathResolved)
    const committedExists = await committedFile.exists()

    if (!committedExists) {
      const result = {
        path: outputPath,
        bytes: new TextEncoder().encode(code).length,
        propertyCount,
        keywordEnumCount,
        changed: true,
        diff: lineDiff('', code),
      }
      console.log(JSON.stringify(result, null, 2))
      process.exit(1)
    }

    const committed = await committedFile.text()
    const changed = committed !== code

    const result = {
      path: outputPath,
      bytes: new TextEncoder().encode(code).length,
      propertyCount,
      keywordEnumCount,
      changed,
      diff: changed ? lineDiff(committed, code) : undefined,
    }
    console.log(JSON.stringify(result, null, 2))

    if (changed) {
      process.exit(1)
    }
  }
}

await main().catch((err) => {
  console.error(err)
  process.exit(1)
})

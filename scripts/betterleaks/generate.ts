/**
 * @module betterleaks/generate
 *
 * Convert betterleaks' resolved ruleset (TOML) into the zero-dependency
 * `src/cli/credential-patterns.ts` module.
 *
 * @remarks
 * betterleaks rules are detection rules — regex + keywords + an Expr
 * `filter` (entropy / token-efficiency) + optional `validate`. Redaction
 * only needs the regex and the keyword prefilter, and it over-redacts
 * rather than under-redacts, so every `filter`/`validate` is dropped.
 *
 * Go/RE2 → JS translations: inline `(?i)`/`(?m)` are hoisted to flags (JS
 * rejects them inline), `(?P<name>` → `(?<name>`, `\z` → `$`. POSIX classes
 * (`[[:alnum:]]`) have no JS equivalent, so those rules are skipped. Every
 * converted pattern is test-compiled; failures are reported, not emitted.
 *
 * The broad `generic-*` rules are intentionally excluded: without their Expr
 * entropy/context filters they degenerately match any `key = value` text.
 */

export type ConvertedRule = {
  id: string
  description: string
  /** Regex source, JS-compatible. */
  source: string
  /** Regex flags, always including `g` so every match is redacted. */
  flags: string
  keywords: string[]
}

export type SkippedRule = { id: string; reason: string }
export type Conversion = { rules: ConvertedRule[]; skipped: SkippedRule[] }

/** Inline flag groups JS rejects — `(?i)`, `(?m)`, `(?im)`. Scoped `(?-i:)` is left intact. */
const INLINE_FLAGS = /\(\?([ims]+)\)/g
const GO_NAMED_GROUP = /\(\?P<([A-Za-z0-9_]+)>/g
const GENERIC_RULE = /^generic-/

export const toJsRegex = (goRegex: string): { source: string; flags: string } => {
  const flags = new Set(['g'])
  let source = goRegex.replace(INLINE_FLAGS, (_match, inline: string) => {
    for (const flag of inline) flags.add(flag)
    return ''
  })
  source = source.replace(GO_NAMED_GROUP, (_match, name: string) => `(?<${name}>`)
  source = source.replace(/\\z/g, () => '$')
  return { source, flags: [...flags].sort().join('') }
}

/** Parse a resolved betterleaks config and convert its rules. */
export const convertRules = (configToml: string): Conversion => {
  const parsed = Bun.TOML.parse(configToml) as { rules?: Array<Record<string, unknown>> }
  const rules: ConvertedRule[] = []
  const skipped: SkippedRule[] = []

  for (const raw of parsed.rules ?? []) {
    const id = typeof raw.id === 'string' ? raw.id : undefined
    if (id === undefined) continue
    if (GENERIC_RULE.test(id)) {
      skipped.push({ id, reason: 'generic rule — depends on its dropped Expr filter' })
      continue
    }
    const goRegex = typeof raw.regex === 'string' ? raw.regex : undefined
    if (goRegex === undefined) {
      skipped.push({ id, reason: 'no regex (path-only rule)' })
      continue
    }
    if (goRegex.includes('[[:')) {
      skipped.push({ id, reason: 'POSIX character class (JS-unsupported)' })
      continue
    }
    const { source, flags } = toJsRegex(goRegex)
    try {
      new RegExp(source, flags)
    } catch (error) {
      skipped.push({ id, reason: `uncompilable: ${(error as Error).message}` })
      continue
    }
    rules.push({
      id,
      description: typeof raw.description === 'string' ? raw.description : '',
      source,
      flags,
      keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((k): k is string => typeof k === 'string') : [],
    })
  }

  return { rules, skipped }
}

/** Render the generated module source. Stable output — this file is the sole writer. */
export const renderCredentialPatterns = (rules: ConvertedRule[], meta: { version: string }): string => {
  const header = [
    '// AUTO-GENERATED — do not edit. Regenerate with `bun run betterleaks:generate`.',
    `// Source: betterleaks ${meta.version} \`config show\` — the pinned binary's embedded ruleset.`,
    `// ${rules.length} provider rules. The broad generic-* rules and every detection-time`,
    '// Expr filter (entropy / token-efficiency) are intentionally excluded/dropped:',
    '// redaction over-redacts rather than under-redacts.',
    '',
  ]
  const body = rules.map(
    (rule) =>
      `  { id: ${JSON.stringify(rule.id)}, description: ${JSON.stringify(rule.description)}, pattern: new RegExp(${JSON.stringify(rule.source)}, ${JSON.stringify(rule.flags)}), keywords: ${JSON.stringify(rule.keywords)} },`,
  )
  return [
    ...header,
    '/** A compiled provider credential rule (betterleaks-derived). */',
    'export type CredentialRule = {',
    '  id: string',
    '  description: string',
    '  pattern: RegExp',
    '  keywords: string[]',
    '}',
    '',
    'export const CREDENTIAL_RULES: CredentialRule[] = [',
    ...body,
    ']',
    '',
  ].join('\n')
}

/** Convert a resolved config TOML into the generated module source plus a skip report. */
export const generateCredentialPatterns = (
  configToml: string,
  meta: { version: string },
): { source: string; count: number; skipped: SkippedRule[] } => {
  const { rules, skipped } = convertRules(configToml)
  return { source: renderCredentialPatterns(rules, meta), count: rules.length, skipped }
}

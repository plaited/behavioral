/**
 * @module betterleaks/generate.spec
 *
 * Tests for the betterleaks → JS pattern conversion: inline-flag hoisting,
 * Go/RE2 syntax translation, rule filtering, and compilation validity.
 */

import { describe, expect, test } from 'bun:test'
import { convertRules, generateCredentialPatterns, toJsRegex } from '../generate.ts'

describe('toJsRegex', () => {
  test('hoists (?i) to the i flag and strips the token', () => {
    expect(toJsRegex('(?i)abc')).toEqual({ source: 'abc', flags: 'gi' })
  })

  test('hoists (?m) and combined (?im)', () => {
    expect(toJsRegex('(?m)a')).toEqual({ source: 'a', flags: 'gm' })
    expect(toJsRegex('(?im)a')).toEqual({ source: 'a', flags: 'gim' })
  })

  test('keeps scoped (?-i:) modifiers intact', () => {
    expect(toJsRegex('(?-i:a)')).toEqual({ source: '(?-i:a)', flags: 'g' })
  })

  test('converts Go named groups to JS', () => {
    expect(toJsRegex('(?P<name>a)')).toEqual({ source: '(?<name>a)', flags: 'g' })
  })

  test('converts RE2 end-of-text \\z to $', () => {
    expect(toJsRegex('a\\z')).toEqual({ source: 'a$', flags: 'g' })
  })
})

const FIXTURE = `[[rules]]
id = "github-pat"
description = "GitHub PAT"
regex = '''ghp_[0-9a-zA-Z]{36}'''
keywords = ["ghp_"]

[[rules]]
id = "generic-api-key"
description = "Generic"
regex = '''(?i)key = (.+)'''
keywords = ["key"]

[[rules]]
id = "path-only"
keywords = ["x"]

[[rules]]
id = "airtable"
description = "POSIX"
regex = '''[[:alnum:]]+'''
keywords = ["airtable"]
`

describe('convertRules', () => {
  test('excludes generic-* and path-only rules, reporting them as skipped', () => {
    const { rules, skipped } = convertRules(FIXTURE)
    expect(rules.map((rule) => rule.id)).toEqual(['github-pat'])
    expect(skipped.map((entry) => entry.id)).toEqual(['generic-api-key', 'path-only', 'airtable'])
  })

  test('converts the regex and keeps the keywords', () => {
    const { rules } = convertRules(FIXTURE)
    expect(rules[0]?.source).toBe('ghp_[0-9a-zA-Z]{36}')
    expect(rules[0]?.flags).toBe('g')
    expect(rules[0]?.keywords).toEqual(['ghp_'])
  })

  test('every converted pattern compiles under RegExp', () => {
    const { rules } = convertRules(FIXTURE)
    for (const rule of rules) {
      expect(() => new RegExp(rule.source, rule.flags)).not.toThrow()
    }
  })
})

describe('generateCredentialPatterns', () => {
  test('renders a typed module with the compiled rules and no generic rule', () => {
    const { source, count, skipped } = generateCredentialPatterns(FIXTURE, { version: 'v1.8.1' })
    expect(count).toBe(1)
    expect(skipped).toHaveLength(3)
    expect(source).toContain('export const CREDENTIAL_RULES')
    expect(source).toContain('github-pat')
    expect(source).not.toContain('generic-api-key')
    expect(source).toContain('new RegExp(')
  })
})

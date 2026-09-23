/**
 * @module generate.spec
 *
 * Tests for the CSS schema generator: classification logic, generated output
 * snapshot, and per-property schema in the object format.
 */

import { expect, test } from 'bun:test'
import { generateCssSchemas, type PropertyEntry } from '../generate.ts'

const entryFor = (name: string, syntax: string): PropertyEntry => ({
  name,
  syntax,
  styleDeclaration: [name],
})

// 6 hardcoded vendor entries are always added to the output
export const HARDCODED_ENTRY_COUNT = 6

test('box-sizing is pure keyword classification', () => {
  const result = generateCssSchemas({
    properties: [entryFor('box-sizing', 'content-box | border-box')],
  })
  expect(result.keywordEnumCount).toBe(1)
})

test('position has classification string-or-number', () => {
  const result = generateCssSchemas({
    properties: [entryFor('position', 'static | relative | absolute | sticky | fixed | <running()>')],
  })
  expect(result.propertyCount).toBe(1 + HARDCODED_ENTRY_COUNT)
  expect(result.keywordEnumCount).toBe(0)
})

test('clear is pure keyword classification', () => {
  const result = generateCssSchemas({
    properties: [
      entryFor(
        'clear',
        'inline-start | inline-end | block-start | block-end | left | right | top | bottom | both-inline | both-block | both | none',
      ),
    ],
  })
  expect(result.keywordEnumCount).toBe(1)
})

test('font-weight has classification string-or-number', () => {
  const result = generateCssSchemas({
    properties: [entryFor('font-weight', '<font-weight-absolute> | bolder | lighter')],
  })
  expect(result.keywordEnumCount).toBe(0)
})

test('color has classification string-or-number', () => {
  const result = generateCssSchemas({
    properties: [entryFor('color', '<color>')],
  })
  expect(result.keywordEnumCount).toBe(0)
})

test('display has classification string-or-number', () => {
  const result = generateCssSchemas({
    properties: [entryFor('display', '[ <display-outside> || <display-inside> ] | <display-listitem>')],
  })
  expect(result.keywordEnumCount).toBe(0)
})

test('only kebab-case keys from styleDeclaration, camelCase dropped', () => {
  const result = generateCssSchemas({
    properties: [
      {
        name: 'box-sizing',
        syntax: 'content-box | border-box',
        styleDeclaration: ['box-sizing', 'boxSizing'],
      },
    ],
  })
  expect(result.code).toContain('"box-sizing"')
  expect(result.code).not.toContain('"boxSizing"')
})

test('hardcoded vendor entries appear in output', () => {
  const result = generateCssSchemas({ properties: [] })
  expect(result.code).toContain('"-webkit-user-select"')
  expect(result.code).toContain('"-webkit-appearance"')
  expect(result.code).toContain('"-webkit-backdrop-filter"')
  expect(result.code).toContain('"-webkit-box-orient"')
  expect(result.code).toContain('"-webkit-hyphens"')
  expect(result.code).toContain('"-webkit-line-clamp"')
  expect(result.propertyCount).toBe(HARDCODED_ENTRY_COUNT)
})

test('generated output is schema-only — one export, no ajv, no validation functions', async () => {
  const cssDataPath = Bun.resolveSync('@webref/css/css.json', import.meta.dir)
  const cssFile = Bun.file(cssDataPath)
  const cssJson = await cssFile.json()

  const result = generateCssSchemas(cssJson)

  // The schema object is the whole module
  expect(result.code).toContain('export const CSSPropertiesSchema = {')
  expect(result.code).toContain("additionalProperties: { type: ['string', 'number'] },")

  // Schema-only: no imports, no ajv, no compiled validator, no type alias —
  // the schema is data (classifier context), not a validator module.
  expect(result.code).not.toContain('import ')
  expect(result.code).not.toContain('ajv')
  expect(result.code).not.toContain('validateCSSValue')
  expect(result.code).not.toContain('export type CSSProperties')

  const lines = result.code.split('\n')
  expect({ head: lines.slice(0, 3).join('\n'), tail: lines.slice(-3).join('\n') }).toMatchSnapshot()
})

test('all properties use generated JSON Schema value schemas', async () => {
  const cssDataPath = Bun.resolveSync('@webref/css/css.json', import.meta.dir)
  const cssFile = Bun.file(cssDataPath)
  const cssJson = await cssFile.json()

  const result = generateCssSchemas(cssJson)

  // Known properties carry their generated value schemas
  expect(result.code).toContain("\"color\": { type: ['string', 'number'] },")
  expect(result.code).toContain("\"accent-color\": { type: ['string', 'number'] },")

  // Hardcoded vendor entries emit anyOf enums
  expect(result.code).toContain(
    "\"-webkit-line-clamp\": { anyOf: [{ type: 'string', enum: ['none'] }, { type: 'number' }] },",
  )
})

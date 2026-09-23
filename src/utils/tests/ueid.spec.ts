import { expect, test } from 'bun:test'
import { ueid } from '../../utils.ts'

test('ueid: returns a string', () => {
  const output = ueid()
  expect(typeof output).toBe('string')
  expect(output.length).toBe(11)
})

test('ueid: should return unique ids', () => {
  const ids = new Array(5).fill('').map(ueid)
  const unique = [...new Set(ids)]
  expect(ids.length).toBe(5)
  expect(unique.length).toBe(5)
  for (const id of unique) {
    expect(id.length).toBe(11)
  }
})

test('ueid: supports an optional prefix', () => {
  expect(ueid('a-').startsWith('a-')).toBe(true)
  expect(ueid('b-').startsWith('b-')).toBe(true)
  expect(ueid('c:').startsWith('c:')).toBe(true)
  expect(ueid('word_').startsWith('word_')).toBe(true)
})

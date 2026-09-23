import { expect, test } from 'bun:test'
import { deepEqual } from '../../utils.ts'

test('deepEqual()', () => {
  /** Primitive values */
  expect(deepEqual('string', 'string')).toBe(true)
  expect(deepEqual('string', 'different string')).toBe(false)
  expect(deepEqual(1, 1)).toBe(true)
  expect(deepEqual(1, 0o1)).toBe(true)
  expect(deepEqual(1, 0)).toBe(false)
  expect(deepEqual(/test/i, /test/i)).toBe(true)
  expect(deepEqual(/test/i, /test/)).toBe(false)
  expect(deepEqual(/foo*/, /foo*/)).toBe(true)
  expect(deepEqual(/foo*/, /foo*/g)).toBe(false)

  /** handles falsey */
  expect(deepEqual(false, false)).toBe(true)
  expect(deepEqual(null, null)).toBe(true)
  expect(deepEqual(undefined, undefined)).toBe(true)
  expect(deepEqual(null, false)).toBe(false)
  expect(deepEqual(null, undefined)).toBe(false)
  expect(deepEqual(false, undefined)).toBe(false)

  /** Arrays */
  expect(deepEqual(['array'], ['array'])).toBe(true)
  expect(deepEqual(['array'], ['nope'])).toBe(false)

  /** Maps, sets and objects */
  expect(deepEqual(new Set(['set']), new Set(['set']))).toBe(true)
  expect(deepEqual(new Set(['set']), new Set(['nope']))).toBe(false)
  expect(deepEqual(new Map([['key', 'value']]), new Map([['key', 'value']]))).toBe(true)
  expect(deepEqual(new Map([['key', 'value']]), new Map([['key', 'nope']]))).toBe(false)

  const func = () => {
    console.error('function')
  }
  const symbolKey = Symbol('symbolKey')

  const original = {
    num: 0,
    str: '',
    boolean: true,
    unf: void 0,
    nul: null,
    obj: { name: 'object', id: 1 },
    arr: [0, 1, 2],
    func,
    date: new Date(0),
    reg: /\/regexp\/ig/,
    [symbolKey]: 'symbol',
  }

  const clone = {
    num: 0,
    str: '',
    boolean: true,
    unf: void 0,
    nul: null,
    obj: { name: 'object', id: 1 },
    arr: [0, 1, 2],
    func,
    date: new Date(0),
    reg: /\/regexp\/ig/,
    [symbolKey]: 'symbol',
  }
  expect(deepEqual(original, clone)).toBe(true)
  expect(
    deepEqual(original, {
      ...clone,
      obj: {
        name: 'color',
      },
    }),
  ).toBe(false)
})

test('deepEqual handles circular arrays and maps', () => {
  const arrayA: unknown[] = []
  arrayA.push(arrayA)
  const arrayB: unknown[] = []
  arrayB.push(arrayB)
  expect(deepEqual(arrayA, arrayB)).toBe(true)

  const mapA = new Map<string, unknown>()
  mapA.set('self', mapA)
  const mapB = new Map<string, unknown>()
  mapB.set('self', mapB)
  expect(deepEqual(mapA, mapB)).toBe(true)
})

test('deepEqual treats sets as order-insensitive collections', () => {
  expect(deepEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true)
  expect(deepEqual(new Set([{ id: 1 }, { id: 2 }]), new Set([{ id: 2 }, { id: 1 }]))).toBe(true)
})

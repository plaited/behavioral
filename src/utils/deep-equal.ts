/**
 * Deep equality comparison for any JavaScript values.
 * Handles circular references and all built-in types.
 *
 * @param objA - First value to compare
 * @param objB - Second value to compare
 * @param map - Internal WeakMap for circular reference detection
 * @returns true if values are deeply equal
 *
 * @remarks
 * Supports: primitives, objects, arrays, Date, RegExp, Map, Set, TypedArrays.
 * Uses Object.is() for NaN and +0/-0 handling.
 *
 * @see {@link isTypeOf} for type checking
 */
export const deepEqual = (objA: unknown, objB: unknown, map = new WeakMap()) => {
  /**
   * @internal
   * First-level filtering using Object.is for primitive equality.
   * Handles NaN === NaN (true) and +0 !== -0 (false) correctly.
   */
  if (Object.is(objA, objB)) return true

  /**
   * @internal
   * Special handling for Date and RegExp before generic object check.
   * These types have internal state that requires specific comparison.
   * - Date: Compare timestamps for semantic equality
   * - RegExp: Compare string representation (includes flags)
   */
  if (objA instanceof Date && objB instanceof Date) {
    return objA.getTime() === objB.getTime()
  }
  if (objA instanceof RegExp && objB instanceof RegExp) {
    return objA.toString() === objB.toString()
  }

  /**
   * @internal
   * Guard clause ensures both values are objects.
   * After this point, we know both are non-null objects.
   */
  if (typeof objA !== 'object' || objA === null || typeof objB !== 'object' || objB === null) {
    return false
  }

  /**
   * @internal
   * Circular reference detection using WeakMap.
   * If we've already compared objA to objB, assume equal to break cycle.
   * WeakMap ensures no memory leaks as objects can be GC'd.
   */
  if (map.get(objA) === objB) return true
  map.set(objA, objB)

  /**
   * @internal
   * Array comparison with length check for early exit.
   * Backwards iteration for potential performance benefit.
   */
  if (Array.isArray(objA) && Array.isArray(objB)) {
    if (objA.length !== objB.length) return false
    for (let i = objA.length; i-- !== 0; ) {
      if (!deepEqual(objA[i], objB[i], map)) return false
    }
    return true
  }

  /**
   * @internal
   * Map comparison requires two passes:
   * 1. Check all keys exist in both maps
   * 2. Deep compare all values
   * Size check provides early exit optimization.
   */
  if (objA instanceof Map && objB instanceof Map) {
    if (objA.size !== objB.size) return false
    for (const i of objA.entries()) {
      if (!objB.has(i[0])) return false
    }
    for (const i of objA.entries()) {
      if (!deepEqual(i[1], objB.get(i[0]), map)) return false
    }
    return true
  }

  /**
   * @internal
   * Set comparison by deep value membership, not insertion order.
   * Uses O(n²) matching with a consumed-index set to avoid reusing matches.
   */
  if (objA instanceof Set && objB instanceof Set) {
    if (objA.size !== objB.size) return false
    const arrA = [...objA.values()]
    const arrB = [...objB.values()]
    const consumed = new Set<number>()
    for (let i = arrA.length; i-- !== 0; ) {
      let matched = false
      for (let j = 0; j < arrB.length; j++) {
        if (consumed.has(j)) {
          continue
        }
        if (!deepEqual(arrA[i], arrB[j], map)) {
          continue
        }
        consumed.add(j)
        matched = true
        break
      }
      if (!matched) return false
    }
    return true
  }

  /**
   * @internal
   * ArrayBuffer and TypedArray comparison at byte level.
   * Converts to Int8Array for uniform byte-by-byte comparison.
   * Extra block scope is vestigial but preserved.
   */
  if (
    (objA instanceof ArrayBuffer && objB instanceof ArrayBuffer) ||
    (ArrayBuffer.isView(objA) && ArrayBuffer.isView(objB))
  ) {
    {
      if (objA.byteLength !== objB.byteLength) return false
      const dv1 = new Int8Array(objA as ArrayBuffer)
      const dv2 = new Int8Array(objB as ArrayBuffer)
      for (let i = 0; i !== objA.byteLength; i++) {
        if (dv1[i] !== dv2[i]) return false
      }
      return true
    }
  }

  /**
   * @internal
   * Generic object comparison using Reflect API.
   * - Reflect.ownKeys includes string keys, numeric keys, and symbols
   * - More thorough than Object.keys which misses symbols
   * - Length check provides early exit
   * - Reflect.has checks for key existence before deep comparison
   */
  const keysA = Reflect.ownKeys(objA)
  const keysB = Reflect.ownKeys(objB)

  if (keysA.length !== keysB.length) {
    return false
  }

  for (let i = 0; i < keysA.length; i++) {
    if (
      !Reflect.has(objB, keysA[i]!) ||
      !deepEqual(objA[keysA[i] as keyof typeof objA], objB[keysA[i] as keyof typeof objB], map)
    ) {
      return false
    }
  }

  return true
}

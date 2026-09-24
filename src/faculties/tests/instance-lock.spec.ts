import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInstanceLock, type InstanceLock, instancePidfilePath } from '../instance-lock.ts'

const tempHome = (): string => mkdtempSync(join(tmpdir(), 'behavioral-instance-lock-'))

/** Assert acquisition succeeded, returning the narrowed lock. */
const acquired = (lock: InstanceLock | { acquired: false; pid: number }): InstanceLock => {
  expect(lock.acquired).toBe(true)
  if (!lock.acquired) throw new Error(`expected acquisition, blocked by pid ${lock.pid}`)
  return lock
}

describe('acquireInstanceLock', () => {
  test('acquiring a free home writes the pidfile with the given pid', () => {
    const home = tempHome()
    try {
      const lock = acquired(acquireInstanceLock({ home, pid: 4242 }))
      const path = instancePidfilePath(home)
      expect(existsSync(path)).toBe(true)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ pid: 4242 })
      lock.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a pidfile held by a live pid blocks acquisition and reports the pid', () => {
    const home = tempHome()
    try {
      acquired(acquireInstanceLock({ home, pid: process.pid }))
      const second = acquireInstanceLock({ home, pid: 1 })
      expect(second.acquired).toBe(false)
      if (!second.acquired) expect(second.pid).toBe(process.pid)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a stale pidfile (pid no longer alive) is reaped and acquisition succeeds', () => {
    const home = tempHome()
    const path = instancePidfilePath(home)
    // A pid that cannot exist: high fixed value, no process holds it. EPERM
    // would mean "alive but unkillable", so assert the kill probe fails first.
    const deadPid = 999_999_999
    // Guard the assumption: the pid does not exist (ESRCH), so it is stale.
    try {
      process.kill(deadPid, 0)
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH')
    }
    writeFileSync(path, JSON.stringify({ pid: deadPid }))
    const lock = acquired(acquireInstanceLock({ home, pid: process.pid }))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ pid: process.pid })
    lock.release()
  })

  test('release removes the pidfile', () => {
    const home = tempHome()
    try {
      const lock = acquired(acquireInstanceLock({ home, pid: process.pid }))
      lock.release()
      expect(existsSync(instancePidfilePath(home))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

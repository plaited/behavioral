/**
 * Space matching is SYMMETRIC: a listener matches an event iff both are
 * unstamped (root), or both carry the same space stamp. An unstamped
 * listener is ROOT-ONLY — never omni — so an omni-scoped thread is
 * structurally inexpressible (Root/D: a thread that must govern several
 * spaces is admitted per space explicitly, each mount stamped).
 */
import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../behavioral.constants.ts'
import { behavioral } from '../behavioral.ts'
import type { SelectionTrace, Trace } from '../behavioral.types.ts'

const selectedTypes = (traces: Trace[]): string[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection).map((t) => t.selected.type)

describe('space matching — symmetric, unstamped is root-only', () => {
  test('an unstamped thread matches a root (unstamped) event', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      label: 'root-watcher',
      rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'pong' } }],
    })
    program.trigger({ type: 'ping', detail: {} })
    expect(selectedTypes(traces)).toContain('pong')
  })

  test('an unstamped thread does NOT match a named-space event — root-only, never omni', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      label: 'root-watcher',
      rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'pong' } }],
    })
    program.trigger({ type: 'ping', space: 'named', detail: {} })
    expect(selectedTypes(traces)).not.toContain('pong')
  })

  test('a space-stamped thread matches an event in its space', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      label: 's1-watcher',
      space: 's1',
      rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'pong' } }],
    })
    program.trigger({ type: 'ping', space: 's1', detail: {} })
    expect(selectedTypes(traces)).toContain('pong')
  })

  test('a space-stamped thread does not match root events or other spaces', () => {
    const program = behavioral()
    const traces: Trace[] = []
    program.useTrace((t) => {
      traces.push(t)
    })
    program.addThread({
      label: 's1-watcher',
      space: 's1',
      rules: [{ waitFor: [{ type: 'ping' }] }, { request: { type: 'pong' } }],
    })
    program.trigger({ type: 'ping', detail: {} })
    expect(selectedTypes(traces)).not.toContain('pong')
    program.trigger({ type: 'ping', space: 's2', detail: {} })
    expect(selectedTypes(traces)).not.toContain('pong')
  })
})

import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { FrontierTrace, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { behaviorsThreads } from '../behaviors.threads.ts'

const run = (detail: JsonObject) => {
  const traces: Trace[] = []
  const { addThread, step, useTrace } = behavioral()
  useTrace((trace: Trace) => {
    traces.push(trace)
  })
  for (const thread of behaviorsThreads) addThread(thread)
  addThread({ label: 'renderer', once: true, rules: [{ request: { type: 'ui_render', detail } }] })
  step()
  const selections = traces.filter((trace): trace is SelectionTrace => trace.kind === TRACE_MESSAGE_KINDS.selection)
  const frontiers = traces.filter((trace): trace is FrontierTrace => trace.kind === TRACE_MESSAGE_KINDS.frontier)
  return { selections, frontiers }
}

describe('behaviorsThreads — the root guard pack', () => {
  test('blocks a malformed ui_render: candidate present, none enabled, no selection', () => {
    const { selections, frontiers } = run({ id: 'r1', target: 'main', swap: 'innerHTML' })
    expect(selections.some((s) => s.selected.type === 'ui_render')).toBe(false)
    const deadlock = frontiers.find((frontier) => frontier.status === 'deadlock')
    expect(deadlock?.candidates.map((c) => c.type)).toContain('ui_render')
    expect(deadlock?.enabled).toEqual([])
  })

  test('lets a well-formed ui_render select', () => {
    const { selections, frontiers } = run({ id: 'r1', target: 'main', html: '<p>x</p>', swap: 'innerHTML' })
    expect(selections.some((s) => s.selected.type === 'ui_render')).toBe(true)
    expect(frontiers.some((frontier) => frontier.status === 'ready')).toBe(true)
  })
})

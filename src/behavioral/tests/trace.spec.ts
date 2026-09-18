import { describe, expect, test } from 'bun:test'
import { behavioral } from '../behavioral.ts'
import type { Trace } from '../behavioral.types.ts'
import { onSelection, traceCollector } from './helpers.ts'

const onType = (type: string) => ({ type })

describe('useTrace', () => {
  test('does not alter event selection order', () => {
    const events: string[] = []
    const program = behavioral()
    const { addThread, trigger } = program

    const { disconnect } = traceCollector(program)

    addThread({ label: 'producer', rules: [{ request: { type: 'task' } }], once: true })
    addThread({ label: 'consumer', rules: [{ waitFor: [onType('task')] }, { request: { type: 'ack' } }], once: true })

    onSelection(program, (selected) => {
      if (selected.type === 'task' || selected.type === 'ack') events.push(selected.type)
    })

    trigger({ type: 'kickoff' })

    expect(events).toEqual(['task', 'ack'])
    disconnect()
  })

  test('second listener still receives after first disconnects', () => {
    const tracesA: Trace[] = []
    const tracesB: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()

    const disconnectA = useTrace((msg: Trace) => {
      tracesA.push(msg)
    })
    useTrace((msg: Trace) => {
      tracesB.push(msg)
    })

    addThread({ label: 'req', rules: [{ request: { type: 'ping' } }], once: true })

    trigger({ type: 'start' })
    expect(tracesA.length).toBeGreaterThan(0)
    expect(tracesB.length).toBeGreaterThan(0)

    const countA = tracesA.length
    const countB = tracesB.length

    disconnectA()

    addThread({ label: 'req2', rules: [{ request: { type: 'pong' } }], once: true })
    trigger({ type: 'go' })

    expect(tracesA.length).toBe(countA)
    expect(tracesB.length).toBeGreaterThan(countB)
  })

  test('re-subscribing after full disconnect still works', () => {
    const tracesA: Trace[] = []
    const tracesB: Trace[] = []
    const { addThread, trigger, useTrace } = behavioral()

    const disconnectA = useTrace((msg: Trace) => {
      tracesA.push(msg)
    })
    const disconnectB = useTrace((msg: Trace) => {
      tracesB.push(msg)
    })

    addThread({ label: 'req', rules: [{ request: { type: 'ping' } }], once: true })
    trigger({ type: 'start' })

    expect(tracesA.length).toBeGreaterThan(0)
    expect(tracesB.length).toBeGreaterThan(0)

    disconnectA()
    disconnectB()

    const tracesC: Trace[] = []
    useTrace((msg: Trace) => {
      tracesC.push(msg)
    })

    addThread({ label: 'req2', rules: [{ request: { type: 'pong' } }], once: true })
    trigger({ type: 'go' })

    expect(tracesC.length).toBeGreaterThan(0)
  })
})

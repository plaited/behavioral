import { describe, expect, test } from 'bun:test'
import { behavioral } from '../../../behavioral/behavioral.ts'
import type { SelectionTrace, Thread, Trace } from '../../../behavioral/behavioral.types.ts'
import {
  SUPERVISION_DEFAULT_THRESHOLD,
  SUPERVISION_EVENT_TYPES,
  supervisionThreads,
  validateSupervisionTripped,
} from '../threads.ts'

/**
 * The supervision threads against the real engine — the runtime circuit
 * breaker: a count-bounded supervisor watches an event type, blocks the KIND
 * at the threshold (mid-cascade — the block takes effect at the next
 * super-step, before the recursive cascade overflows the stack), and
 * surfaces the trip as a typed selection.
 */

type Selected = { type: string; detail: Record<string, unknown> | undefined }

/** A live program with the selection log; threads mount through the real addThread. */
const liveProgram = () => {
  const program = behavioral()
  const selected: Selected[] = []
  program.useTrace((trace: Trace) => {
    if ((trace as SelectionTrace).kind === 'selection')
      selected.push({
        type: (trace as SelectionTrace).selected.type,
        detail: (trace as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  })
  return { program, selected }
}

const mountAll = (program: ReturnType<typeof behavioral>, threads: Thread[]): void => {
  for (const thread of threads) program.addThread(thread)
}

const count = (selected: Selected[], type: string): number => selected.filter((s) => s.type === type).length

describe('supervision threads — the counting breaker', () => {
  test('a self-sustaining loop trips at the threshold — the type blocks, the cascade stops, the trip surfaces', () => {
    const { program, selected } = liveProgram()
    mountAll(program, supervisionThreads({ watch: ['leaky'], threshold: 8 }))
    // The self-sustaining loop: one request rule, no `once` — every selection
    // re-requests the same event, the unguarded cascade shape.
    mountAll(program, [{ label: 'loop', rules: [{ request: { type: 'leaky', detail: {} } }] }])
    program.trigger({ type: 'pump', detail: {} })

    // The breaker fired mid-cascade: exactly the threshold selections ran,
    // then the block killed the loop (no overflow, no unbounded run).
    expect(count(selected, 'leaky')).toBe(8)
    const trip = selected.find((s) => s.type === SUPERVISION_EVENT_TYPES.tripped)
    expect(trip).toBeDefined()
    expect(trip?.detail).toEqual({ type: 'leaky', count: 8, threshold: 8 })
    expect(validateSupervisionTripped(trip?.detail)).toBe(true)

    // Surgical halt: the REST of the program keeps running — a fresh
    // non-watched event selects while the watched type stays blocked.
    mountAll(program, [{ label: 'after', once: true, rules: [{ request: { type: 'tick', detail: {} } }] }])
    program.trigger({ type: 'pump2', detail: {} })
    expect(count(selected, 'tick')).toBe(1)
    expect(count(selected, 'leaky')).toBe(8)
  })

  test('a long-but-legitimate loop under the threshold runs clean — the breaker is count-bounded, not loop-hostile', () => {
    const { program, selected } = liveProgram()
    // The default threshold (4096, under the ~8.6k cascade overflow) — the
    // supervisor is mounted but never trips on a bounded 20-iteration loop.
    mountAll(program, supervisionThreads({ watch: ['bounded'] }))
    mountAll(program, [
      {
        label: 'legit',
        once: true,
        rules: Array.from({ length: 20 }, () => ({ request: { type: 'bounded', detail: {} } })),
      },
    ])
    program.trigger({ type: 'pump', detail: {} })
    expect(count(selected, 'bounded')).toBe(20)
    expect(selected.some((s) => s.type === SUPERVISION_EVENT_TYPES.tripped)).toBe(false)

    // The watched type was never blocked — later legitimate work still selects.
    mountAll(program, [{ label: 'more', once: true, rules: [{ request: { type: 'bounded', detail: {} } }] }])
    program.trigger({ type: 'pump2', detail: {} })
    expect(count(selected, 'bounded')).toBe(21)
  })

  test('the default threshold sits under the ~8.6k cascade overflow', () => {
    expect(SUPERVISION_DEFAULT_THRESHOLD).toBe(4096)
  })
})

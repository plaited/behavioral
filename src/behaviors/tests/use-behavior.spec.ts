import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { BEHAVIOR_MESSAGE_KINDS } from '../behaviors.constants.ts'
import {
  validateShellCancelEvent,
  validateShellRequestEvent,
  validateShellRequestResultEvent,
} from '../behaviors.types.ts'
import { useBehavior } from '../use-behavior.ts'

/**
 * useBehavior — the spawn-based family primitive — against a real process on
 * the real wire (the engine runs in-process via behavioral(); the spec plays
 * the composition's pump role: selected request events forward to the
 * family's send, exactly as bProgram does). Process-native behaviors:
 *
 * - a request line goes out; the result line re-enters as an event
 * - a crashed process (exit mid-request) synthesizes ONE worker_error
 *   (exit-code crash synthesis)
 * - the family RESPAWNS on demand: the next request completes on a fresh
 *   process
 *
 * The fixture: `probe.proc.ts` — long-running line protocol; the `die` op
 * exits 3 mid-stream; everything else answers the ok envelope.
 */

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

/**
 * The in-process re-entry law (the engine transport's trailing step, now the
 * composition's): addThread alone is inert — every satellite-result re-entry
 * must pump one super-step for it to select.
 */
const addThreadsWithStep =
  (program: ReturnType<typeof behavioral>) =>
  (threads: Thread[]): void => {
    for (const thread of threads) program.addThread(thread)
    program.step()
  }

const spawnProbe = (env?: Record<string, string>) => {
  const program = behavioral()
  const traces: Trace[] = []
  const family = useBehavior({
    command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
    name: 'probe',
    threads: [],
    ...(env === undefined ? {} : { env }),
    validateRequestEvent: validateShellRequestEvent,
    validateEventCancel: validateShellCancelEvent,
    validateResultEvent: validateShellRequestResultEvent,
  })(addThreadsWithStep(program))
  // The composition's pump role: forward selected family requests outbound
  // (the wire-projected event — the selected candidate carries non-wire
  // fields like priority that the boundary schemas reject).
  program.useTrace((trace: Trace) => {
    traces.push(trace)
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const selected = (trace as SelectionTrace).selected
    const event = { type: selected.type, detail: selected.detail, space: selected.space } as BPEvent
    if (event.type === BEHAVIOR_MESSAGE_KINDS.shell_request && validateShellRequestEvent(event)) {
      family.send(event)
    }
  })
  return { program, traces, family }
}

const awaitSelection = async (
  traces: Trace[],
  match: (t: SelectionTrace) => boolean,
  label: string,
): Promise<SelectionTrace> => {
  const deadline = Date.now() + 8_000
  for (;;) {
    const found = selectionsOf(traces).find(match)
    if (found !== undefined) return found
    if (Date.now() > deadline)
      throw new Error(`${label}; saw: ${JSON.stringify(selectionsOf(traces).map((t) => t.selected.type))}`)
    await Bun.sleep(10)
  }
}

const request = (id: string, op: string): BPEvent => ({
  type: BEHAVIOR_MESSAGE_KINDS.shell_request,
  detail: { id, label: 'probe', input: { op } },
})

describe('useBehavior — the spawn-based family primitive', () => {
  test('a request round-trips through the process and its result re-enters', async () => {
    const { program, traces, family } = spawnProbe()
    try {
      program.addThread({
        label: 'caller',
        once: true,
        rules: [{ request: request('r1', 'echo') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === BEHAVIOR_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'r1',
        'no result',
      )
      expect((result.selected.detail as { ok?: boolean } | undefined)?.ok).toBe(true)
    } finally {
      family.terminate()
    }
  })

  test('env is merged over the inherited environment for the spawned process', async () => {
    const { program, traces, family } = spawnProbe({ PROBE_ENV: 'from-env-option' })
    try {
      program.addThread({ label: 'env-caller', once: true, rules: [{ request: request('e1', 'env') }] })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === BEHAVIOR_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'e1',
        'no env result',
      )
      const detail = result.selected.detail as { result?: { env?: string } } | undefined
      expect(detail?.result?.env).toBe('from-env-option')
    } finally {
      family.terminate()
    }
  })

  test('a crashed process synthesizes ONE worker_error, then the family respawns', async () => {
    const { program, traces, family } = spawnProbe()
    try {
      program.addThread({
        label: 'crash-watch',
        rules: [
          {
            waitFor: [
              {
                type: BEHAVIOR_MESSAGE_KINDS.behavior_error,
                detailSchema: { type: 'object', properties: { behavior: { const: 'probe' } }, required: ['behavior'] },
              },
            ],
          },
        ],
      })
      // 1. The die op exits the process mid-request → crash synthesis.
      program.addThread({
        label: 'killer',
        once: true,
        rules: [{ request: request('d1', 'die') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      await awaitSelection(
        traces,
        (t) =>
          t.selected.type === BEHAVIOR_MESSAGE_KINDS.behavior_error &&
          (t.selected.detail as { behavior?: string } | undefined)?.behavior === 'probe',
        'no worker_error',
      )
      const crashes = selectionsOf(traces).filter(
        (t) => t.selected.type === BEHAVIOR_MESSAGE_KINDS.behavior_error,
      ).length
      expect(crashes).toBe(1)

      // 2. Respawn on demand: the next request completes on a fresh process.
      program.addThread({
        label: 'after-crash',
        once: true,
        rules: [{ request: request('r2', 'echo') }],
      })
      program.trigger({ type: 'probe_pump', detail: {} })
      const result = await awaitSelection(
        traces,
        (t) =>
          t.selected.type === BEHAVIOR_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'r2',
        'no respawn result',
      )
      expect((result.selected.detail as { ok?: boolean } | undefined)?.ok).toBe(true)
      // Still exactly one crash — the respawn's listener is armed for the NEXT death only.
      expect(selectionsOf(traces).filter((t) => t.selected.type === BEHAVIOR_MESSAGE_KINDS.behavior_error).length).toBe(
        1,
      )
    } finally {
      family.terminate()
    }
  })
})

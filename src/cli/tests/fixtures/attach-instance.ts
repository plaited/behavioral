import { TRACE_MESSAGE_KINDS } from '../../../behavioral/behavioral.constants.ts'
import type { SelectionTrace, Trace } from '../../../behavioral/behavioral.types.ts'
import { attachOrStart } from '../../attach-or-start.ts'
import type { HostRuntime } from '../../serve.ts'

/**
 * The two-process spec's child entry — the real attach-or-start lifecycle with
 * the composition graph swapped for an echo runtime: each trigger is answered
 * with a selection trace, so a trigger landing in this process is visible on
 * stdout through the socket TUI.
 *
 * @remarks
 * The runtime is a seam here (mocking the composition graph); the lifecycle
 * under test — lock, socket host, socket TUI client, signals, cleanup — is
 * fully real, including the cross-process wire.
 */
const echoRuntime = (): HostRuntime => {
  // The engine self-mints the instance id (the host is the identity authority).
  const instanceId = Bun.randomUUIDv7()
  const listeners = new Set<(trace: Trace) => void>()
  const emit = (trace: Trace): void => {
    for (const listener of listeners) listener(trace)
  }
  const base = { instanceId, sessionId: instanceId }
  return {
    trigger: (event) => {
      const trace: SelectionTrace = {
        kind: TRACE_MESSAGE_KINDS.selection,
        timestamp: Date.now(),
        step: 1,
        ...base,
        selected: { priority: 0, type: event.type, detail: event.detail },
      }
      emit(trace)
    },
    useTrace: (l) => {
      // The real engine's useTrace is a multi-subscriber subject.
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    start: () => {
      emit({ kind: TRACE_MESSAGE_KINDS.idle, timestamp: Date.now(), step: 1, ...base })
    },
    terminate: () => {},
  }
}

const mode = process.argv[2] === 'attach' ? 'attach' : 'start'
await attachOrStart(mode === 'start' ? { createRuntime: () => echoRuntime() } : {})

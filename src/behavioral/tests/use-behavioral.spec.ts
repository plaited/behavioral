import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS, WORKER_MESSAGE_KINDS } from '../behavioral.constants.ts'
import type { SelectionTrace, Thread, Trace, Trigger } from '../behavioral.types.ts'
import { useBehavioral } from '../use-behavioral.ts'

const spawnSatellite = () => new Worker(new URL('./fixtures/satellite.worker.ts', import.meta.url))
const spawnCrashing = () => new Worker(new URL('./fixtures/crash.worker.ts', import.meta.url))

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const waitForTraces = async (traces: Trace[], until: (selections: SelectionTrace[]) => boolean) => {
  const deadline = Date.now() + 3000
  while (!until(selectionsOf(traces))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for traces; saw: ${JSON.stringify(traces.map((t) => t.kind))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const idSchema = (id: string) => ({
  type: 'object',
  properties: { id: { const: id } },
  required: ['id'],
})

describe('useBehavioral router', () => {
  test('routes a selected tool_call to the tools worker and re-enters its result', async () => {
    const traces: Trace[] = []
    const toolsClientWorker = spawnSatellite()
    const responsesClientWorker = spawnSatellite()
    const engineWorker = useBehavioral({
      threads: [
        {
          once: true,
          label: 'caller',
          rules: [
            {
              request: {
                type: WORKER_MESSAGE_KINDS.tool_call,
                detail: { id: 't1', tool: 'execute_shell', input: { script: 'echo hi' } },
              },
            },
            { waitFor: [{ type: WORKER_MESSAGE_KINDS.tool_call_result, detailSchema: idSchema('t1') }] },
          ],
        },
      ],
      traceListener: (trace) => {
        traces.push(trace)
      },
      toolsClientWorker,
      responsesClientWorker,
      useTrigger: () => {},
    })
    await waitForTraces(traces, (s) => s.some((t) => t.selected.type === WORKER_MESSAGE_KINDS.tool_call_result))
    const types = selectionsOf(traces).map((t) => t.selected.type)
    expect(types).toContain(WORKER_MESSAGE_KINDS.tool_call)
    expect(types).toContain(WORKER_MESSAGE_KINDS.tool_call_result)
    expect(types.indexOf(WORKER_MESSAGE_KINDS.tool_call)).toBeLessThan(
      types.indexOf(WORKER_MESSAGE_KINDS.tool_call_result),
    )
    engineWorker.terminate()
    toolsClientWorker.terminate()
    responsesClientWorker.terminate()
  })

  test('routes a selected response_request to the responses worker and re-enters its result', async () => {
    const traces: Trace[] = []
    const toolsClientWorker = spawnSatellite()
    const responsesClientWorker = spawnSatellite()
    const engineWorker = useBehavioral({
      threads: [
        {
          once: true,
          label: 'caller',
          rules: [
            {
              request: {
                type: WORKER_MESSAGE_KINDS.response_request,
                detail: { id: 'call_1', input: { provider: 'stub', modelId: 'stub', input: [] } },
              },
            },
            { waitFor: [{ type: WORKER_MESSAGE_KINDS.response_request_result, detailSchema: idSchema('call_1') }] },
          ],
        },
      ],
      traceListener: (trace) => {
        traces.push(trace)
      },
      toolsClientWorker,
      responsesClientWorker,
      useTrigger: () => {},
    })
    await waitForTraces(traces, (s) => s.some((t) => t.selected.type === WORKER_MESSAGE_KINDS.response_request_result))
    const types = selectionsOf(traces).map((t) => t.selected.type)
    expect(types).toContain(WORKER_MESSAGE_KINDS.response_request)
    expect(types).toContain(WORKER_MESSAGE_KINDS.response_request_result)
    engineWorker.terminate()
    toolsClientWorker.terminate()
    responsesClientWorker.terminate()
  })

  test('wires useTrigger so hosts can inject ingress events', async () => {
    const traces: Trace[] = []
    const toolsClientWorker = spawnSatellite()
    const responsesClientWorker = spawnSatellite()
    let trigger: Trigger | undefined
    const engineWorker = useBehavioral({
      threads: [{ once: true, label: 'booted', rules: [{ waitFor: [{ type: 'boot' }] }] }],
      traceListener: (trace) => {
        traces.push(trace)
      },
      toolsClientWorker,
      responsesClientWorker,
      useTrigger: (t) => {
        trigger = t
      },
    })
    expect(trigger).toBeDefined()
    trigger!({ type: 'boot', detail: {} })
    await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'boot'))
    expect(selectionsOf(traces).some((t) => t.selected.type === 'boot')).toBe(true)
    engineWorker.terminate()
    toolsClientWorker.terminate()
    responsesClientWorker.terminate()
  })

  test('preserves the requesting event space on the result re-entry', async () => {
    const traces: Trace[] = []
    const toolsClientWorker = spawnSatellite()
    const responsesClientWorker = spawnSatellite()
    const engineWorker = useBehavioral({
      threads: [
        {
          space: 's1',
          label: 'caller',
          rules: [
            {
              request: {
                type: WORKER_MESSAGE_KINDS.tool_call,
                detail: { id: 't9', tool: 'execute_shell', input: { script: 'pwd' } },
              },
            },
            { waitFor: [{ type: WORKER_MESSAGE_KINDS.tool_call_result, detailSchema: idSchema('t9') }] },
          ],
        } satisfies Thread,
      ],
      traceListener: (trace) => {
        traces.push(trace)
      },
      toolsClientWorker,
      responsesClientWorker,
      useTrigger: () => {},
    })
    await waitForTraces(traces, (s) =>
      s.some((t) => t.selected.type === WORKER_MESSAGE_KINDS.tool_call_result && t.selected.space === 's1'),
    )
    const resultSelection = selectionsOf(traces).find((t) => t.selected.type === WORKER_MESSAGE_KINDS.tool_call_result)
    expect(resultSelection?.selected.space).toBe('s1')
    engineWorker.terminate()
    toolsClientWorker.terminate()
    responsesClientWorker.terminate()
  })

  test('routes cancel events to the owning worker port', async () => {
    const traces: Trace[] = []
    const toolsClientWorker = spawnSatellite()
    const responsesClientWorker = spawnSatellite()
    const engineWorker = useBehavioral({
      threads: [
        {
          once: true,
          label: 'caller',
          rules: [
            {
              request: {
                type: WORKER_MESSAGE_KINDS.tool_call,
                detail: { id: 't1', tool: 'execute_shell', input: { script: 'sleep 1' } },
              },
            },
          ],
        },
        {
          once: true,
          label: 'canceller',
          rules: [{ request: { type: WORKER_MESSAGE_KINDS.tool_cancel, detail: { id: 't1' } } }],
        },
      ],
      traceListener: (trace) => {
        traces.push(trace)
      },
      toolsClientWorker,
      responsesClientWorker,
      useTrigger: () => {},
    })
    // The stub reports CANCEL receipt through the result channel with a
    // `cancel-` prefixed id, which re-enters as a tool_call_result.
    await waitForTraces(traces, (s) =>
      s.some(
        (t) =>
          t.selected.type === WORKER_MESSAGE_KINDS.tool_call_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'cancel-t1',
      ),
    )
    expect(selectionsOf(traces).some((t) => t.selected.type === WORKER_MESSAGE_KINDS.tool_cancel)).toBe(true)
    engineWorker.terminate()
    toolsClientWorker.terminate()
    responsesClientWorker.terminate()
  })

  test('re-enters a worker_error event when a satellite worker crashes', async () => {
    const traces: Trace[] = []
    const toolsClientWorker = spawnCrashing()
    const responsesClientWorker = spawnSatellite()
    const engineWorker = useBehavioral({
      threads: [
        {
          once: true,
          label: 'caller',
          rules: [
            {
              request: {
                type: WORKER_MESSAGE_KINDS.tool_call,
                detail: { id: 't1', tool: 'execute_shell', input: { script: 'boom' } },
              },
            },
          ],
        },
        {
          once: true,
          label: 'watcher',
          rules: [
            {
              waitFor: [
                {
                  type: WORKER_MESSAGE_KINDS.worker_error,
                  detailSchema: {
                    type: 'object',
                    properties: { worker: { const: 'tools-client' } },
                    required: ['worker'],
                  },
                },
              ],
            },
          ],
        },
      ],
      traceListener: (trace) => {
        traces.push(trace)
      },
      toolsClientWorker,
      responsesClientWorker,
      useTrigger: () => {},
    })
    await waitForTraces(traces, (s) => s.some((t) => t.selected.type === WORKER_MESSAGE_KINDS.worker_error))
    const crash = selectionsOf(traces).find((t) => t.selected.type === WORKER_MESSAGE_KINDS.worker_error)
    expect((crash?.selected.detail as { worker?: string } | undefined)?.worker).toBe('tools-client')
    engineWorker.terminate()
    toolsClientWorker.terminate()
    responsesClientWorker.terminate()
  })
})

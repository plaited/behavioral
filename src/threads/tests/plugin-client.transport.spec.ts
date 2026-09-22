/**
 * The plugin threads through the ENGINE WORKER TRANSPORT
 * (`behavioral.worker.ts`) — the transport semantics the pure-engine spec
 * never exercises: `add_threads` provisions and runs its trailing step (the
 * scan boot is a REQUESTER, so it must self-start with no trigger), and a
 * triggered result cascades the manifests put (the router's re-entry role
 * played by this mock worker client). Satellite routing stays covered by the
 * useWorkers spec.
 */
import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../../workers/workers.constants.ts'
import { PLUGIN_SCAN_CALL_ID, pluginThreads } from '../plugin-client.ts'

type Selected = { type: string; detail: Record<string, unknown> | undefined }

/** Spawn the engine worker and expose a mock worker client over its port. */
const spawnEngineTransport = () => {
  const worker = new Worker(new URL('../../workers/behavioral.worker.ts', import.meta.url))
  const selected: Selected[] = []
  worker.onmessage = ({ data }: MessageEvent<Trace>): void => {
    if (data?.kind === TRACE_MESSAGE_KINDS.selection)
      selected.push({
        type: (data as SelectionTrace).selected.type,
        detail: (data as SelectionTrace).selected.detail as Record<string, unknown> | undefined,
      })
  }
  const addThreads = (threads: Thread[]): void => {
    worker.postMessage({ kind: WORKER_MESSAGE_KINDS.add_threads, threads })
  }
  const trigger = (event: BPEvent): void => {
    worker.postMessage({ kind: WORKER_MESSAGE_KINDS.trigger, event })
  }
  const waitFor = async (until: (selections: Selected[]) => boolean): Promise<Selected[]> => {
    const deadline = Date.now() + 5_000
    while (!until(selected)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for selections; saw: ${JSON.stringify(selected)}`)
      await Bun.sleep(10)
    }
    return selected
  }
  return { addThreads, trigger, waitFor, terminate: () => worker.terminate() }
}

describe('plugin threads — through the engine worker transport', () => {
  test('add_threads self-starts the scan boot — the trailing step fires the requester with no trigger', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(pluginThreads)
      const selections = await engine.waitFor((s) =>
        s.some((x) => x.type === WORKER_MESSAGE_KINDS.tool_call && x.detail?.id === PLUGIN_SCAN_CALL_ID),
      )
      const call = selections.find(
        (s) => s.type === WORKER_MESSAGE_KINDS.tool_call && s.detail?.id === PLUGIN_SCAN_CALL_ID,
      )
      expect(call?.detail?.tool).toBe('plugin-scan')
      const input = call?.detail?.input as Record<string, unknown>
      expect(input.script).toBe('bun run -')
      expect(input.format).toBe('json')
    } finally {
      engine.terminate()
    }
  })

  test('a scan result cascades the manifests put through the transport', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(pluginThreads)
      engine.trigger({
        type: WORKER_MESSAGE_KINDS.tool_call_result,
        detail: {
          id: PLUGIN_SCAN_CALL_ID,
          result: {
            status: 'completed',
            jsonData: {
              plugins: [{ name: 'a', mcps: {}, skills: [], threads: [], warnings: [] }],
              warnings: [],
            },
          },
        },
      })
      const selections = await engine.waitFor((s) =>
        s.some((x) => x.type === WORKER_MESSAGE_KINDS.store_request && x.detail?.op === 'put'),
      )
      const put = selections.find((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
      const input = put?.detail?.input as Record<string, unknown>
      expect(input.collection).toBe('plugins')
      expect(input.key).toBe('manifests')
      expect(input.value).toEqual({
        plugins: [{ name: 'a', mcps: {}, skills: [], threads: [], warnings: [] }],
        warnings: [],
      })
    } finally {
      engine.terminate()
    }
  })
})

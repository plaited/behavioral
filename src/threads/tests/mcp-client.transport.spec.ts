/**
 * The mcp spine through the ENGINE WORKER TRANSPORT (`behavioral.worker.ts`)
 * — not the pure in-process engine, and not the full useWorkers composition.
 *
 * The transport carries semantics the engine-level spec never exercises:
 * `add_threads` provisions and runs its own trailing step (requesters
 * self-start; waitFor threads stay quiet), `trigger` runs its own cascade,
 * and every trace crosses a real postMessage boundary. This harness is a
 * mock worker client: it collects the posted traces and feeds ingress
 * events back — the router's re-entry role played by the test. The
 * satellite routing layer stays covered by the useWorkers spec.
 */
import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../../workers/workers.constants.ts'
import { MCP_CALLS_COLLECTION, MCP_EVENT_TYPES, mcpThreads } from '../mcp-client.ts'

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
  const selections = (): Selected[] => selected
  const waitFor = async (until: (selections: Selected[]) => boolean): Promise<Selected[]> => {
    const deadline = Date.now() + 5_000
    while (!until(selected)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for selections; saw: ${JSON.stringify(selected)}`)
      await Bun.sleep(10)
    }
    return selected
  }
  return { addThreads, trigger, selections, waitFor, terminate: () => worker.terminate() }
}

const authRequiredResult = (id: string): BPEvent => ({
  type: 'mcp_request_result',
  detail: {
    id,
    result: {
      id,
      status: 'authorization_required',
      durationMs: 12,
      message: 'unauthorized',
      request: { op: 'list-tools', input: { url: 'https://mcp.example.com/mcp' } },
    },
  },
})

describe('mcp threads — through the engine worker transport', () => {
  test('add_threads boots quietly — the spine only waits, so nothing fires on the trailing step', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(mcpThreads)
      // The trailing step provisions and pumps once; no trigger has arrived,
      // so the monitors emit no selections at all. Settle well past any
      // super-step the transport could have run on its own.
      await Bun.sleep(250)
      expect(engine.selections()).toEqual([])
    } finally {
      engine.terminate()
    }
  })

  test('an auth-required result cascades through the transport: capture and surfacing', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(mcpThreads)
      engine.trigger(authRequiredResult('c1'))
      const selections = await engine.waitFor((s) => s.some((x) => x.type === MCP_EVENT_TYPES.authorizationRequired))
      const put = selections.find((s) => s.type === 'store_request' && s.detail?.op === 'put')
      expect(put?.detail?.id).toBe('c1')
      expect(put?.detail?.input).toMatchObject({
        collection: MCP_CALLS_COLLECTION,
        key: 'c1',
        value: { op: 'list-tools', input: { url: 'https://mcp.example.com/mcp' } },
      })
      const surfaced = selections.find((s) => s.type === MCP_EVENT_TYPES.authorizationRequired)
      expect(surfaced?.detail?.id).toBe('c1')
    } finally {
      engine.terminate()
    }
  })

  test('grant ingress cascades the full replay: get → retry and delete', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(mcpThreads)
      engine.trigger(authRequiredResult('c2'))
      engine.trigger({ type: MCP_EVENT_TYPES.authorizationGranted, detail: { id: 'c2' } })
      engine.trigger({
        type: 'store_request_result',
        detail: {
          id: 'c2',
          result: { value: { op: 'list-tools', input: { url: 'https://mcp.example.com/mcp' } } },
        },
      })
      const selections = await engine.waitFor(
        (s) =>
          s.some((x) => x.type === 'mcp_request' && x.detail?.id === 'c2-retry') &&
          s.some((x) => x.type === 'store_request' && x.detail?.op === 'delete' && x.detail?.id === 'c2'),
      )
      const retry = selections.find((s) => s.type === 'mcp_request' && s.detail?.id === 'c2-retry')
      expect(retry?.detail?.op).toBe('list-tools')
      expect((retry?.detail?.input as Record<string, unknown>)?.url).toBe('https://mcp.example.com/mcp')
      const get = selections.find((s) => s.type === 'store_request' && s.detail?.op === 'get')
      expect(get?.detail?.id).toBe('c2')
    } finally {
      engine.terminate()
    }
  })
})

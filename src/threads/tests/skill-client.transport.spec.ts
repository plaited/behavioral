/**
 * The skill threads through the ENGINE WORKER TRANSPORT
 * (`behavioral.worker.ts`) — not the pure in-process engine, and not the
 * full useBehavioral composition.
 *
 * The load-bearing assertion here is the inverse of the mcp spine's
 * quiet-boot test: the scan boot thread is a REQUESTER, and the transport's
 * `add_threads` provisions it AND runs the trailing step — so the scan
 * `shell_request` must self-start with NO trigger at all. The catalog transform
 * cascade rides a triggered result (the router's re-entry role played by
 * the mock client). Satellite routing stays covered by the useBehavioral spec.
 */
import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../../workers/workers.constants.ts'
import { SKILL_SCAN_CALL_ID, skillThreads } from '../skill-client.ts'

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

describe('skill threads — through the engine worker transport', () => {
  test('add_threads self-starts the scan boot — the trailing step fires the requester with no trigger', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(skillThreads)
      const selections = await engine.waitFor((s) =>
        s.some((x) => x.type === WORKER_MESSAGE_KINDS.shell_request && x.detail?.id === SKILL_SCAN_CALL_ID),
      )
      const call = selections.find(
        (s) => s.type === WORKER_MESSAGE_KINDS.shell_request && s.detail?.id === SKILL_SCAN_CALL_ID,
      )
      expect(call?.detail?.label).toBe('skill-scan')
      const input = call?.detail?.input as Record<string, unknown>
      expect(input.op).toBe('run')
      expect(input.format).toBe('json')
    } finally {
      engine.terminate()
    }
  })

  test('a scan result cascades the catalog put through the transport', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(skillThreads)
      engine.trigger({
        type: WORKER_MESSAGE_KINDS.shell_request_result,
        detail: {
          id: SKILL_SCAN_CALL_ID,
          result: {
            status: 'completed',
            jsonData: { skills: [{ name: 'a', description: 'd', location: '/x/SKILL.md' }], warnings: [] },
          },
        },
      })
      const selections = await engine.waitFor((s) =>
        s.some((x) => x.type === WORKER_MESSAGE_KINDS.store_request && x.detail?.op === 'put'),
      )
      const put = selections.find((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
      const input = put?.detail?.input as Record<string, unknown>
      expect(input.collection).toBe('skills')
      expect(input.key).toBe('catalog')
      expect(input.value).toEqual({
        skills: [{ name: 'a', description: 'd', location: '/x/SKILL.md' }],
        warnings: [],
      })
    } finally {
      engine.terminate()
    }
  })
})

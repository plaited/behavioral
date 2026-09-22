/**
 * The skill-links threads through the ENGINE WORKER TRANSPORT
 * (`behavioral.worker.ts`) — the transport semantics the pure-engine spec
 * never exercises: the seeder is a REQUESTER, so `add_threads` provisions
 * it AND the trailing step self-starts the recipe puts with no trigger; a
 * triggered links_request cascades the dispatcher's shell_request (the router's
 * re-entry role played by this mock worker client).
 */
import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../../workers/workers.constants.ts'
import { SKILL_EXTRACT_LINKS_SCRIPT, skillLinksThreads } from '../skill-links.ts'

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

describe('skill-links threads — through the engine worker transport', () => {
  test('add_threads self-starts the seeder — both recipe puts fire with no trigger', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(skillLinksThreads)
      const selections = await engine.waitFor(
        (s) => s.filter((x) => x.type === WORKER_MESSAGE_KINDS.store_request && x.detail?.op === 'put').length >= 2,
      )
      const puts = selections.filter((s) => s.type === WORKER_MESSAGE_KINDS.store_request && s.detail?.op === 'put')
      const keys = puts.map((p) => (p.detail?.input as Record<string, unknown>)?.key).sort()
      expect(keys).toEqual(['extract-links', 'validate-links'])
    } finally {
      engine.terminate()
    }
  })

  test('a triggered links_request cascades the dispatcher shell_request', async () => {
    const engine = spawnEngineTransport()
    try {
      engine.addThreads(skillLinksThreads)
      engine.trigger({
        type: 'links_request',
        detail: { id: 'l1', recipe: 'extract-links', input: { markdown: 'See [a](a.ts)' } },
      })
      const selections = await engine.waitFor((s) =>
        s.some((x) => x.type === WORKER_MESSAGE_KINDS.shell_request && x.detail?.id === 'l1'),
      )
      const call = selections.find((s) => s.type === WORKER_MESSAGE_KINDS.shell_request && s.detail?.id === 'l1')
      expect(call?.detail?.label).toBe('skill-extract-links')
      const input = call?.detail?.input as Record<string, unknown>
      expect(input.script).toBe(SKILL_EXTRACT_LINKS_SCRIPT)
      expect((input.env as Record<string, unknown>)?.LINKS_INPUT).toBe('See [a](a.ts)')
    } finally {
      engine.terminate()
    }
  })
})

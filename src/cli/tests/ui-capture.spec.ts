/**
 * The ui autoresearch loop — the in-process raw capture consumer (the eval
 * ruling's canonical path: in-process = raw, a second `useTrace` subscriber
 * coexisting with the redacted lane) plus the minimal frontier-analysis pass
 * over a captured run (`frontier_request { op: replay }` — the divergence
 * view: where requests blocked, what the frontier looked like when the hold
 * happened). The graders are consumer-authored; this pins the wiring.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import {
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
  StoreRequestEventSchema,
  StoreRequestResultEventSchema,
} from '../../faculties/faculties.types.ts'
import { useSystemTwo } from '../../faculties/system-two/config.ts'
import { startOpenResponsesServer } from '../../faculties/system-two/tests/fixtures/model-server.ts'
import { useFaculty } from '../../faculties/use-faculty.ts'
import { bProgram } from '../b-program.ts'
import { createHost, dispatchToRuntime } from '../serve.ts'
import { createUiCapture, type UiRun, uiReplayRequest } from '../ui-capture.ts'
import { UI_SCALE_CHECK_CALL_ID } from '../ui-threads.ts'

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const waitForTraces = async (traces: Trace[], until: (selections: SelectionTrace[]) => boolean) => {
  const deadline = Date.now() + 8_000
  while (!until(selectionsOf(traces))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for traces; saw: ${JSON.stringify(traces.map((t) => t.kind))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const homeEnv = (home: string) => ({ BEHAVIORAL_HOME: home })

const shellWithHome = (home: string) =>
  useFaculty({
    command: ['bun', 'run', 'shell/faculty.ts'],
    name: 'shell',
    threads: [],
    env: homeEnv(home),
    requestSchema: ShellRequestEventSchema,
    cancelSchema: ShellCancelEventSchema,
    resultSchema: ShellRequestResultEventSchema,
  })

const storeWithHome = (home: string) =>
  useFaculty({
    command: ['bun', 'run', 'store/faculty.ts'],
    name: 'store',
    threads: [],
    env: homeEnv(home),
    requestSchema: StoreRequestEventSchema,
    cancelSchema: StoreRequestEventSchema, // no cancel; the request schema is the gate
    resultSchema: StoreRequestResultEventSchema,
  })

/**
 * One scripted pipeline run against the real composition — real faculty
 * processes, the fixture Open Responses endpoint, the serve dispatcher — with
 * the raw capture consumer mounted beside the redacted lane.
 */
const runPipeline = async () => {
  const home = mkdtempSync(join(tmpdir(), 'behavioral-ui-capture-'))
  writeFileSync(join(home, 'DESIGN.md'), '---\ncolors:\n  primary: "#0A0A0A"\n---\n\n## Overview\n\nMine.\n')
  const server = await startOpenResponsesServer()
  const traces: Trace[] = []
  const runs: UiRun[] = []
  const runtime = bProgram({
    shell: shellWithHome(home),
    store: storeWithHome(home),
    systemTwo: useSystemTwo({ endpoints: { default: { url: server.url } } }),
  })
  runtime.useTrace((trace) => {
    traces.push(trace)
  })
  runtime.useTrace(createUiCapture({ sink: (run) => runs.push(run) }))
  const out: string[] = []
  const host = createHost({
    runtime,
    input: new Response('').body as unknown as ReadableStream<Uint8Array>,
    write: (line) => out.push(line),
    home,
  })
  await host.rpc.done
  const drive = async (opts: { replyScale?: boolean; secondRender?: boolean } = {}): Promise<void> => {
    dispatchToRuntime(runtime, {
      method: 'ui_event',
      params: { event: { type: 'render', detail: {} }, timeStamp: Date.now() },
    })
    await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_scale_check'))
    if (opts.replyScale === false) return
    dispatchToRuntime(runtime, {
      method: 'ui_scale_check_result',
      params: { id: UI_SCALE_CHECK_CALL_ID, target: 'body', effectiveScale: 's3', timeStamp: Date.now() },
    })
    if (opts.secondRender !== true) {
      await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ui_render'))
    }
  }
  return {
    runs,
    traces,
    runtime,
    drive,
    cleanup: async (): Promise<void> => {
      runtime.terminate()
      await server.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('ui capture — the raw run consumer', () => {
  test('a scripted run produces a capture whose Thread set round-trips', async () => {
    const session = await runPipeline()
    try {
      await session.drive()
      expect(session.runs).toHaveLength(1)
      const run = session.runs[0]!
      // The Thread set rides thread_added for free: the standing policy
      // threads, plus the run's position-tagged once-thread re-entries.
      const labels = run.threads.map((t) => t.label)
      expect(labels).toContain('ui/preflight')
      expect(labels).toContain('ui/generation-compose')
      expect(labels).toContain('ui/render-gate')
      const reentryLabels = run.reentries.map((r) => r.thread.label)
      expect(reentryLabels.some((l) => l.includes('ui_scale_check'))).toBe(true)
      expect(reentryLabels.some((l) => l.includes('generate'))).toBe(true)
      // Round-trips: pure data, JSON-serializable, structurally intact.
      expect(JSON.parse(JSON.stringify(run.threads)) as unknown[]).toEqual(run.threads)
      expect(JSON.parse(JSON.stringify(run.reentries)) as unknown[]).toEqual(run.reentries)
      // The run's messages span ingress → preflight → generation → render.
      const kinds = run.messages.map((m) => m.selected.type)
      expect(kinds[0]).toBe('render')
      expect(kinds).toContain('ui_scale_check')
      expect(kinds).toContain('ui_scale_check_result')
      expect(kinds).toContain('generate')
      expect(kinds).toContain('system_two_request')
      expect(kinds.at(-1)).toBe('ui_render')
    } finally {
      await session.cleanup()
    }
  }, 15_000)

  test('a second render ingress supersedes an open run — the held pipeline is captured incomplete', async () => {
    const session = await runPipeline()
    try {
      // The first drive never replies to the scale check: the hold is the
      // run's state, and the next trigger flushes it as an incomplete run.
      await session.drive({ replyScale: false })
      expect(session.runs).toHaveLength(0)
      await session.drive()
      // Two runs now: the superseded hold (incomplete) and the complete one.
      expect(session.runs).toHaveLength(2)
      expect(session.runs[0]!.messages.at(-1)?.selected.type).not.toBe('ui_render')
      expect(session.runs[1]!.messages.at(-1)?.selected.type).toBe('ui_render')
    } finally {
      await session.cleanup()
    }
  }, 15_000)
})

describe('ui capture — the frontier replay pass', () => {
  test('replay over the capture re-derives the blocking state — the full run ok, the hold visible at the prefix', async () => {
    const session = await runPipeline()
    try {
      await session.drive()
      const run = session.runs[0]!

      // The full-run replay through the real frontier lane: ok, the end
      // state re-derived.
      const fullResult = await replay(session.runtime, session.traces, uiReplayRequest(run))
      expect(fullResult.ok).toBe(true)
      expect(fullResult.result?.frontier).toBeDefined()

      // The prefix replay — the messages up to (not including) the browser's
      // scale reply — re-derives the HOLD: the frontier has no generation to
      // select (idle: no candidates, the pipeline parked on the external
      // scale fact) while threads remain pending.
      const holdIndex = run.messages.findIndex((m) => m.selected.type === 'ui_scale_check_result')
      expect(holdIndex).toBeGreaterThan(0)
      const holdResult = await replay(session.runtime, session.traces, uiReplayRequest(run, holdIndex))
      expect(holdResult.ok).toBe(true)
      const frontier = holdResult.result?.frontier as { status?: string } | undefined
      expect(frontier?.status).toBe('idle')
      expect(holdResult.result?.pendingCount ?? 0).toBeGreaterThan(0)
    } finally {
      await session.cleanup()
    }
  }, 15_000)
})

/** Trigger one replay request through the composition; poll for its re-entered result. */
const replay = async (
  runtime: { trigger: (event: BPEvent) => void },
  traces: Trace[],
  request: BPEvent,
): Promise<{ ok?: boolean; result?: { frontier?: JsonObject; pendingCount?: number } }> => {
  runtime.trigger(request)
  const deadline = Date.now() + 8_000
  for (;;) {
    const found = selectionsOf(traces).find(
      (t) =>
        t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result &&
        (t.selected.detail as { id?: string } | undefined)?.id === (request.detail as { id?: string }).id,
    )
    if (found !== undefined)
      return found.selected.detail as { ok?: boolean; result?: { frontier?: JsonObject; pendingCount?: number } }
    if (Date.now() > deadline) throw new Error('replay result never re-entered')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

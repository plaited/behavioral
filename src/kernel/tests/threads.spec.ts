import { describe, expect, test } from 'bun:test'
import { KICK_EVENT_TYPE, TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { frontierReplay, frontierVerify } from '../../tools/frontier.ts'
import { createScriptedModelTools } from '../../workers/use-model.ts'
import type { DispatchableTool } from '../dispatch.ts'
import { createKernel } from '../kernel.ts'
import { TURN_LOOP_THREAD } from '../threads.ts'

const tool = (name: string, fn: (input: unknown) => Promise<unknown>): DispatchableTool =>
  Object.defineProperty(fn, 'name', { value: name, configurable: true }) as DispatchableTool

const echoTool = tool('echo', async (input) => ({ echoed: input }))

const assistantMessage = (text: string) => ({
  id: `msg_${text}`,
  type: 'message' as const,
  status: 'completed' as const,
  role: 'assistant' as const,
  content: [{ type: 'output_text' as const, text }],
})

// A simple candidate thread that requests an event and completes.
const candidateThread: Thread = {
  label: 'candidate',
  once: true,
  rules: [{ request: { type: 'greeting', detail: { hello: 'world' } } }],
}

describe('runThreads — register + run arbitrary threads, capture trace', () => {
  test('registers an arbitrary thread and returns a captured trace + frontier', async () => {
    const kernel = createKernel()
    const { trace, frontier } = await kernel.runThreads({
      space: 's1',
      threads: [candidateThread],
    })
    // The trace is non-empty — the engine ran at least one super-step.
    expect(trace.length).toBeGreaterThan(0)
    // The candidate's 'greeting' event was selected during the run.
    const selectionTypes = trace
      .filter((t) => t.kind === TRACE_MESSAGE_KINDS.selection)
      .map((t) => (t as { selected: { type: string } }).selected.type)
    expect(selectionTypes).toContain('greeting')
    // The candidate thread (once: true, single request) completes after its
    // event is selected, so the final frontier is idle.
    expect(frontier).not.toBeNull()
    expect(frontier!.status).toBe('idle')
    expect(frontier!.enabled).toHaveLength(0)
  })

  test('trace contains selection/frontier/deadlock trace kinds for a known program', async () => {
    const kernel = createKernel()
    const { trace } = await kernel.runThreads({
      space: 's2',
      threads: [
        { label: 'req', rules: [{ request: { type: 'a' } }] },
        { label: 'blk', rules: [{ block: [{ type: 'a' }] }] },
      ],
    })
    const kinds = trace.map((t) => t.kind)
    // Deadlock traces appear when all candidates are blocked.
    expect(kinds).toContain(TRACE_MESSAGE_KINDS.deadlock)
    // Frontier traces appear at each super-step.
    expect(kinds).toContain(TRACE_MESSAGE_KINDS.frontier)
  })

  test('an idle program returns an idle frontier', async () => {
    const kernel = createKernel()
    const { frontier } = await kernel.runThreads({
      space: 's3',
      threads: [{ label: 'idle', once: true, rules: [{ waitFor: [{ type: 'never' }] }] }],
    })
    expect(frontier!.status).toBe('idle')
    expect(frontier!.enabled).toHaveLength(0)
  })
})

describe('runTurn with candidate threads — co-registration + trace capture', () => {
  test('co-registers the turn loop + a candidate thread and returns the trace', async () => {
    const kernel = createKernel({
      modelTools: createScriptedModelTools({
        script: [{ items: [assistantMessage('done')], status: 'completed' }],
      }),
      dispatchTools: { echo: echoTool },
    })
    const result = await kernel.runTurn({
      space: 'turn1',
      prompt: 'hello',
      threads: [candidateThread],
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('completed')
    // The trace is captured and non-empty.
    expect(result.trace.length).toBeGreaterThan(0)
    // The trace contains at least one selection trace (the engine selected events).
    const kinds = result.trace.map((t) => t.kind)
    expect(kinds).toContain(TRACE_MESSAGE_KINDS.selection)
  })

  test('runTurn with no candidate threads still works (backward compat)', async () => {
    const kernel = createKernel()
    const result = await kernel.runTurn({ space: 'compat', prompt: 'hello' })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('completed')
  })

  test('the trace contains selection/frontier events for a known turn', async () => {
    const kernel = createKernel()
    const result = await kernel.runTurn({ space: 'trace1', prompt: 'hello' })
    const kinds = result.trace.map((t) => t.kind)
    // The turn loop selects at least: user.prompt, model.respond, model.result, etc.
    expect(kinds).toContain(TRACE_MESSAGE_KINDS.selection)
    expect(kinds).toContain(TRACE_MESSAGE_KINDS.frontier)
  })
})

describe('gate integration — frontierVerify on a captured trace thread set', () => {
  test('a candidate thread passed to frontierVerify yields the expected verdict', async () => {
    const kernel = createKernel()
    // Run the candidate thread to get its trace.
    const { trace } = await kernel.runThreads({
      space: 'gate1',
      threads: [candidateThread],
    })
    // The candidate thread is verified: it requests one event, then completes.
    // No deadlocks; small state space.
    const verifyResult = await frontierVerify({
      threads: [candidateThread],
      maxDepth: 5,
    })
    expect(verifyResult.status).toBe('verified')
    expect(verifyResult.findings).toHaveLength(0)

    // Replay the captured selection traces against the same thread set.
    // Filter out the harness `threads.registered` event — it is not part of
    // the candidate thread's program, so replay only the candidate's own
    // selections. After replaying, the candidate has completed → idle frontier.
    const selectionTraces = trace.filter(
      (t): t is Extract<Trace, { kind: 'selection' }> =>
        t.kind === TRACE_MESSAGE_KINDS.selection &&
        (t as { selected: { type: string } }).selected.type !== 'threads.registered',
    )
    const replayResult = await frontierReplay({
      threads: [candidateThread],
      messages: selectionTraces,
      space: 'gate1',
    })
    expect(replayResult.isError).toBeFalsy()
    expect(replayResult.frontier).not.toBeNull()
    expect(replayResult.frontier!.status).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// Internal re-entry — once-thread + contentless kick
// ---------------------------------------------------------------------------

const functionCallItem = (name: string, callId: string, args: object) => ({
  id: `fc_${callId}`,
  type: 'function_call' as const,
  status: 'completed' as const,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
})

describe('internal re-entry — once-thread + kick', () => {
  test('bridge results are request-origin and the turn loop keeps running', async () => {
    const kernel = createKernel({
      modelTools: createScriptedModelTools({
        script: [
          { items: [functionCallItem('echo', 'call_1', { q: 'a' })], status: 'completed' },
          { items: [assistantMessage('done')], status: 'completed' },
        ],
      }),
      dispatchTools: { echo: echoTool },
    })
    const result = await kernel.runTurn({ space: 's', prompt: 'go' })
    expect(result.status).toBe('completed')
    expect(result.iterations).toBe(2)
    const internal = result.trace.filter(
      (t): t is SelectionTrace =>
        t.kind === TRACE_MESSAGE_KINDS.selection &&
        (t.selected.type === 'model.result' || t.selected.type === 'tool.result'),
    )
    expect(internal.length).toBeGreaterThanOrEqual(2)
    for (const trace of internal) expect(trace.selected.ingress).toBeUndefined()
  })

  test('an external tool.result does not wake the loop ingressMatch:false listener', () => {
    const program = behavioral()
    const addThread = program.useAddThread('s')
    const trigger = program.trigger
    const selectedTypes: string[] = []
    program.useTrace((msg) => {
      if (msg.kind === TRACE_MESSAGE_KINDS.selection) selectedTypes.push(msg.selected.type)
    })
    addThread(TURN_LOOP_THREAD)

    trigger({ type: 'user.prompt', detail: { prompt: 'go' }, space: 's' })
    // The loop advanced through its request-origin 'model.respond' request and
    // is now parked on waitFor[{ model.result, ingressMatch: false }].
    expect(selectedTypes).toContain('model.respond')

    trigger({ type: 'model.result', space: 's' })
    expect(selectedTypes).toContain('model.result')
    // The external model.result was admitted but did not wake the loop.
    expect(selectedTypes).not.toContain('tool.dispatch')
  })

  test('each re-entry emits a detail-free kick followed by the result event', async () => {
    const kernel = createKernel({
      modelTools: createScriptedModelTools({
        script: [
          { items: [functionCallItem('echo', 'call_1', { q: 'a' })], status: 'completed' },
          { items: [assistantMessage('done')], status: 'completed' },
        ],
      }),
      dispatchTools: { echo: echoTool },
    })
    const result = await kernel.runTurn({ space: 's', prompt: 'go' })
    const selections = result.trace.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)
    const kickIndices = selections.flatMap((trace, index) => (trace.selected.type === KICK_EVENT_TYPE ? [index] : []))
    expect(kickIndices.length).toBeGreaterThan(0)
    for (const index of kickIndices) {
      const kick = selections[index]!
      expect(kick.selected.detail).toBeUndefined()
      expect(kick.selected.ingress).toBe(true)
      const next = selections[index + 1]
      expect(next).toBeDefined()
      expect(next!.selected.type).not.toBe(KICK_EVENT_TYPE)
    }
  })
})

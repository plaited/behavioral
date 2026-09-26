import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject, SelectionTrace, Trace } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties/faculties.constants.ts'
import {
  SecurityCancelEventSchema,
  SecurityRequestEventSchema,
  SecurityRequestResultEventSchema,
  ShellCancelEventSchema,
  ShellRequestEventSchema,
  ShellRequestResultEventSchema,
} from '../../faculties/faculties.types.ts'
import {
  REMOTE_MCP_EVENT_TYPES,
  REMOTE_MCP_PROTOCOL_VERSION,
  REMOTE_MCP_STORE_COLLECTION,
} from '../../faculties/shell/remote-mcp.threads.ts'
import { useSystemOne } from '../../faculties/system-one/config.ts'
import { startDecisionsServer } from '../../faculties/system-one/tests/fixtures/decisions-server.ts'
import { ADMISSION_EVENT_TYPES } from '../../faculties/system-one/threads.ts'
import { useSystemTwo } from '../../faculties/system-two/config.ts'
import { ASSISTANT_TEXT, startOpenResponsesServer } from '../../faculties/system-two/tests/fixtures/model-server.ts'
import { useFaculty } from '../../faculties/use-faculty.ts'
import { bProgram } from '../b-program.ts'

/**
 * bProgram — the runtime composition — through its REAL surface: the
 * hook spawns every faculty itself (engine + frontier router-owned, always
 * on; shell/responses/store default-on, pruned by the `faculties`
 * allow-list). The host attaches ingress and observation through the
 * returned handle — `runtime.trigger(...)` and `runtime.useTrace(...)`.
 * `shell` is the one instance-level override: the pre-curried useFaculty
 * return substituting the default shell faculty.
 *
 * Lifecycle note: the composition does NOT flush its deferred thread mounts at
 * construction. The host subscribes (`runtime.useTrace`), then calls
 * `runtime.start()` — the flush runs after subscribers attach, so boot-cascade
 * selection traces (e.g. the skill-scan `shell_request`) are observable.
 * `runtime.trigger` auto-starts (idempotent), so a host that never calls
 * `start()` still boots on its first event.
 *
 * The default threads are faculty-shipped: the shell threads
 * (shell/threads.ts — skill/plugin scans + links) mounts with shell+store
 * on; the remote-mcp threads mounts with shell+security+store on.
 */

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

/** Find a selected store_request by op and collection. */
const storeRequest = (traces: Trace[], op: string, collection: string): SelectionTrace | undefined =>
  selectionsOf(traces).find((t) => {
    if (t.selected.type !== FACULTY_MESSAGE_KINDS.store_request) return false
    const detail = t.selected.detail as { op?: string; input?: { collection?: string } } | undefined
    return detail?.op === op && detail?.input?.collection === collection
  })

/** Construct the composition, attach observation, then start (the boot flush). */
const startRuntime = (options: Parameters<typeof bProgram>[0] = {}) => {
  const traces: Trace[] = []
  const runtime = bProgram(options)
  runtime.useTrace((trace) => {
    traces.push(trace)
  })
  runtime.start()
  return { runtime, traces }
}

describe('bProgram — the runtime composition', () => {
  test('the shell threads ship with the shell faculty: the skill scan self-starts through the composition', async () => {
    const { runtime, traces } = startRuntime()
    try {
      // The skill scan boot is part of the shell threads — starting the
      // composition is enough to start it (no host trigger). Because the
      // subscriber attaches BEFORE `start()`, the boot selection trace is
      // observable…
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'skill-scan-catalog',
        ),
      )
      // …the recipe runs bun-direct… …and the catalog put re-enters (store
      // default-on), gated by the catalog schema. (The links seeder also puts
      // into skill-recipes — match by collection.)
      await waitForTraces(traces, (s) => storeRequest(s, 'put', 'skills') !== undefined)
      const put = storeRequest(selectionsOf(traces), 'put', 'skills')
      const input = (put?.selected.detail as { input?: { collection?: string; key?: string } } | undefined)?.input
      expect(input?.collection).toBe('skills')
      expect(input?.key).toBe('catalog')
    } finally {
      runtime.terminate()
    }
  })

  test('a full round-trip via the default threads: links_request → run op → result re-entry', async () => {
    const { runtime, traces } = startRuntime()
    try {
      runtime.trigger({
        type: 'links_request',
        detail: { id: 'l1', recipe: 'extract-links', input: { markdown: 'See [a](a.ts)' } },
      })
      // Match l1's result — the scan boots' results also re-enter.
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'l1',
        ),
      )
      const result = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 'l1',
      )
      const detail = result?.selected.detail as
        | { ok?: boolean; result?: { jsonData?: { links?: Array<{ value: string; text: string }> } } }
        | undefined
      expect(detail?.ok).toBe(true)
      expect(detail?.result?.jsonData).toEqual({ links: [{ value: 'a.ts', text: 'a' }] })
    } finally {
      runtime.terminate()
    }
  })

  test('the faculties allow-list prunes faculties: without shell, no route — a triggered shell_request is never answered', async () => {
    const { runtime, traces } = startRuntime({ faculties: ['store'] })
    try {
      // No shell → no scan boot, no shell_request ever. Settle past any
      // boot cascade the threads could have run.
      await Bun.sleep(500)
      expect(selectionsOf(traces).some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
      expect(storeRequest(selectionsOf(traces), 'put', 'skills')).toBeUndefined()
      expect(storeRequest(selectionsOf(traces), 'put', 'skill-recipes')).toBeUndefined()
      // The pruning BOUNDS the arbitrary-execution faculty: a host-injected
      // shell_request (a client can send one) has no route, so it never
      // spawns a process and is never answered.
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'pruned-shell', label: 'probe', input: { op: 'echo' } },
      })
      await Bun.sleep(300)
      expect(
        selectionsOf(traces).some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'pruned-shell',
        ),
      ).toBe(false)
    } finally {
      runtime.terminate()
    }
  })

  test('shell overrides the default faculty — a host-constructed shell takes the route', async () => {
    const hostShell = useFaculty({
      command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
      name: 'shell',
      threads: [],
      requestSchema: ShellRequestEventSchema,
      cancelSchema: ShellCancelEventSchema,
      resultSchema: ShellRequestResultEventSchema,
    })
    const { runtime, traces } = startRuntime({ shell: hostShell })
    try {
      // A raw shell_request (root ingress — no thread involvement): the
      // satellite fixture answers with {ok:true, value:{op}} — a shape the
      // REAL shell never produces. Its arrival proves the override took the
      // shell route. (The faculty's threads ride the host's wiring — [] here by choice.)
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'ov1', label: 'probe', input: { op: 'echo' } },
      })
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { ok?: boolean } | undefined)?.ok === true,
        ),
      )
    } finally {
      runtime.terminate()
    }
  })

  test('a crashed satellite re-enters one worker_error event', async () => {
    const hostShell = useFaculty({
      command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
      name: 'shell',
      threads: [],
      requestSchema: ShellRequestEventSchema,
      cancelSchema: ShellCancelEventSchema,
      resultSchema: ShellRequestResultEventSchema,
    })
    const { runtime, traces } = startRuntime({ shell: hostShell })
    try {
      // The crash fixture throws on its FIRST message — drive one into it.
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'c1', label: 'probe', input: { op: 'die' } },
      })
      await waitForTraces(traces, (s) => s.some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.faculty_error))
      const crash = selectionsOf(traces).find((t) => t.selected.type === FACULTY_MESSAGE_KINDS.faculty_error)
      expect((crash?.selected.detail as { faculty?: string } | undefined)?.faculty).toBe('shell')
    } finally {
      runtime.terminate()
    }
  })

  test('trigger does not flush deferred thread mounts — start() owns the boot', async () => {
    const traces: Trace[] = []
    const runtime = bProgram({})
    runtime.useTrace((trace) => {
      traces.push(trace)
    })
    try {
      // Without start(), the deferred thread mounts are not flushed: a trigger is
      // admitted (the engine is live) but the shell/mcp boot cascades never run.
      runtime.trigger({ type: 'noop', detail: {} })
      await Bun.sleep(200)
      expect(selectionsOf(traces).some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.shell_request)).toBe(false)
    } finally {
      runtime.terminate()
    }
  })

  test('the root guard threads is mounted: a malformed ui_* message is blocked', async () => {
    const { runtime, traces } = startRuntime({ faculties: [] })
    try {
      // Invalid ui_render (no html): the guard blocks it, so it never selects and
      // the frontier deadlocks — the reject is visible in the trace.
      runtime.trigger({ type: 'ui_render', detail: { id: 'r1', target: 'main', swap: 'innerHTML' } })
      await Bun.sleep(100)
      expect(selectionsOf(traces).some((t) => t.selected.type === 'ui_render')).toBe(false)
      expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      runtime.terminate()
    }
  })

  describe('add_thread — the admission path', () => {
    const addThreadRequest = (id: string, thread: JsonObject, extra?: JsonObject): BPEvent => ({
      type: FACULTY_MESSAGE_KINDS.frontier_request,
      detail: { id, op: 'add_thread', input: { thread, maxDepth: 8, ...extra } },
    })

    const resultDetailFor = (traces: Trace[], id: string) => {
      const sel = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result &&
          (t.selected.detail as { id?: string }).id === id,
      )
      return sel?.selected.detail as { id?: string; ok?: boolean; result?: { ok?: boolean } } | undefined
    }

    test('a valid proposal is admitted: the verdict returns and the thread_added provision fires', async () => {
      const { runtime, traces } = startRuntime()
      try {
        runtime.trigger(addThreadRequest('at1', { label: 'greeter', rules: [{ request: { type: 'ping' } }] }))
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'at1' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'at1')
        // The verdict is data: the frontier validated, the composition owns the write.
        expect(detail?.ok).toBe(true)
        expect(detail?.result?.ok).toBe(true)
        const added = traces.find(
          (t) =>
            t.kind === TRACE_MESSAGE_KINDS.thread_added &&
            (t as { thread?: { label?: string } }).thread?.label === 'greeter',
        )
        expect(added).toBeDefined()
      } finally {
        runtime.terminate()
      }
    })

    test('an invalid proposal is rejected data — no admission, no thread_added', async () => {
      const { runtime, traces } = startRuntime()
      try {
        // `rules` missing: the derived Thread-schema gate rejects the whole input.
        runtime.trigger(addThreadRequest('at2', { label: 'broken' }))
        await waitForTraces(traces, (s) =>
          s.some(
            (t) =>
              (t.selected.detail as { id?: string } | undefined)?.id === 'at2' &&
              t.selected.type === FACULTY_MESSAGE_KINDS.frontier_request_result,
          ),
        )
        const detail = resultDetailFor(traces, 'at2')
        expect(detail?.ok).toBe(false)
        expect(
          traces.some(
            (t) =>
              t.kind === TRACE_MESSAGE_KINDS.thread_added &&
              (t as { thread?: { label?: string } }).thread?.label === 'broken',
          ),
        ).toBe(false)
      } finally {
        runtime.terminate()
      }
    })

    test('an admitted thread goes live: its request is a candidate in the next super-step', async () => {
      const { runtime, traces } = startRuntime()
      try {
        runtime.trigger(addThreadRequest('at3', { label: 'greeter', rules: [{ request: { type: 'ping' } }] }))
        // The candidate→live transition: admission re-enters (addThread + step),
        // so the greeter's request selects — the thread participates in the
        // program, not just the trace log. And it keeps participating: a
        // looping (non-once) greeter re-requests ping each super-step.
        await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ping'))
        const pingSelections = selectionsOf(traces).filter((t) => t.selected.type === 'ping')
        expect(pingSelections.length).toBeGreaterThanOrEqual(2)
      } finally {
        runtime.terminate()
      }
    })
    describe('add_thread — the admission judgment (systemOne wired)', () => {
      test('the judged path: the Decision approves, the block lifts, the candidate admits and goes live', async () => {
        const server = await startDecisionsServer()
        const { runtime, traces } = startRuntime({
          systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
        })
        try {
          // The admitted thread is `once` — its ping selects and the thread completes.
          // (A looping thread here would recurse the engine's super-step cascade
          // unboundedly — a known engine frontier this test does not exercise.)
          runtime.trigger(
            addThreadRequest('aj1', { label: 'greeter', once: true, rules: [{ request: { type: 'ping' } }] }),
          )
          // The judgment's outcome: the admission fires with the candidate id…
          await waitForTraces(traces, (s) =>
            s.some(
              (t) =>
                t.selected.type === ADMISSION_EVENT_TYPES.admitted &&
                (t.selected.detail as { id?: string }).id === 'aj1',
            ),
          )
          // …the Decision saw the proposed thread (the faculty's recorded request —
          // the semantic layer judged the actual thread, not a schema echo).
          const judged = server.requests.find(
            (r) => (r.body.state as { thread?: { label?: string } } | undefined)?.thread?.label === 'greeter',
          )
          expect(judged).toBeDefined()
          expect(Object.keys(judged?.body.questions ?? {})).toContain('admission')
          // The admission rides the judged outcome — the verdict precedes it.
          const selections = selectionsOf(traces)
          const judgeResultIndex = selections.findIndex(
            (t) =>
              t.selected.type === FACULTY_MESSAGE_KINDS.system_one_request_result &&
              (t.selected.detail as { id?: string }).id === 'aj1-judge',
          )
          const admittedIndex = selections.findIndex(
            (t) =>
              t.selected.type === ADMISSION_EVENT_TYPES.admitted && (t.selected.detail as { id?: string }).id === 'aj1',
          )
          expect(admittedIndex).toBeGreaterThan(judgeResultIndex)
          // The thread_added provision fires — the composition owns the write.
          expect(
            traces.some(
              (t) =>
                t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                (t as { thread?: { label?: string } }).thread?.label === 'greeter',
            ),
          ).toBe(true)
          // …and the admitted thread goes live — its request selects like any other thread's.
          await waitForTraces(traces, (s) => s.some((t) => t.selected.type === 'ping'))
        } finally {
          runtime.terminate()
          await server.close()
        }
      })

      test('the judged path: a rejection holds the line — the candidate never admits', async () => {
        const server = await startDecisionsServer({ pickChoice: 'reject' })
        const { runtime, traces } = startRuntime({
          systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
        })
        try {
          runtime.trigger(addThreadRequest('aj2', { label: 'suspicious', rules: [{ request: { type: 'evil' } }] }))
          // The rejection is visible, stamped with the candidate id…
          await waitForTraces(traces, (s) =>
            s.some(
              (t) =>
                t.selected.type === ADMISSION_EVENT_TYPES.rejected &&
                (t.selected.detail as { id?: string }).id === 'aj2',
            ),
          )
          // …and the line held: no admission for the rejected candidate, no
          // thread_added provision, nothing live.
          expect(
            selectionsOf(traces).some(
              (t) =>
                t.selected.type === ADMISSION_EVENT_TYPES.admitted &&
                (t.selected.detail as { id?: string }).id === 'aj2',
            ),
          ).toBe(false)
          expect(
            traces.some(
              (t) =>
                t.kind === TRACE_MESSAGE_KINDS.thread_added &&
                (t as { thread?: { label?: string } }).thread?.label === 'suspicious',
            ),
          ).toBe(false)
          expect(selectionsOf(traces).some((t) => t.selected.type === 'evil')).toBe(false)
        } finally {
          runtime.terminate()
          await server.close()
        }
      })
    })
  })

  test('terminate kills overridden faculties too — the composition owns every process it invokes', async () => {
    const factory = useFaculty({
      command: ['bun', 'run', 'tests/fixtures/probe.proc.ts'],
      name: 'shell',
      threads: [],
      requestSchema: ShellRequestEventSchema,
      cancelSchema: ShellCancelEventSchema,
      resultSchema: ShellRequestResultEventSchema,
    })
    // Capture the real handle the composition invokes: the host passes the
    // curried factory, so the composition holds the only terminate handle.
    let invoked: ReturnType<typeof factory> | undefined
    let terminated = false
    const hostShell = ((addThreads: Parameters<typeof factory>[0], space?: string) => {
      const handle = factory(addThreads, space)
      invoked = handle
      return {
        ...handle,
        terminate: () => {
          terminated = true
          handle.terminate()
        },
      }
    }) as typeof factory

    const { runtime, traces } = startRuntime({ shell: hostShell })
    try {
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: { id: 'ov-term', label: 'probe', input: { op: 'echo' } },
      })
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'ov-term',
        ),
      )
      expect(invoked).toBeDefined()
      runtime.terminate()
      expect(terminated).toBe(true)
    } finally {
      runtime.terminate()
      invoked?.terminate()
    }
  })

  test('a systemTwo override takes the route: the endpoint seeds the process and the result re-enters', async () => {
    const server = await startOpenResponsesServer()
    const { runtime, traces } = startRuntime({ systemTwo: useSystemTwo({ endpoints: { mock: { url: server.url } } }) })
    try {
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.system_two_request,
        detail: {
          id: 's2-1',
          input: {
            provider: 'mock',
            modelId: 'mock-model',
            input: [{ type: 'message', role: 'user', content: 'Say hello' }],
          },
        },
      })
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.system_two_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 's2-1',
        ),
      )
      const result = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.system_two_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 's2-1',
      )
      const detail = result?.selected.detail as
        | { ok?: boolean; result?: { items?: Array<{ content?: Array<{ text?: string }> }> } }
        | undefined
      expect(detail?.ok).toBe(true)
      expect(detail?.result?.items?.[0]?.content?.[0]?.text).toBe(ASSISTANT_TEXT)
    } finally {
      runtime.terminate()
      await server.close()
    }
  })

  test('a malformed system_two_request is blocked by the faculty guard — never selected', async () => {
    const server = await startOpenResponsesServer()
    const { runtime, traces } = startRuntime({ systemTwo: useSystemTwo({ endpoints: { mock: { url: server.url } } }) })
    try {
      // No `input` — the request detail fails its schema, so the derived guard
      // blocks it and the reject is visible (deadlock), not silently dropped.
      runtime.trigger({ type: FACULTY_MESSAGE_KINDS.system_two_request, detail: { id: 'bad' } })
      await Bun.sleep(100)
      expect(selectionsOf(traces).some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.system_two_request)).toBe(false)
      expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      runtime.terminate()
      await server.close()
    }
  })

  test('a systemOne override takes the route: the endpoint seeds the process and the result re-enters', async () => {
    const server = await startDecisionsServer()
    const { runtime, traces } = startRuntime({
      systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
    })
    try {
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.system_one_request,
        detail: {
          id: 's1-1',
          input: { state: 'x', questions: { is_urgent: { type: 'noul', instructions: 'Urgent?' } } },
        },
      })
      await waitForTraces(traces, (s) =>
        s.some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.system_one_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 's1-1',
        ),
      )
      const result = selectionsOf(traces).find(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.system_one_request_result &&
          (t.selected.detail as { id?: string } | undefined)?.id === 's1-1',
      )
      const detail = result?.selected.detail as
        | { ok?: boolean; result?: { answers?: { is_urgent?: { noul?: number } } } }
        | undefined
      expect(detail?.ok).toBe(true)
      expect(detail?.result?.answers?.is_urgent?.noul).toBe(0.9)
    } finally {
      runtime.terminate()
      await server.close()
    }
  })

  test('a malformed system_one_request is blocked by the faculty guard — never selected', async () => {
    const server = await startDecisionsServer()
    const { runtime, traces } = startRuntime({
      systemOne: useSystemOne({ endpoint: { url: server.url, model: 'jev-latest' } }),
    })
    try {
      runtime.trigger({ type: FACULTY_MESSAGE_KINDS.system_one_request, detail: { id: 'bad' } })
      await Bun.sleep(100)
      expect(selectionsOf(traces).some((t) => t.selected.type === FACULTY_MESSAGE_KINDS.system_one_request)).toBe(false)
      expect(traces.some((t) => t.kind === TRACE_MESSAGE_KINDS.deadlock)).toBe(true)
    } finally {
      runtime.terminate()
      await server.close()
    }
  })

  test('the remote-mcp threads ships with shell+security+store: discovery registers the tools', async () => {
    // A plain JSON-RPC endpoint speaking server/discover + tools/list — the
    // 2026-07-28 stateless era needs no handshake.
    const rpc = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { id?: unknown; method?: string }
        const method = body.method
        if (method === 'server/discover')
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
          })
        if (method === 'tools/list')
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'echo', description: 'echoes' }] },
          })
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } })
      },
    })
    const { runtime, traces } = startRuntime()
    try {
      runtime.trigger({
        type: REMOTE_MCP_EVENT_TYPES.discover,
        detail: { id: 'r1', input: { url: `http://localhost:${rpc.port}/mcp` } },
      })
      // The threads drive the generic rpc op: server/discover → tools/list →
      // the store registry put (alongside the skills/plugins tenants).
      await waitForTraces(traces, (s) => storeRequest(s, 'put', REMOTE_MCP_STORE_COLLECTION) !== undefined)
      const put = storeRequest(selectionsOf(traces), 'put', REMOTE_MCP_STORE_COLLECTION)
      const input = (put?.selected.detail as { input?: { key?: string; value?: { tools?: Array<{ name?: string }> } } })
        ?.input
      expect(input?.key).toContain('localhost')
      expect(input?.value?.tools?.[0]?.name).toBe('echo')
      // The outcome surfaces to the host.
      await waitForTraces(traces, (s) =>
        selectionsOf(s).some((t) => t.selected.type === REMOTE_MCP_EVENT_TYPES.discovered),
      )
      const surfaced = selectionsOf(traces).find((t) => t.selected.type === REMOTE_MCP_EVENT_TYPES.discovered)
      const surfacedDetail = surfaced?.selected.detail as { id?: string } | undefined
      expect(surfacedDetail?.id).toBe('r1')
      // The threads' issued ops carry the protocol stamp (observed on the result lane).
      expect(
        selectionsOf(traces).some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request &&
            (t.selected.detail as { input?: { headers?: Record<string, string> } }).input?.headers?.[
              'MCP-Protocol-Version'
            ] === REMOTE_MCP_PROTOCOL_VERSION,
        ),
      ).toBe(true)
    } finally {
      runtime.terminate()
      rpc.stop(true)
    }
  })

  test('the credential seam ships with shell+security: an auth rpc op vends, then replays with the bearer', async () => {
    // The JSON-RPC endpoint requires a bearer; the broker vends one.
    const seenAuth: Array<string | undefined> = []
    const rpc = Bun.serve({
      port: 0,
      fetch: async (request) => {
        seenAuth.push(request.headers.get('authorization') ?? undefined)
        if (!request.headers.has('authorization')) return new Response('unauthorized', { status: 401 })
        const body = (await request.json()) as { id?: unknown }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { echoed: true } })
      },
    })
    const broker = Bun.serve({
      port: 0,
      fetch: () => Response.json({ token: 'broker-tok-1' }),
    })
    const brokerUrl = `http://localhost:${broker.port}/`
    // Spawned children see STARTUP env only — the broker binding rides the
    // security override's env-data (the shell/store override pattern).
    const { runtime, traces } = startRuntime({
      security: useFaculty({
        command: ['bun', 'run', 'security/faculty.ts'],
        name: 'security',
        threads: [],
        env: { MCP_BROKER_URL: brokerUrl, MCP_BROKER_BOOT_SECRET: 'boot-secret' },
        requestSchema: SecurityRequestEventSchema,
        cancelSchema: SecurityCancelEventSchema,
        resultSchema: SecurityRequestResultEventSchema,
      }),
    })
    try {
      runtime.trigger({
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: {
          id: 'rpc-auth-1',
          input: { op: 'rpc', url: `http://localhost:${rpc.port}/mcp`, method: 'tools/list', auth: true },
        },
      })
      // The first attempt short-circuits as credential_required; the thread
      // vends through the security faculty and replays with the token.
      await waitForTraces(traces, (s) =>
        selectionsOf(s).some(
          (t) =>
            t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
            (t.selected.detail as { id?: string } | undefined)?.id === 'rpc-auth-1' &&
            (t.selected.detail as { ok?: boolean }).ok === true,
        ),
      )
      const results = selectionsOf(traces).filter(
        (t) =>
          t.selected.type === FACULTY_MESSAGE_KINDS.shell_request_result &&
          (t.selected.detail as { id?: string }).id === 'rpc-auth-1',
      )
      expect(results.length).toBe(2)
      const first = results[0]?.selected.detail as { error?: { code?: string } } | undefined
      expect(first?.error?.code).toBe('credential_required')
      const final = results[1]?.selected.detail as { ok?: boolean; result?: { output?: { echoed?: unknown } } }
      expect(final.ok).toBe(true)
      expect(final.result?.output?.echoed).toBe(true)
      // The security faculty vended from the broker; the remote saw the bearer.
      expect(seenAuth[0]).toBe('Bearer broker-tok-1')
    } finally {
      runtime.terminate()
      rpc.stop(true)
      broker.stop(true)
    }
  })
})

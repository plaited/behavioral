import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { JsonObject, SelectionTrace, Thread } from '../../behavioral/behavioral.types.ts'
import { frontierReplay, frontierVerify } from '../../tools/frontier.ts'
import { createDispatchBridge, type DispatchableTool } from '../dispatch.ts'
import { PROGRESSIVE_DISCLOSURE_THREAD } from '../threads.ts'

/**
 * Tests for the progressive-disclosure thread — the autoresearch loop's
 * subject (Q8). The thread drives search→pick→load over discovery tools via
 * harness events the dispatch bridge maps to tools. The model only picks.
 *
 * Gate contract:
 * - frontierVerify → verified (safe: no deadlock/livelock)
 * - frontierReplay → reaches the target frontier (useful: the happy-path
 *   selection trace proves the thread reaches "loaded" then terminates)
 * - a broken variant (no search step) → gate fails (discriminates)
 * - bridge integration: maps discovery.search → discovery tool
 */

const SPACE = 'gate-pd'

// The trigger events the bridge fires to wake the thread past each waitFor.
// These simulate the bridge's async I/O completing and re-entering the engine.
const BRIDGE_TRIGGERS = [
  { type: 'user.prompt', space: SPACE },
  { type: 'discovery.results', space: SPACE },
  { type: 'model.result', space: SPACE },
  { type: 'tool.loaded', space: SPACE },
  { type: 'turn.end', space: SPACE },
]

// Build a happy-path reference trace: the events the thread requests plus the
// bridge-produced events, in the order the engine selects them. This is the
// selection trace frontierReplay consumes to prove the thread reaches its
// target frontier. Only the external user.prompt carries `ingress: true`;
// bridge results arrive as request-origin candidates (the bridge adds a
// once-thread requesting them and kicks the super-step), so the replay
// reconstructs those once-threads from the pending set. Thread-requested events
// carry no `detail` (the thread's requests are type-only; the bridge fills
// detail at runtime).
const buildReferenceTrace = (): SelectionTrace[] => {
  const sel = (type: string, priority: number, ingress: boolean, detail?: JsonObject): SelectionTrace => ({
    kind: TRACE_MESSAGE_KINDS.selection,
    timestamp: 0,
    instanceId: 'test',
    step: 0,
    selected: {
      type,
      priority,
      space: SPACE,
      ...(ingress ? { ingress: true as const } : {}),
      ...(detail ? { detail } : {}),
    },
  })
  return [
    // ingress — user.prompt wakes the thread (external trigger → ingress, with detail)
    sel('user.prompt', 0, true, { prompt: 'search for weather skill' }),
    // thread requests discovery.search (tier 1 metadata — no detail in request)
    sel('discovery.search', 1, false),
    // bridge re-enters with discovery.results (request-origin once-thread + kick)
    sel('discovery.results', 0, false, { count: 1 }),
    // thread requests model.respond (model picks — no detail in request)
    sel('model.respond', 1, false),
    // bridge re-enters with model.result (request-origin)
    sel('model.result', 0, false, { pick: 'weather-skill' }),
    // thread requests skill.read (tier 2 — no detail in request)
    sel('skill.read', 1, false),
    // bridge re-enters with tool.loaded (request-origin)
    sel('tool.loaded', 0, false, { name: 'weather' }),
    // thread requests turn.end (terminate — no detail)
    sel('turn.end', 1, false),
  ]
}

// A broken variant: removes the search step. The thread goes straight from
// user.prompt to model.respond — picking without searching. The reference
// trace includes discovery.search, which this broken thread never requests,
// so frontierReplay fails: "discovery.search was not enabled."
const BROKEN_THREAD: Thread = {
  label: 'progressive-disclosure-broken',
  once: true,
  rules: [
    { waitFor: [{ type: 'user.prompt' }] },
    // NO discovery.search step — the bug
    { request: { type: 'model.respond' } },
    { waitFor: [{ type: 'model.result' }], interrupt: [{ type: 'turn.end' }] },
    { request: { type: 'skill.read' } },
    { waitFor: [{ type: 'tool.loaded' }], interrupt: [{ type: 'turn.end' }] },
    { request: { type: 'turn.end' } },
  ],
}

describe('progressive-disclosure thread — gate contract', () => {
  test('frontierVerify → verified (no deadlock/livelock)', async () => {
    const result = await frontierVerify({
      threads: [PROGRESSIVE_DISCLOSURE_THREAD],
      triggers: BRIDGE_TRIGGERS,
      maxDepth: 20,
      progress: ['turn.end'],
    })
    expect(result.status).toBe('verified')
    expect(result.findings).toHaveLength(0)
    expect(result.livelocks).toHaveLength(0)
  })

  test('frontierReplay → reaches the target frontier (loaded then idle)', async () => {
    const referenceTrace = buildReferenceTrace()
    const result = await frontierReplay({
      threads: [PROGRESSIVE_DISCLOSURE_THREAD],
      messages: referenceTrace,
      space: SPACE,
    })
    expect(result.isError).toBeFalsy()
    expect(result.frontier).not.toBeNull()
    // After replaying the full happy-path trace (including turn.end), the
    // once:true thread has consumed all rules → idle frontier.
    expect(result.frontier!.status).toBe('idle')
    expect(result.frontier!.enabled).toHaveLength(0)
  })

  test('frontierReplay → the search→picked→loading→loaded states are distinguishable', async () => {
    // Replay only up to and including the skill.read selection — the thread
    // should be waiting for tool.loaded (not yet idle). This proves the
    // frontier progression is inspectable at intermediate states.
    const partialTrace = buildReferenceTrace().slice(0, 6) // through skill.read
    const result = await frontierReplay({
      threads: [PROGRESSIVE_DISCLOSURE_THREAD],
      messages: partialTrace,
      space: SPACE,
    })
    expect(result.isError).toBeFalsy()
    expect(result.frontier).not.toBeNull()
    // The thread is now at waitFor[{tool.loaded}] — waiting, not idle.
    // The thread still has pending bids (it hasn't completed).
    expect(result.pendingCount).toBeGreaterThan(0)
  })

  test('frontierReplay → after search, the thread requests model.respond (picking state)', async () => {
    // Replay through discovery.results — the thread should have advanced past
    // the search step and now be requesting model.respond.
    const partialTrace = buildReferenceTrace().slice(0, 3) // through discovery.results
    const result = await frontierReplay({
      threads: [PROGRESSIVE_DISCLOSURE_THREAD],
      messages: partialTrace,
      space: SPACE,
    })
    expect(result.isError).toBeFalsy()
    expect(result.frontier).not.toBeNull()
    // The thread is requesting model.respond — it should be an enabled candidate.
    const enabledTypes = result.frontier!.enabled.map((c) => c.type)
    expect(enabledTypes).toContain('model.respond')
  })

  test('broken variant (no search step) → frontierReplay fails (gate discriminates)', async () => {
    const referenceTrace = buildReferenceTrace()
    const result = await frontierReplay({
      threads: [BROKEN_THREAD],
      messages: referenceTrace,
      space: SPACE,
    })
    // The reference trace includes discovery.search at step 1, but the broken
    // thread never requests it — replay fails with isError.
    expect(result.isError).toBe(true)
    expect(result.frontier).toBeNull()
  })

  test('broken variant → frontierVerify still clean (valid thread, just wrong behavior)', async () => {
    // The broken thread is structurally valid (no deadlock/livelock) — it just
    // skips search. frontierVerify passes; it is frontierReplay that
    // discriminates by replaying the reference trace. This proves the two
    // gates are complementary: verify=safety, replay=usefulness.
    const result = await frontierVerify({
      threads: [BROKEN_THREAD],
      triggers: [
        { type: 'user.prompt', space: SPACE },
        { type: 'model.result', space: SPACE },
        { type: 'tool.loaded', space: SPACE },
        { type: 'turn.end', space: SPACE },
      ],
      maxDepth: 20,
      progress: ['turn.end'],
    })
    expect(result.status).toBe('verified')
  })
})

describe('progressive-disclosure thread — bridge integration', () => {
  test('frontierReplay after user.prompt → discovery.search is the next enabled candidate', async () => {
    // Prove the thread requests discovery.search after ingress — the event
    // the bridge would dispatch to the discovery tool.
    const ingressTrace = buildReferenceTrace().slice(0, 1) // user.prompt only
    const result = await frontierReplay({
      threads: [PROGRESSIVE_DISCLOSURE_THREAD],
      messages: ingressTrace,
      space: SPACE,
    })
    expect(result.isError).toBeFalsy()
    expect(result.frontier).not.toBeNull()
    const enabledTypes = result.frontier!.enabled.map((c) => c.type)
    expect(enabledTypes).toContain('discovery.search')
  })

  test('the dispatch bridge maps a discovery.search call to the discovery tool', async () => {
    // Integration: a dispatch bridge with a scripted discovery tool registered
    // under the name the bridge would use. The bridge dispatches a
    // discovery.search call and gets the result — proving the harness-event
    // path works end-to-end through the existing dispatch bridge.
    const scriptedResults = [{ id: 'r1', name: 'weather-skill', description: 'weather', kind: 'skill' }]
    const discoveryTool = Object.defineProperty(
      async (input: unknown) => {
        const args = input as { mode: string; query: string }
        expect(args.mode).toBe('search')
        expect(args.query).toBe('weather')
        return { mode: 'search', results: scriptedResults }
      },
      'name',
      { value: 'discovery', configurable: true },
    ) as DispatchableTool

    const bridge = createDispatchBridge({ tools: { discovery: discoveryTool } })
    expect(bridge.has('discovery')).toBe(true)

    const output = await bridge.dispatch({
      name: 'discovery',
      arguments: JSON.stringify({ mode: 'search', query: 'weather' }),
      call_id: 'call_pd_1',
    })
    expect(output.status).toBe('completed')
    expect(output.call_id).toBe('call_pd_1')
    const result = JSON.parse(output.output) as { mode: string; results: typeof scriptedResults }
    expect(result.mode).toBe('search')
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.name).toBe('weather-skill')
  })
})

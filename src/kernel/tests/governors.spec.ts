import { describe, expect, test } from 'bun:test'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { frontierVerify } from '../../tools/frontier.ts'
import { DISCOVERY_WRITE_GOVERNOR, SCAN_BEGIN_EVENT } from '../governors.ts'
import { createKernel } from '../kernel.ts'
import { createReentryThread } from '../threads.ts'

const selectedTypes = (trace: { kind: string }[]): string[] =>
  trace
    .filter(
      (msg): msg is Extract<(typeof trace)[number], { kind: typeof TRACE_MESSAGE_KINDS.selection }> =>
        msg.kind === TRACE_MESSAGE_KINDS.selection,
    )
    .map((msg) => (msg as unknown as { selected: { type: string } }).selected.type)

describe('governors — discovery write-policy (root/threads learned thread)', () => {
  test('blocks discovery write requests outside the scan — observable in the frontier candidate set', async () => {
    const kernel = createKernel()
    const { frontier } = await kernel.runThreads({
      space: 'root',
      threads: [DISCOVERY_WRITE_GOVERNOR, createReentryThread({ type: 'discovery.create' })],
    })
    expect(frontier?.status).toBe('deadlock')
    // the write request is a candidate, but the governor's block filters it
    // from the enabled set — that filtering IS the observable block
    expect(frontier?.candidates.some((c) => c.type === 'discovery.create')).toBe(true)
    expect(frontier?.enabled.some((c) => c.type === 'discovery.create')).toBe(false)
  })

  test('relinquishes on scan.begin — the write request becomes selectable', async () => {
    const kernel = createKernel()
    const { trace } = await kernel.runThreads({
      space: 'root',
      threads: [
        DISCOVERY_WRITE_GOVERNOR,
        createReentryThread({ type: SCAN_BEGIN_EVENT }),
        createReentryThread({ type: 'discovery.create' }),
      ],
    })
    const types = selectedTypes(trace)
    expect(types).toContain(SCAN_BEGIN_EVENT)
    expect(types).toContain('discovery.create')
  })

  test('passes frontier-verify like every learned thread — and its self-gate fails it against a blocked floor request', async () => {
    // No scan.begin reachable: the pure blocker deadlocks the floor-requested
    // write — the governor fails its own gate (per the deadlock-trace
    // convention: no special casing for governors).
    const gated = await frontierVerify({
      threads: [DISCOVERY_WRITE_GOVERNOR, createReentryThread({ type: 'discovery.create' })],
      maxDepth: 10,
    })
    expect(gated.status).toBe('failed')
    expect(gated.findings.some((f) => f.code === 'deadlock')).toBe(true)

    // scan.begin reachable: the governor relinquishes, the write proceeds,
    // the program settles — verified.
    const relinquished = await frontierVerify({
      threads: [DISCOVERY_WRITE_GOVERNOR, createReentryThread({ type: 'discovery.create' })],
      triggers: [{ type: SCAN_BEGIN_EVENT, space: 'root' }],
      maxDepth: 10,
    })
    expect(relinquished.status).toBe('verified')
  })
})

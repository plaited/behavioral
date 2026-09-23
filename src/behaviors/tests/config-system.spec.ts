import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TRACE_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import { behavioral } from '../../behavioral/behavioral.ts'
import type { BPEvent, JsonObject, SelectionTrace, Thread, Trace } from '../../behavioral/behavioral.types.ts'
import { BEHAVIOR_MESSAGE_KINDS } from '../behaviors.constants.ts'
import { useSystemOne } from '../config-system-one.ts'
import { useSystemTwo } from '../config-system-two.ts'

/**
 * The config helpers' `entry` resolution — the custom-provider seam:
 *
 * - a RELATIVE entry resolves against BEHAVIORAL_HOME (where `init` scaffolds
 *   user provider entries), not the package's spawn cwd;
 * - an ABSOLUTE entry is used verbatim;
 * - absent entry keeps the bundled provider (covered by the family specs).
 *
 * Each case runs a real provider entry process (a custom `respond` returning a
 * marker answer) through the real host helper — the wire contract is unchanged.
 */

const selectionsOf = (traces: Trace[]): SelectionTrace[] =>
  traces.filter((t): t is SelectionTrace => t.kind === TRACE_MESSAGE_KINDS.selection)

const addThreadsWithStep =
  (program: ReturnType<typeof behavioral>) =>
  (threads: Thread[]): void => {
    for (const thread of threads) program.addThread(thread)
    program.step()
  }

/** One family's wiring: the request kind, the host helper, and a valid request input. */
const FAMILY = {
  systemOne: {
    kind: BEHAVIOR_MESSAGE_KINDS.system_one_request,
    input: { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } },
    wire: (entry: string) => useSystemOne({ endpoint: { url: 'http://unused.local', model: 'm' }, entry }),
    factory: 'configSystemOne',
    module: 'config-system-one.ts',
  },
  systemTwo: {
    kind: BEHAVIOR_MESSAGE_KINDS.system_two_request,
    input: { provider: 'custom', modelId: 'm', input: [] },
    wire: (entry: string) => useSystemTwo({ endpoints: { custom: { url: 'http://unused.local' } }, entry }),
    factory: 'configSystemTwo',
    module: 'config-system-two.ts',
  },
} as const

/** Write a custom provider entry returning a marker answer; returns its home-relative path. */
const writeCustomEntry = (home: string, file: string, respondLine: string, family: keyof typeof FAMILY): string => {
  mkdirSync(join(home, 'providers'), { recursive: true })
  // The import spec is an absolute file URL — robust in any environment (no
  // global-link assumption in the test runner).
  const target = resolve(import.meta.dir, '..', FAMILY[family].module)
  writeFileSync(
    join(home, 'providers', file),
    [
      `import { ${FAMILY[family].factory} } from '${pathToFileURL(target).href}'`,
      `const respond = async () => (${respondLine})`,
      `if (import.meta.main) ${FAMILY[family].factory}(respond)`,
      '',
    ].join('\n'),
  )
  return `providers/${file}`
}

/** Wire the family through the real host helper, send one request, await its result. */
const spawnAndCall = async ({
  entry,
  family,
}: {
  entry: string
  family: keyof typeof FAMILY
}): Promise<{ ok?: boolean; result?: { model?: string }; error?: { message?: string } }> => {
  const program = behavioral()
  const traces: Trace[] = []
  const { kind, input, wire } = FAMILY[family]
  const handle = wire(entry)(addThreadsWithStep(program))
  try {
    program.useTrace((trace: Trace) => {
      traces.push(trace)
      if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
      const selected = (trace as SelectionTrace).selected
      const event = { type: selected.type, detail: selected.detail, space: selected.space } as BPEvent
      if (event.type === kind) handle.send(event)
    })
    const id = 'entry-check'
    program.addThread({
      label: 'caller',
      once: true,
      rules: [{ request: { type: kind, detail: { id, input: input as JsonObject } } }],
    })
    program.trigger({ type: 'entry_check_pump', detail: {} })

    const deadline = Date.now() + 8_000
    for (;;) {
      const found = selectionsOf(traces).find((t) => {
        const detail = t.selected.detail as { id?: string } | undefined
        return (
          (t.selected.type === `${kind}_result` && detail?.id === id) ||
          t.selected.type === BEHAVIOR_MESSAGE_KINDS.behavior_error
        )
      })
      if (found !== undefined)
        return found.selected.detail as { ok?: boolean; result?: { model?: string }; error?: { message?: string } }
      if (Date.now() > deadline)
        throw new Error(`no result; saw: ${JSON.stringify(selectionsOf(traces).map((t) => t.selected.type))}`)
      await Bun.sleep(10)
    }
  } finally {
    handle.terminate()
  }
}

describe('config helpers — custom provider entry resolution', () => {
  let home: string
  const previousHome = process.env.BEHAVIORAL_HOME

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'behavioral-entry-'))
    process.env.BEHAVIORAL_HOME = home
  })

  afterAll(() => {
    if (previousHome === undefined) delete process.env.BEHAVIORAL_HOME
    else process.env.BEHAVIORAL_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  test('a relative entry resolves against BEHAVIORAL_HOME', async () => {
    const entry = writeCustomEntry(
      home,
      'my-one.behavior.ts',
      "{ model: 'custom-one', answers: { marker: { type: 'noul', noul: 0.5 } } }",
      'systemOne',
    )
    const detail = await spawnAndCall({ entry, family: 'systemOne' })
    expect(detail.ok).toBe(true)
    expect(detail.result?.model).toBe('custom-one')
  })

  test('an absolute entry is used verbatim', async () => {
    const entry = writeCustomEntry(
      home,
      'abs-one.behavior.ts',
      "{ model: 'abs-one', answers: { marker: { type: 'noul', noul: 0.5 } } }",
      'systemOne',
    )
    const detail = await spawnAndCall({ entry: resolve(home, entry), family: 'systemOne' })
    expect(detail.ok).toBe(true)
    expect(detail.result?.model).toBe('abs-one')
  })

  test('systemTwo resolves a relative entry against the home too', async () => {
    const entry = writeCustomEntry(home, 'my-two.behavior.ts', "{ model: 'custom-two', answers: {} }", 'systemTwo')
    const detail = await spawnAndCall({ entry, family: 'systemTwo' })
    expect(detail.ok).toBe(true)
    expect(detail.result?.model).toBe('custom-two')
  })
})

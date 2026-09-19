/**
 * Tools worker integration tests — exercised through the real worker boundary
 * speaking the behavioral event wire: a real Bun `Worker` running a real
 * `bash` subprocess, driven by `tool_call`/`tool_cancel` events.
 *
 * @remarks
 * No mocks. The behaviors proven here are the load-bearing claims: bounded
 * paging, ANSI stripping, error-as-data, in-worker clamping, space echo, and —
 * most importantly — soft preemption that actually reaps the process group
 * while the worker survives to run the next command.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from 'bun:test'
import { WORKER_MESSAGE_KINDS } from '../../behavioral/behavioral.constants.ts'
import type { ToolsResult } from '../tools-client.types.ts'

/** Pids whose command line matches `pattern` — used to prove a killed group is gone. */
const matching = async (pattern: string): Promise<string[]> =>
  (await Bun.$`ps -ef`.nothrow().quiet().text()).split('\n').filter((line) => line.includes(pattern))

/** Best-effort teardown so a failed cycle never leaks a sleeper. */
const killMatching = async (pattern: string): Promise<void> => {
  for (const line of await matching(pattern)) {
    const pid = Number(line.trim().split(/\s+/)[1])
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
}

type WireResult = { id: string; result: ToolsResult; space?: string }

/** Spawn the worker and expose an event-wire harness over it. */
const spawnToolsWorker = () => {
  const worker = new Worker(new URL('../tools-client.worker.ts', import.meta.url))
  const results: WireResult[] = []
  worker.onmessage = ({ data }: MessageEvent): void => {
    if (data?.type === WORKER_MESSAGE_KINDS.tool_call_result) {
      results.push({ id: data.detail.id, result: data.detail.result, space: data.space })
    }
  }
  const call = (id: string, input: unknown, space?: string): void => {
    worker.postMessage({
      type: WORKER_MESSAGE_KINDS.tool_call,
      detail: { id, tool: 'execute_shell', input },
      ...(space === undefined ? {} : { space }),
    })
  }
  const cancel = (id: string): void => {
    worker.postMessage({ type: WORKER_MESSAGE_KINDS.tool_cancel, detail: { id } })
  }
  const resultFor = async (id: string): Promise<WireResult> => {
    const deadline = Date.now() + 5_000
    for (;;) {
      const found = results.find((r) => r.id === id)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`no result for ${id}`)
      await Bun.sleep(10)
    }
  }
  return { call, cancel, resultFor, terminate: () => worker.terminate() }
}

describe('tools worker — event wire', () => {
  test('a tool_call event returns a tool_call_result event carrying the id', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'echo alive' })
      const { id, result } = await tools.resultFor('t1')
      expect(id).toBe('t1')
      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['alive'])
    } finally {
      tools.terminate()
    }
  })

  test('a request space is echoed on the result event', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'echo ok' }, 's1')
      const { space } = await tools.resultFor('t1')
      expect(space).toBe('s1')
    } finally {
      tools.terminate()
    }
  })

  test('a request without space returns a result without space', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'echo ok' })
      const { space } = await tools.resultFor('t1')
      expect(space).toBeUndefined()
    } finally {
      tools.terminate()
    }
  })

  test('input without a script is error data', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { format: 'raw' })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('error')
      expect(result.message).toContain('invalid')
    } finally {
      tools.terminate()
    }
  })

  test('unknown input keys are rejected as error data', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'echo ok', sneaky: true })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('error')
      expect(result.message).toContain('invalid')
    } finally {
      tools.terminate()
    }
  })

  test('an event failing the shared event schema is dropped — no result', async () => {
    const tools = spawnToolsWorker()
    try {
      // No id: fails the trust boundary, nothing to correlate a result to.
      tools.call('', { script: 'echo never' })
      tools.call('t2', { script: 'echo second' })
      const { id } = await tools.resultFor('t2')
      expect(id).toBe('t2')
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — cancellation', () => {
  test('a tool_cancel event reaps the process group and leaves the worker usable', async () => {
    const token = `TOOLS_CANCEL_${crypto.randomUUID().replace(/-/g, '')}`
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: `echo ${token}; sleep 31415` })
      await Bun.sleep(150)
      tools.cancel('t1')
      const { result } = await tools.resultFor('t1')

      expect(result.status).toBe('canceled')

      // The whole group is gone — leader and sleeper alike.
      expect(await matching(token)).toEqual([])
      expect(await matching('sleep 31415')).toEqual([])

      // Soft preemption: same worker, next command runs.
      tools.call('t2', { script: 'echo alive' })
      const next = await tools.resultFor('t2')
      expect(next.result.status).toBe('completed')
      expect(next.result.lines).toEqual(['alive'])
    } finally {
      await killMatching(token)
      await killMatching('sleep 31415')
      tools.terminate()
    }
  })
})

describe('tools worker — output streams', () => {
  test('stderr is captured separately from stdout', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'echo out; echo err >&2' })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['out'])
      expect(result.stderr).toBe('err')
    } finally {
      tools.terminate()
    }
  })

  test('ANSI escapes are stripped from captured lines', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: "printf '\\033[31mred\\033[0m\\n'" })
      const { result } = await tools.resultFor('t1')
      expect(result.lines).toEqual(['red'])
    } finally {
      tools.terminate()
    }
  })

  test('stderr is tail-bounded by maxCharacters with a truncation notice', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'seq 1 2000 >&2', maxCharacters: 100, maxLines: 5000 })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.stderr).toContain('2000')
      expect(result.stderr).toContain('truncated')
      expect(result.stderr).not.toContain('1\n2\n3')
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — json output', () => {
  test('valid JSON stdout is parsed into jsonData', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: `echo '{"a":1,"b":[2,3]}'`, format: 'json' })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.jsonData).toEqual({ a: 1, b: [2, 3] })
    } finally {
      tools.terminate()
    }
  })

  test('json stdout beyond maxCharacters is stopped and reported, not parsed', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'seq 1 2000', format: 'json', maxCharacters: 100, maxLines: 5000 })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('error')
      expect(result.message).toContain('output_exceeds_max_characters')
    } finally {
      tools.terminate()
    }
  })

  test('invalid JSON stdout is an error with a bounded snippet', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'echo not-json', format: 'json' })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('error')
      expect(result.message).toContain('json_parse_failed')
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — raw output', () => {
  test('raw keeps the tail bounded by maxCharacters with a truncation notice', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'seq 1 100', format: 'raw', maxCharacters: 24 })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.stdout).toContain('100')
      expect(result.stdout).toContain('truncated')
      expect(result.stdout).not.toContain('3\n4')
      expect(result.hasMore).toBe(true)
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — deadline', () => {
  test('an expired deadline group-kills the command and reports timeout', async () => {
    const token = `TOOLS_TIMEOUT_${crypto.randomUUID().replace(/-/g, '')}`
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: `echo ${token}; sleep 31416`, timeoutMs: 300 })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('timeout')
      expect(await matching(token)).toEqual([])
      expect(await matching('sleep 31416')).toEqual([])
    } finally {
      await killMatching(token)
      await killMatching('sleep 31416')
      tools.terminate()
    }
  })
})

describe('tools worker — line quota', () => {
  test('the line cap group-kills a flooding command at maxLines', async () => {
    const token = `TOOLS_QUOTA_${crypto.randomUUID().replace(/-/g, '')}`
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: `echo ${token}; while true; do echo flood; done`, maxLines: 20 })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('line_quota')
      expect(result.totalLines).toBe(20)
      expect(await matching(token)).toEqual([])
    } finally {
      await killMatching(token)
      tools.terminate()
    }
  })
})

describe('tools worker — clamps', () => {
  test('over-ceiling input bounds are clamped and the clamp is reported', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'echo ok', timeoutMs: 999_999, maxLines: 9_999 })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.clamped).toEqual(['timeoutMs 999999 -> 120000', 'maxLines 9999 -> 5000'])
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — failures', () => {
  test('a spawn failure resolves as error data and never rejects', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'echo ok', cwd: '/nonexistent-tools-spec-dir' })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('error')
      expect(typeof result.message).toBe('string')
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — output bounds', () => {
  test('a line larger than maxCharacters is flushed in bounded pieces', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', {
        script: `awk 'BEGIN{for(i=0;i<1000;i++)printf "xxxxxxxxxx";print ""}'`,
        maxCharacters: 200,
        maxLines: 5000,
      })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.totalLines).toBe(50)
      expect(result.lines?.every((line) => line.length <= 200)).toBe(true)
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — stdin', () => {
  test('host-supplied stdin reaches the command', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'cat', stdin: 'hello-stdin' })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['hello-stdin'])
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — exit status', () => {
  test('a non-zero exit is completed data with the real exit code', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'exit 3' })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(3)
    } finally {
      tools.terminate()
    }
  })
})

describe('tools worker — paged output', () => {
  test('defaults return every line with totalLines and hasMore false', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'seq 1 10' })
      const { result } = await tools.resultFor('t1')
      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(0)
      expect(result.lines).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(false)
    } finally {
      tools.terminate()
    }
  })

  test('offset skips lines and limit bounds the window', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'seq 1 10', offset: 5, limit: 3 })
      const { result } = await tools.resultFor('t1')
      expect(result.lines).toEqual(['6', '7', '8'])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(true)
    } finally {
      tools.terminate()
    }
  })

  test('a window that ends exactly at the last line reports hasMore false', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'seq 1 10', offset: 7, limit: 3 })
      const { result } = await tools.resultFor('t1')
      expect(result.lines).toEqual(['8', '9', '10'])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(false)
    } finally {
      tools.terminate()
    }
  })

  test('an offset past the last line returns an empty window', async () => {
    const tools = spawnToolsWorker()
    try {
      tools.call('t1', { script: 'seq 1 10', offset: 20, limit: 5 })
      const { result } = await tools.resultFor('t1')
      expect(result.lines).toEqual([])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(false)
    } finally {
      tools.terminate()
    }
  })
})

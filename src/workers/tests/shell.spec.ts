/**
 * Shell executor integration tests — exercised through the real worker
 * boundary: a real Bun `Worker` running a real `bash` subprocess.
 *
 * @remarks
 * No mocks. The behaviors proven here are the spec's load-bearing claims:
 * bounded paging, ANSI stripping, error-as-data, and — most importantly —
 * soft preemption that actually reaps the process group while the worker
 * survives to run the next command.
 *
 * @packageDocumentation
 */

import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createShellExecutor } from '../use-shell.ts'

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

describe('shell executor — cancellation', () => {
  test('cancel reaps the process group and leaves the worker usable', async () => {
    const token = `SHELL_CANCEL_${crypto.randomUUID().replace(/-/g, '')}`
    let executor: ReturnType<typeof createShellExecutor> | undefined
    let target: string | undefined
    try {
      executor = createShellExecutor({
        onLine: (event) => {
          if (event.line.includes(token) && target === undefined) {
            target = event.id
            void executor?.cancel(event.id)
          }
        },
      })

      const pending = executor.execute(`echo ${token}; sleep 31415`)
      const result = await Promise.race([pending, Bun.sleep(2_000).then(() => undefined)])

      expect(result).toBeDefined()
      expect(result?.status).toBe('canceled')
      expect(target).toBeDefined()

      // The whole group is gone — leader and sleeper alike.
      expect(await matching(token)).toEqual([])
      expect(await matching('sleep 31415')).toEqual([])

      // Soft preemption: same worker, next command runs.
      const next = await executor.execute('echo alive')
      expect(next.status).toBe('completed')
      expect(next.lines).toEqual(['alive'])
    } finally {
      await killMatching(token)
      await killMatching('sleep 31415')
      executor?.destroy()
    }
  })
})

describe('shell executor — output streams', () => {
  test('stderr is captured separately from stdout', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('echo out; echo err >&2')

      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['out'])
      expect(result.stderr).toBe('err')
    } finally {
      executor.destroy()
    }
  })

  test('ANSI escapes are stripped from captured lines', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute("printf '\\033[31mred\\033[0m\\n'")

      expect(result.lines).toEqual(['red'])
    } finally {
      executor.destroy()
    }
  })

  test('stderr is tail-bounded by maxCharacters with a truncation notice', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('seq 1 2000 >&2', { maxCharacters: 100, maxLines: 5000 })

      expect(result.status).toBe('completed')
      expect(result.stderr).toContain('2000')
      expect(result.stderr).toContain('truncated')
      expect(result.stderr).not.toContain('1\n2\n3')
    } finally {
      executor.destroy()
    }
  })
})

describe('shell executor — json output', () => {
  test('valid JSON stdout is parsed into jsonData', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute(`echo '{"a":1,"b":[2,3]}'`, { format: 'json' })

      expect(result.status).toBe('completed')
      expect(result.jsonData).toEqual({ a: 1, b: [2, 3] })
    } finally {
      executor.destroy()
    }
  })

  test('json stdout beyond maxCharacters is stopped and reported, not parsed', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('seq 1 2000', { format: 'json', maxCharacters: 100, maxLines: 5000 })

      expect(result.status).toBe('error')
      expect(result.message).toContain('output_exceeds_max_characters')
    } finally {
      executor.destroy()
    }
  })

  test('invalid JSON stdout is an error with a bounded snippet', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('echo not-json', { format: 'json' })

      expect(result.status).toBe('error')
      expect(result.message).toContain('json_parse_failed')
    } finally {
      executor.destroy()
    }
  })
})

describe('shell executor — raw output', () => {
  test('raw keeps the tail bounded by maxCharacters with a truncation notice', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('seq 1 100', { format: 'raw', maxCharacters: 24 })

      expect(result.status).toBe('completed')
      expect(result.stdout).toContain('100')
      expect(result.stdout).toContain('truncated')
      expect(result.stdout).not.toContain('3\n4')
      expect(result.hasMore).toBe(true)
    } finally {
      executor.destroy()
    }
  })
})

describe('shell executor — onLine seam', () => {
  test('lines stream to onLine with their stream and a monotonic number', async () => {
    const seen: { lineNumber: number; stream: string; line: string }[] = []
    const executor = createShellExecutor({
      onLine: (event) => {
        seen.push({ lineNumber: event.lineNumber, stream: event.stream, line: event.line })
      },
    })
    try {
      const result = await executor.execute('echo out; echo err >&2')

      expect(result.status).toBe('completed')
      expect(seen.find((event) => event.line === 'out')?.stream).toBe('stdout')
      expect(seen.find((event) => event.line === 'err')?.stream).toBe('stderr')
      expect(seen.map((event) => event.lineNumber).sort((a, b) => a - b)).toEqual([1, 2])
    } finally {
      executor.destroy()
    }
  })
})

describe('shell executor — deadline', () => {
  test('an expired deadline group-kills the command and reports timeout', async () => {
    const token = `SHELL_TIMEOUT_${crypto.randomUUID().replace(/-/g, '')}`
    const executor = createShellExecutor()
    try {
      const pending = executor.execute(`echo ${token}; sleep 31416`, { timeoutMs: 300 })
      const result = await Promise.race([pending, Bun.sleep(2_000).then(() => undefined)])

      expect(result).toBeDefined()
      expect(result?.status).toBe('timeout')
      expect(await matching(token)).toEqual([])
      expect(await matching('sleep 31416')).toEqual([])
    } finally {
      await killMatching(token)
      await killMatching('sleep 31416')
      executor.destroy()
    }
  })
})

describe('shell executor — line quota', () => {
  test('the line cap group-kills a flooding command at maxLines', async () => {
    const token = `SHELL_QUOTA_${crypto.randomUUID().replace(/-/g, '')}`
    const executor = createShellExecutor()
    try {
      const pending = executor.execute(`echo ${token}; while true; do echo flood; done`, { maxLines: 20 })
      const result = await Promise.race([pending, Bun.sleep(2_000).then(() => undefined)])

      expect(result).toBeDefined()
      expect(result?.status).toBe('line_quota')
      expect(result?.totalLines).toBe(20)
      expect(await matching(token)).toEqual([])
    } finally {
      await killMatching(token)
      executor.destroy()
    }
  })
})

describe('shell executor — ceilings', () => {
  test('over-ceiling knobs are clamped and the clamp is reported', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('echo ok', { timeoutMs: 999_999, maxLines: 9_999 })

      expect(result.status).toBe('completed')
      expect(result.clamped).toEqual(['timeoutMs 999999 -> 120000', 'maxLines 9999 -> 5000'])
    } finally {
      executor.destroy()
    }
  })

  test('ceilings are executor config — a lowered ceiling clamps too', async () => {
    const executor = createShellExecutor({ ceilings: { timeoutMs: 250 } })
    try {
      const result = await executor.execute('echo ok', { timeoutMs: 600 })

      expect(result.clamped).toEqual(['timeoutMs 600 -> 250'])
    } finally {
      executor.destroy()
    }
  })
})

describe('shell executor — failures', () => {
  test('a spawn failure resolves as error data and never rejects', async () => {
    const executor = createShellExecutor()
    try {
      const pending = executor.execute('echo ok', { cwd: '/nonexistent-shell-spec-dir' })
      const result = await Promise.race([pending, Bun.sleep(2_000).then(() => undefined)])

      expect(result).toBeDefined()
      expect(result?.status).toBe('error')
      expect(typeof result?.message).toBe('string')
    } finally {
      executor.destroy()
    }
  })

  test('a crashed worker resolves in-flight and future work as error data', async () => {
    const crashPath = join(tmpdir(), `shell-crash-${crypto.randomUUID()}.ts`)
    await Bun.write(crashPath, 'throw new Error("boom")')
    const executor = createShellExecutor({ workerUrl: crashPath })
    try {
      const first = await Promise.race([executor.execute('echo never'), Bun.sleep(2_000).then(() => undefined)])
      expect(first).toBeDefined()
      expect(first?.status).toBe('error')

      const after = await Promise.race([executor.execute('echo never'), Bun.sleep(500).then(() => undefined)])
      expect(after).toBeDefined()
      expect(after?.status).toBe('error')
    } finally {
      executor.destroy()
      await Bun.$`rm -f ${crashPath}`.quiet().nothrow()
    }
  })
})

describe('shell executor — output bounds', () => {
  test('a line larger than maxCharacters is flushed in bounded pieces', async () => {
    const executor = createShellExecutor()
    try {
      // One 10,000-character line with no newline inside it.
      const result = await executor.execute(`awk 'BEGIN{for(i=0;i<1000;i++)printf "xxxxxxxxxx";print ""}'`, {
        maxCharacters: 200,
        maxLines: 5000,
      })

      expect(result.status).toBe('completed')
      expect(result.totalLines).toBe(50)
      expect(result.lines?.every((line) => line.length <= 200)).toBe(true)
    } finally {
      executor.destroy()
    }
  })
})

describe('shell executor — teardown', () => {
  test('destroy cancels in-flight work, resolves it, and reaps its processes', async () => {
    const token = `SHELL_DESTROY_${crypto.randomUUID().replace(/-/g, '')}`
    const executor = createShellExecutor()
    try {
      const pending = executor.execute(`echo ${token}; sleep 31418`)
      await Bun.sleep(200)
      executor.destroy()
      const result = await Promise.race([pending, Bun.sleep(2_000).then(() => undefined)])

      expect(result).toBeDefined()
      expect(result?.status).toBe('canceled')
      expect(await matching(token)).toEqual([])
      expect(await matching('sleep 31418')).toEqual([])
    } finally {
      await killMatching(token)
      await killMatching('sleep 31418')
    }
  })
})

describe('shell executor — stdin', () => {
  test('host-supplied stdin reaches the command', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('cat', { stdin: 'hello-stdin' })

      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['hello-stdin'])
    } finally {
      executor.destroy()
    }
  })
})

describe('shell executor — exit status', () => {
  test('a non-zero exit is completed data with the real exit code', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('exit 3')

      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(3)
    } finally {
      executor.destroy()
    }
  })
})

describe('shell executor — paged output', () => {
  test('defaults return every line with totalLines and hasMore false', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('seq 1 10')

      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(0)
      expect(result.lines).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(false)
    } finally {
      executor.destroy()
    }
  })

  test('offset skips lines and limit bounds the window', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('seq 1 10', { offset: 5, limit: 3 })

      expect(result.lines).toEqual(['6', '7', '8'])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(true)
    } finally {
      executor.destroy()
    }
  })

  test('a window that ends exactly at the last line reports hasMore false', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('seq 1 10', { offset: 7, limit: 3 })

      expect(result.lines).toEqual(['8', '9', '10'])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(false)
    } finally {
      executor.destroy()
    }
  })

  test('an offset past the last line returns an empty window', async () => {
    const executor = createShellExecutor()
    try {
      const result = await executor.execute('seq 1 10', { offset: 20, limit: 5 })

      expect(result.lines).toEqual([])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(false)
    } finally {
      executor.destroy()
    }
  })
})

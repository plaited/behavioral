import { describe, expect, test } from 'bun:test'
import { readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ShellResult } from '../shell.types.ts'
import { WORKER_MESSAGE_KINDS } from '../workers.constants.ts'

/**
 * Shell worker integration tests — exercised through the real worker
 * boundary speaking the behavioral event wire: `shell_request` events in
 * (op-discriminated: 'run' = a TS script executed bun-direct via
 * `bun run -`; 'shell' = a Bun Shell command through the constant wrapper),
 * one `shell_request_result` out.
 *
 * @remarks
 * The executor is BUN everywhere — no bash, no POSIX shell dependency. The
 * `run` op spawns `bun run -` with the script on stdin. The `shell` op spawns
 * the same bun entry with the constant wrapper on stdin; the command rides
 * env (`EXEC_CMD`) and the payload rides env (`EXEC_STDIN`) or, over the
 * large-payload threshold, a temp file (`EXEC_STDIN_PATH` /
 * `EXEC_CMD_PATH` + Bun.file redirect). Payload temp files are deleted in
 * the worker's after-path on EVERY exit — completion and kill alike.
 *
 * @packageDocumentation
 */

type WireResult = { id: string; result: ShellResult; space?: string }

/** Spawn the shell worker and expose an event-wire harness over it. */
const spawnShellWorker = () => {
  const worker = new Worker(new URL('../shell.worker.ts', import.meta.url))
  const results: WireResult[] = []
  worker.onmessage = ({ data }: MessageEvent): void => {
    if (data?.type === WORKER_MESSAGE_KINDS.shell_request_result) {
      results.push({ id: data.detail.id, result: data.detail.result, space: data.space })
    }
  }
  const run = (id: string, script: string, extra?: Record<string, unknown>, space?: string): void => {
    worker.postMessage({
      type: WORKER_MESSAGE_KINDS.shell_request,
      detail: { id, label: 'test-run', input: { op: 'run', script, ...extra } },
      ...(space === undefined ? {} : { space }),
    })
  }
  const sh = (id: string, command: string, extra?: Record<string, unknown>, space?: string): void => {
    worker.postMessage({
      type: WORKER_MESSAGE_KINDS.shell_request,
      detail: { id, label: 'test-sh', input: { op: 'shell', command, ...extra } },
      ...(space === undefined ? {} : { space }),
    })
  }
  const cancel = (id: string): void => {
    worker.postMessage({ type: WORKER_MESSAGE_KINDS.shell_cancel, detail: { id } })
  }
  const resultFor = async (id: string): Promise<WireResult> => {
    const deadline = Date.now() + 8_000
    for (;;) {
      const found = results.find((r) => r.id === id)
      if (found !== undefined) return found
      if (Date.now() > deadline) throw new Error(`no result for ${id}`)
      await Bun.sleep(10)
    }
  }
  return { run, sh, cancel, resultFor, terminate: () => worker.terminate() }
}

/** Leftover payload temp files in the OS tmpdir (the cleanup observable). */
const leftoverPayloadFiles = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('shell-payload-'))

describe('shell worker — event wire', () => {
  test('a shell_request event returns a shell_request_result carrying the id', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('w1', 'console.log("wire-ok")')
      const { id, result } = await shell.resultFor('w1')
      expect(id).toBe('w1')
      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['wire-ok'])
    } finally {
      shell.terminate()
    }
  })

  test('a request space is echoed on the result event', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('w2', 'console.log("spaced")', undefined, 'demo')
      const { space } = await shell.resultFor('w2')
      expect(space).toBe('demo')
    } finally {
      shell.terminate()
    }
  })

  test('input without the op-discriminated payload is error data', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('w3', 'console.log("never")') // then overwrite via sh with a bad shape:
      // 'run' without script, 'shell' without command, and an unknown op:
      shell.run('w4', '')
      const { result } = await shell.resultFor('w4')
      expect(result.status).toBe('error')
      expect(String(result.message).includes('invalid input')).toBe(true)
    } finally {
      shell.terminate()
    }
  })

  test('unknown input keys are rejected as error data — the op boundary is strict', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('w5', 'console.log(1)', { unknownKnob: true })
      const { result } = await shell.resultFor('w5')
      expect(result.status).toBe('error')
      expect(String(result.message).includes('invalid input')).toBe(true)
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — run op (bun-direct TS scripts)', () => {
  test('a TS script executes via bun run - with no bash in the tree', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('r1', 'console.log(JSON.stringify({ via: "bun", env: Bun.env.RUN_OP_VAR }))', {
        env: { RUN_OP_VAR: 'merged' },
        format: 'json',
      })
      const { result } = await shell.resultFor('r1')
      expect(result.status).toBe('completed')
      expect(result.jsonData).toEqual({ via: 'bun', env: 'merged' })
    } finally {
      shell.terminate()
    }
  })

  test('cwd option directs the script', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('r2', 'console.log(process.cwd())', { cwd: tmpdir() })
      const { result } = await shell.resultFor('r2')
      // macOS resolves /var → /private/var in the child — compare real paths
      expect(result.lines?.[0]).toBe(realpathSync(tmpdir()))
    } finally {
      shell.terminate()
    }
  })

  test('valid JSON stdout parses into jsonData; invalid is an error with a bounded snippet', async () => {
    const shell = spawnShellWorker()
    try {
      shell.run('r3', 'console.log(JSON.stringify({a: 1}))', { format: 'json' })
      const good = await shell.resultFor('r3')
      expect(good.result.jsonData).toEqual({ a: 1 })
      shell.run('r4', 'console.log("not json {")', { format: 'json' })
      const bad = await shell.resultFor('r4')
      expect(bad.result.status).toBe('error')
      expect(String(bad.result.message).includes('json_parse_failed')).toBe(true)
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — shell op (Bun Shell commands via the wrapper)', () => {
  test('echo completes with real stdout and a zero exit', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s1', 'echo shell-op-works')
      const { result } = await shell.resultFor('s1')
      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['shell-op-works'])
      expect(result.exitCode).toBe(0)
    } finally {
      shell.terminate()
    }
  })

  test('a non-zero exit is completed data with the real exit code', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s2', 'echo failing; exit 3')
      const { result } = await shell.resultFor('s2')
      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(3)
    } finally {
      shell.terminate()
    }
  })

  test('dialect: pipes, chains, and command substitution behave', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s3', 'echo hello bun shell | wc -w')
      const { result } = await shell.resultFor('s3')
      expect(result.lines?.[0]?.trim()).toBe('3')
      shell.sh('s4', 'echo done-$(echo now)')
      const sub = await shell.resultFor('s4')
      expect(sub.result.lines).toEqual(['done-now'])
    } finally {
      shell.terminate()
    }
  })

  test('stdin reaches the command through the env channel', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s5', 'cat', { stdin: 'payload-line-1\npayload-line-2' })
      const { result } = await shell.resultFor('s5')
      expect(result.lines).toEqual(['payload-line-1', 'payload-line-2'])
    } finally {
      shell.terminate()
    }
  })

  test('a command carrying its own stdin redirect still works', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('s6', `cat < ${import.meta.path}`, { maxLines: 5_000 })
      const { result } = await shell.resultFor('s6')
      expect(result.status).toBe('completed')
      expect((result.lines ?? []).length).toBeGreaterThan(10)
    } finally {
      shell.terminate()
    }
  })

  test('a large command rides the temp-file channel and completes', async () => {
    const shell = spawnShellWorker()
    const before = leftoverPayloadFiles()
    try {
      // > the 100KB env threshold — the command text itself is the payload
      const big = `echo ${'x'.repeat(150_000)}`
      shell.sh('s7', big, { maxCharacters: 200_000 })
      const { result } = await shell.resultFor('s7')
      expect(result.status).toBe('completed')
      expect(result.lines?.[0]?.length).toBe(150_000)
      // sensible deletion: no payload temp files survive completion
      expect(leftoverPayloadFiles().filter((f) => !before.includes(f))).toEqual([])
    } finally {
      shell.terminate()
    }
  })

  test('a large stdin payload rides the temp-file channel into the command', async () => {
    const shell = spawnShellWorker()
    const before = leftoverPayloadFiles()
    try {
      shell.sh('s8', 'wc -c', { stdin: 'y'.repeat(150_000), maxCharacters: 200_000 })
      const { result } = await shell.resultFor('s8')
      expect(result.status).toBe('completed')
      expect(result.lines?.[0]?.trim()).toBe('150000')
      expect(leftoverPayloadFiles().filter((f) => !before.includes(f))).toEqual([])
    } finally {
      shell.terminate()
    }
  })

  test('temp files are deleted even when the command is killed — the after-path always runs', async () => {
    const shell = spawnShellWorker()
    const before = leftoverPayloadFiles()
    try {
      const big = `echo ${'z'.repeat(150_000)}; sleep 30`
      shell.sh('s9', big, { timeoutMs: 200 })
      const { result } = await shell.resultFor('s9')
      expect(result.status).toBe('timeout')
      await Bun.sleep(100) // the finally-path delete is async
      expect(leftoverPayloadFiles().filter((f) => !before.includes(f))).toEqual([])
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — containment', () => {
  test('an expired deadline group-kills the tree and reports timeout', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('k1', 'sleep 30', { timeoutMs: 200 })
      const { result } = await shell.resultFor('k1')
      expect(result.status).toBe('timeout')
    } finally {
      shell.terminate()
    }
  })

  test('a shell_cancel reaps the process group and leaves the worker usable', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('k2', 'sleep 30')
      await Bun.sleep(250) // let the wrapper start and the sleeper spawn
      shell.cancel('k2')
      const killed = await shell.resultFor('k2')
      expect(killed.result.status).toBe('canceled')
      // usable after: a fresh call completes
      shell.sh('k3', 'echo still-alive')
      const after = await shell.resultFor('k3')
      expect(after.result.status).toBe('completed')
    } finally {
      shell.terminate()
    }
  })

  test('the line cap group-kills a flooding command at maxLines', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('k4', 'yes flooding', { maxLines: 20 })
      const { result } = await shell.resultFor('k4')
      expect(result.status).toBe('line_quota')
    } finally {
      shell.terminate()
    }
  })

  test('over-ceiling input bounds are clamped and the clamp is reported', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('k5', 'echo clamp-check', { limit: 5_000, maxCharacters: 300_000 })
      const { result } = await shell.resultFor('k5')
      expect(result.status).toBe('completed')
      expect(result.clamped).toEqual(['maxCharacters 300000 -> 200000', 'limit 5000 -> 1000'])
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — paging', () => {
  test('defaults return every line with totalLines and hasMore false', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('p1', 'seq 1 5')
      const { result } = await shell.resultFor('p1')
      expect(result.status).toBe('completed')
      expect(result.lines).toEqual(['1', '2', '3', '4', '5'])
      expect(result.totalLines).toBe(5)
      expect(result.hasMore).toBe(false)
    } finally {
      shell.terminate()
    }
  })

  test('offset skips lines and limit bounds the window', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('p2', 'seq 1 10', { offset: 2, limit: 3 })
      const { result } = await shell.resultFor('p2')
      expect(result.lines).toEqual(['3', '4', '5'])
      expect(result.totalLines).toBe(10)
      expect(result.hasMore).toBe(true)
    } finally {
      shell.terminate()
    }
  })
})

describe('shell worker — raw format + stderr', () => {
  test('raw keeps the tail bounded by maxCharacters with a truncation notice', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('q1', 'seq 1 4000', { format: 'raw', maxCharacters: 2_000, maxLines: 5_000 })
      const { result } = await shell.resultFor('q1')
      expect(result.status).toBe('completed')
      expect(String(result.stdout).includes('[...truncated')).toBe(true)
      expect(result.hasMore).toBe(true)
    } finally {
      shell.terminate()
    }
  })

  test('stderr is captured separately from stdout', async () => {
    const shell = spawnShellWorker()
    try {
      shell.sh('q2', 'echo to-out; echo to-err 1>&2')
      const { result } = await shell.resultFor('q2')
      expect(result.lines).toEqual(['to-out'])
      expect(result.stderr).toBe('to-err')
    } finally {
      shell.terminate()
    }
  })
})

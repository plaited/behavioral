import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { instancePidfilePath } from '../../faculties/instance-lock.ts'
import { instanceSocketPath } from '../socket-host.ts'

const homes: string[] = []
const tempHome = (): string => {
  const home = join(tmpdir(), `behavioral-attach-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  homes.push(home)
  mkdirSync(home, { recursive: true })
  return home
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

/** Poll until `pred` holds or the timeout elapses. */
const eventually = async (pred: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> => {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

/** Incrementally drain a subprocess stream into a string. */
const collect = (stream: ReadableStream<Uint8Array>): { text: () => string } => {
  const decoder = new TextDecoder()
  let acc = ''
  void (async () => {
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
        acc += decoder.decode(chunk, { stream: true })
    } catch {
      // Stream torn down with the process.
    }
  })()
  return { text: () => acc }
}

/** The two-process fixture: mode 'start' boots the foreground instance; mode 'attach' attaches. */
const spawnLifecycleProcess = (mode: 'start' | 'attach', home: string) =>
  Bun.spawn({
    cmd: ['bun', 'run', join(import.meta.dir, 'fixtures', 'attach-instance.ts'), mode],
    env: { ...process.env, BEHAVIORAL_HOME: home },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

const pidOf = async (home: string): Promise<number> =>
  (JSON.parse(await Bun.file(instancePidfilePath(home)).text()) as { pid: number }).pid

describe('attachOrStart — the two-process lifecycle', () => {
  test('a bare start owns the home; an attacher reuses it; SIGTERM cleans up', async () => {
    const home = tempHome()
    const instance = spawnLifecycleProcess('start', home)
    const instanceOut = collect(instance.stdout)

    // The instance is up: the socket file exists and the pidfile names its pid.
    const socketPath = instanceSocketPath(home)
    await eventually(() => existsSync(socketPath), 'instance socket')
    const instancePid = await pidOf(home)
    expect(instancePid).toBeGreaterThan(0)

    // Second process: attach-or-start must attach, never spawn a second instance.
    const attacher = spawnLifecycleProcess('attach', home)
    const attacherOut = collect(attacher.stdout)
    attacher.stdin.write('/kick\n')
    await eventually(() => attacherOut.text().includes('attached to running instance'), 'attach notice')

    // No second instance: the pidfile still names the first instance's pid.
    expect(await pidOf(home)).toBe(instancePid)

    // The trigger crossed processes: the instance selected the tui_command event.
    await eventually(() => instanceOut.text().includes('tui_command'), 'trigger selection trace on the instance')

    // The attacher's stdin ends → it detaches; the instance keeps running.
    attacher.stdin.end()
    const attacherCode = await attacher.exited
    expect(attacherCode).toBe(0)
    expect(existsSync(socketPath)).toBe(true)
    expect(await pidOf(home)).toBe(instancePid)

    // SIGTERM: terminate + pidfile/socket cleanup (the daemon-door discipline).
    instance.kill('SIGTERM')
    const instanceCode = await instance.exited
    expect(instanceCode).toBe(0)
    await eventually(() => !existsSync(socketPath), 'socket removal')
    expect(existsSync(instancePidfilePath(home))).toBe(false)
  }, 40_000)

  test('a stale pidfile is reaped and the instance starts fresh', async () => {
    const home = tempHome()
    await Bun.write(instancePidfilePath(home), JSON.stringify({ pid: 999_999_999 }))
    const instance = spawnLifecycleProcess('start', home)
    await eventually(() => existsSync(instanceSocketPath(home)), 'instance socket after stale-pidfile reap')
    const pid = await pidOf(home)
    expect(pid).toBeGreaterThan(1)
    expect(pid).not.toBe(999_999_999)
    instance.kill('SIGTERM')
    await instance.exited
  }, 40_000)
})

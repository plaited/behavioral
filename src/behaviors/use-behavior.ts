import type { ValidateFunction } from 'ajv'
import type { BPEvent, Thread } from '../behavioral/behavioral.types.ts'
import { BEHAVIOR_MESSAGE_KINDS } from './behaviors.constants.ts'
import type { AddThreads } from './behaviors.types.ts'

type WireMessage = {
  type: string
  detail: import('../behavioral/behavioral.types.ts').JsonObject & { id: string }
  space?: string
}

/**
 * The spawn-based family wiring primitive — the process-composition ruling:
 * capability families run as Bun.spawn PROCESSES speaking the unchanged
 * behavioral wire over stdio lines (one JSON event per line), one process
 * instance per wiring (per space), replacing the Worker model for
 * shell/store/responses/mcp.
 *
 * @remarks
 * Why processes over Workers (the ruling's arithmetic): a shared Worker was
 * head-of-line blocking across spaces by construction; a process per space
 * isolates by OS construction, kills via the process tree, and tears down
 * without dead-port stragglers — killing a process closes its pipes.
 *
 * Curried like its Worker ancestor: the initial call captures the family's
 * command, wire name, thread pack, validators, and an optional `env` override
 * (merged over the inherited environment); the returned function
 * — awaiting `(addThreads, space?)` — wires:
 *
 * - **the line pump** — stdout lines parsed, gated by `validateResultEvent`
 *   (the RESULT validator owns the inbound lane), re-entered as once-threads
 *   with `message.space` PRESERVED;
 * - **crash synthesis** — an unsolicited process death (any exit we did not
 *   cause) re-enters exactly ONE `behavior_error { behavior: name }` event;
 *   malformed lines are discarded (the pasted JSON-RPC client's rule);
 * - **respawn on demand** — the next outbound event spawns a fresh process
 *   after a death; one live process per family wiring at all times;
 * - **thread-pack mounting** — stamped with the wiring space only when set.
 *
 * `send(event)` is the family's outbound port: JSON line to the process's
 * stdin (spawning if dead). `invalidEventGate` is the routing-side boundary
 * check (request + cancel schemas; type-const discrimination holds). The
 * engine's threads correlate results by id and `waitFor [result,
 * worker_error]` — the documented pattern — so no pending map exists;
 * in-flight requests at death simply never answer, which the waitFor pair
 * already covers.
 */
export const useBehavior =
  ({
    command,
    name,
    threads,
    env,
    validateRequestEvent,
    validateEventCancel,
    validateResultEvent,
  }: {
    command: string[]
    name: string
    threads: Thread[]
    /** Extra environment for the spawned process, merged over `process.env`. */
    env?: Record<string, string>
    validateRequestEvent: ValidateFunction<WireMessage>
    validateEventCancel: ValidateFunction<WireMessage>
    validateResultEvent: ValidateFunction<WireMessage>
  }) =>
  (addThreads: AddThreads, space?: string) => {
    let proc: Bun.Subprocess<'pipe', 'pipe', 'inherit'> | undefined
    let terminated = false
    let crashed = false
    let pumping = false
    let carry = ''

    /** Re-enter one event as a once-thread, space preserved (root stays root). */
    const reenter = (message: WireMessage): void => {
      addThreads([
        {
          ...(message.space === undefined ? {} : { space: message.space }),
          label: `on_${message.type}_${message.detail.id}`,
          once: true,
          rules: [{ request: { type: message.type, detail: message.detail } }],
        },
      ])
    }

    /** Crash synthesis — exactly ONE worker_error per unsolicited death. */
    const onDeath = (code: number | null): void => {
      if (terminated) return
      crashed = true
      reenter({
        type: BEHAVIOR_MESSAGE_KINDS.behavior_error,
        detail: {
          id: `crash_${name}_${crypto.randomUUID()}`,
          behavior: name,
          message: `process exited (${code ?? 'signal'})`,
        },
      })
    }

    /** Spawn the family process (fresh on first send and after any death). */
    const spawn = (): Bun.Subprocess<'pipe', 'pipe', 'inherit'> => {
      const child = Bun.spawn(command, {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
        cwd: import.meta.dir,
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      })
      // One crash synthesis per death — the listener itself is per-process,
      // so a respawn arms a fresh listener for the next death.
      void child.exited.then((code) => onDeath(code))
      return child
    }

    /** Pump stdout lines to the result lane; run once per process. */
    const pump = async (): Promise<void> => {
      if (pumping) return
      pumping = true
      try {
        const reader = proc!.stdout.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const current = proc
          if (current === undefined) break
          const { done, value } = await reader.read()
          if (done) break
          carry += decoder.decode(value, { stream: true })
          const lines = carry.split('\n')
          carry = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed === '') continue
            let message: WireMessage
            try {
              message = JSON.parse(trimmed) as WireMessage
            } catch {
              // Discard malformed, non-JSON output (the line protocol's rule).
              continue
            }
            if (!validateResultEvent(message)) continue
            reenter(message)
          }
        }
      } finally {
        pumping = false
      }
    }

    /** The family's outbound port: one JSON line to the process stdin. */
    const send = (event: BPEvent): void => {
      if (terminated) return
      if (proc === undefined || crashed) {
        crashed = false
        proc = spawn()
        void pump()
      }
      proc.stdin?.write(`${JSON.stringify(event)}\n`)
    }

    const invalidEventGate = (event: BPEvent): boolean => !validateRequestEvent(event) && !validateEventCancel(event)

    // Pack mount — stamped only when set (an explicit `space: undefined`
    // breaks the strict Thread schema; the reenter rule, applied to packs).
    addThreads(threads.map((thread) => (space === undefined ? thread : { ...thread, space })))

    return {
      name,
      send,
      invalidEventGate,
      /** Teardown: the composition (or host) kills the process it spawned. */
      terminate: (): void => {
        terminated = true
        proc?.kill()
      },
    }
  }

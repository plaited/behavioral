import type { Trace } from '../behavioral/behavioral.types.ts'
import { validateHelloDetail } from './socket-host.ts'
import { createTui, TRACE_KIND_COLORS } from './tui.ts'

/** How the attach loop ended. */
export type AttachResult = {
  /** The engine's self-minted instance id, learned from the connection hello. */
  instanceId?: string
  reason: 'stdin-ended' | 'socket-closed'
}

/**
 * Run the TUI as a client of the running instance over its unix socket — the
 * one client path for both an attaching process and the started instance's own
 * TUI (no in-process fast path: every client is a client).
 *
 * @remarks
 * Ingress: each prompt line resolves to a `tui_command` event sent as a
 * JSON-RPC `trigger` request; the engine's guard threads validate it. Egress:
 * `trace` notifications render (kind-colored) lines; `ui_*` selections render
 * when the interface pack lands — today the TUI renders trace/log lines only.
 *
 * @public
 */
export const attachTui = async ({
  socketPath,
  input = process.stdin,
  write = (text: string): void => {
    process.stdout.write(text)
  },
  onAttach,
}: {
  socketPath: string
  input?: NodeJS.ReadableStream
  write?: (text: string) => void
  /** Called once, with the instance id from the connection hello. */
  onAttach?: (instanceId: string) => void
}): Promise<AttachResult> => {
  const tui = createTui({ input, write })
  const socket = new WebSocket(`ws+unix://${socketPath}`)
  let instanceId: string | undefined
  let nextId = 1

  const result = await new Promise<AttachResult>((resolve) => {
    let settled = false
    const finish = (reason: AttachResult['reason']): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // Never opened — nothing to close.
      }
      resolve({ reason, instanceId })
    }
    socket.addEventListener('open', () => {
      // The ingress loop starts only when the carrier is open.
      void (async () => {
        for (;;) {
          const event = await tui.prompt('behavioral> ')
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'trigger', params: { event } }))
        }
      })().catch(() => finish('stdin-ended'))
    })
    socket.addEventListener('message', (ev) => {
      let frame: { method?: string; params?: unknown }
      try {
        frame = JSON.parse(String(ev.data))
      } catch {
        return
      }
      // The hello is the ONE home for the id handshake: the host sends it on
      // connect, before any trace traffic, so even a fresh idle instance
      // identifies itself immediately. Validated at the trust boundary.
      if (frame.method === 'hello') {
        if (validateHelloDetail(frame.params)) {
          const { instanceId: id } = frame.params as { instanceId: string }
          instanceId = id
          onAttach?.(instanceId)
        }
        return
      }
      if (frame.method !== 'trace') return
      const trace = frame.params as Trace
      // MINIMAL: trace lines render as compact JSON; richer rendering rides
      // the ui_* producers slice (upgrade path: a per-kind line formatter).
      tui.emit(JSON.stringify(trace), TRACE_KIND_COLORS[trace.kind])
    })
    socket.addEventListener('close', () => finish('socket-closed'))
    socket.addEventListener('error', () => finish('socket-closed'))
  })

  tui.close()
  return result
}

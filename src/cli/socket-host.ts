import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { behavioralHome } from '../faculties/behavioral-home.ts'
import type { JsonRpcMessage } from './json-rpc.ts'
import { dispatchToRuntime, type HostRuntime, wireRuntimeEgress } from './serve.ts'

/**
 * The instance socket — `<home>/instance.sock`, the attach lane.
 *
 * @remarks
 * The host's single listener: a `Bun.serve` bound to this unix path speaks the
 * same line-framed JSON-RPC vocabulary as the stdio lane (one WebSocket text
 * message = one JSON-RPC frame), so an attacher is just another client of the
 * controller contract. The same server later serves the controller GUI over
 * HTTP on the same listener (Carriers/H). Written at start, removed on close —
 * the same lifecycle as the instance pidfile.
 *
 * @public
 */
export const instanceSocketPath = (home: string): string => join(home, 'instance.sock')

/**
 * The running socket host — `close()` stops the server and removes the socket
 * file (the terminate-path cleanup).
 *
 * @public
 */
export type SocketHost = {
  path: string
  close: () => Promise<void>
}

/**
 * Start the attach lane: a unix-socket `Bun.serve` over the shared host
 * dispatcher, with redacted traces and `ui_*` selections fanning out to every
 * connected client.
 *
 * @remarks
 * Unlike {@link createHost}, this does NOT call `runtime.start()` — the
 * foreground entry composes the runtime, the socket host, and its clients,
 * then starts the composition itself.
 *
 * @public
 */
export const createSocketHost = ({
  runtime,
  home = behavioralHome(),
}: {
  runtime: HostRuntime
  home?: string
}): SocketHost => {
  const path = instanceSocketPath(home)
  // A socket file left by a dead instance cannot be bound again — remove it.
  rmSync(path, { force: true })

  const clients = new Set<ServerWebSocket<unknown>>()
  const frame = (method: string, params: unknown): string => JSON.stringify({ jsonrpc: '2.0', method, params })

  const server = Bun.serve({
    unix: path,
    // MINIMAL: ws idleTimeout max is 255s; long-lived attaches get the ceiling
    // until a heartbeat/reconnect story is needed.
    websocket: {
      idleTimeout: 255,
      open: (ws) => {
        clients.add(ws)
      },
      message: (ws, message) => {
        const line = typeof message === 'string' ? message : new TextDecoder().decode(message)
        let parsed: JsonRpcMessage
        try {
          const value: unknown = JSON.parse(line)
          if (typeof value !== 'object' || value === null || typeof (value as JsonRpcMessage).method !== 'string') {
            throw new Error('not a JSON-RPC message')
          }
          parsed = value as JsonRpcMessage
        } catch {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
          return
        }
        if (parsed.id === undefined) {
          // A notification has no response channel; a handler failure must not
          // reject the event loop and kill the host.
          try {
            void dispatchToRuntime(runtime, parsed)
          } catch (error) {
            process.stderr.write(
              `instance socket notification '${parsed.method}' failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          }
          return
        }
        try {
          const result = dispatchToRuntime(runtime, parsed)
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
        } catch (error) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            }),
          )
        }
      },
      close: (ws) => {
        clients.delete(ws)
      },
    },
    fetch: (_req, server) =>
      // Later slices serve the controller GUI here (Carriers/H); today the
      // unix carrier is WebSocket-only.
      server.upgrade(_req)
        ? undefined
        : new Response('behavioral instance socket — a WebSocket upgrade is required\n', { status: 426 }),
  })

  // Egress: one redaction pass, the JSONL log, then fan out to every client.
  wireRuntimeEgress({
    runtime,
    home,
    emit: (method, params) => {
      for (const ws of clients) ws.send(frame(method, params))
    },
  })

  return {
    path,
    close: async () => {
      await server.stop(true)
      rmSync(path, { force: true })
    },
  }
}

/**
 * JSON-RPC 2.0 line codec for the harness IPC server.
 *
 * @remarks
 * One JSON-RPC message per line. The peer (the client that spawns the harness)
 * sends requests (`id` present → a response is written) and notifications
 * (`id` absent → fire-and-forget); the harness pushes notifications back via
 * {@link JsonRpcServer.notify}. The codec is carrier-thin: it reads a
 * `ReadableStream` and writes framed lines, so the stdin/stdout wiring lives at
 * the host and tests drive it with in-memory streams.
 *
 * @packageDocumentation
 */

/** A JSON-RPC 2.0 id. */
export type JsonRpcId = string | number

/** An inbound JSON-RPC message handed to the host. */
export type JsonRpcMessage = {
  method: string
  params: unknown
  /** Present for requests (a response is written); absent for notifications. */
  id?: JsonRpcId
}

/** The running codec's host-facing surface. */
export type JsonRpcServer = {
  /** Push a notification (no `id`) to the peer. */
  notify: (method: string, params?: unknown) => void
  /** Stop reading the input stream. */
  stop: () => void
  /** Resolves when the input stream ends. */
  done: Promise<void>
}

/**
 * Create the line codec over `input`, writing framed responses/notifications via
 * `write` and dispatching each parsed message to `onMessage`.
 *
 * @public
 */
export const createJsonRpcServer = ({
  input,
  write,
  onMessage,
}: {
  input: ReadableStream<Uint8Array>
  write: (line: string) => void
  onMessage: (message: JsonRpcMessage) => unknown | Promise<unknown>
}): JsonRpcServer => {
  const decoder = new TextDecoder()
  const reader = input.getReader()
  let carry = ''

  const writeError = (id: JsonRpcId | null, code: number, message: string): void => {
    write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
  }

  const handleLine = async (line: string): Promise<void> => {
    let message: { method?: string; params?: unknown; id?: JsonRpcId }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      writeError(null, -32700, 'Parse error')
      return
    }
    const method = message.method ?? ''
    if (message.id === undefined) {
      // A notification has no response channel, so a handler failure can
      // only be logged — never fatal: one bad notification must not reject
      // the read loop and kill the host.
      try {
        await onMessage({ method, params: message.params })
      } catch (error) {
        process.stderr.write(
          `json-rpc notification '${method}' failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
      return
    }
    try {
      const result = await onMessage({ method, params: message.params, id: message.id })
      write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    } catch (error) {
      writeError(message.id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      carry += decoder.decode(value, { stream: true })
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        await handleLine(trimmed)
      }
    }
  })()

  return {
    notify: (method, params) => write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    stop: () => {
      void reader.cancel()
    },
    done,
  }
}

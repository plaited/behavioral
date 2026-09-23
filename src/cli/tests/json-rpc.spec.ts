import { describe, expect, test } from 'bun:test'
import { createJsonRpcServer, type JsonRpcMessage } from '../json-rpc.ts'

const start = (input: string, onMessage: (message: JsonRpcMessage) => unknown | Promise<unknown>) => {
  const out: string[] = []
  const server = createJsonRpcServer({
    input: new Response(input).body as ReadableStream<Uint8Array>,
    write: (line) => out.push(line),
    onMessage,
  })
  return { out, server }
}

const run = async (input: string, onMessage: (message: JsonRpcMessage) => unknown | Promise<unknown>) => {
  const { out, server } = start(input, onMessage)
  await server.done
  return out
}

describe('createJsonRpcServer', () => {
  test('dispatches a notification and writes no response', async () => {
    const seen: JsonRpcMessage[] = []
    const out = await run('{"jsonrpc":"2.0","method":"ui_event","params":{"a":1}}\n', (message) => {
      seen.push(message)
      return undefined
    })
    expect(seen).toEqual([{ method: 'ui_event', params: { a: 1 } }])
    expect(out).toEqual([])
  })

  test('dispatches a request and answers with the same id', async () => {
    const out = await run('{"jsonrpc":"2.0","id":7,"method":"trigger","params":{"x":1}}\n', () => ({ ok: true }))
    expect(JSON.parse(out[0] as string)).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  })

  test('a handler failure answers with an error carrying the id', async () => {
    const out = await run('{"jsonrpc":"2.0","id":"e1","method":"boom"}\n', () => {
      throw new Error('kaboom')
    })
    expect(JSON.parse(out[0] as string)).toEqual({
      jsonrpc: '2.0',
      id: 'e1',
      error: { code: -32603, message: 'kaboom' },
    })
  })

  // The review's follow-up 1: a throwing NOTIFICATION must not kill the
  // codec — there is no response channel for it (no id), so the error goes
  // to stderr and the loop keeps dispatching what follows.
  test('a throwing notification is survived — the loop keeps dispatching', async () => {
    const seen: string[] = []
    const errors: string[] = []
    const stderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      errors.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const out = await run(
        `${['{"jsonrpc":"2.0","method":"bogus","params":{}}', '{"jsonrpc":"2.0","id":"after","method":"trigger","params":{}}'].join('\n')}\n`,
        (message) => {
          seen.push(message.method)
          if (message.id === undefined) throw new Error('notification blew up')
          return { ok: true }
        },
      )
      expect(seen).toEqual(['bogus', 'trigger'])
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('notification blew up')
      expect(JSON.parse(out[0] as string)).toEqual({ jsonrpc: '2.0', id: 'after', result: { ok: true } })
    } finally {
      process.stderr.write = stderrWrite
    }
  })

  test('malformed json answers with a parse error and a null id', async () => {
    const out = await run('not json\n', () => undefined)
    expect(JSON.parse(out[0] as string)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })
  })

  test('notify writes a framed notification', async () => {
    const { out, server } = start('', () => undefined)
    await server.done
    server.notify('trace', { kind: 'idle' })
    expect(JSON.parse(out[0] as string)).toEqual({ jsonrpc: '2.0', method: 'trace', params: { kind: 'idle' } })
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../../faculties.constants.ts'
import { spawnFaculty } from '../../tests/faculty-harness.ts'

/**
 * RPC op specs — exercised through the REAL faculty process boundary
 * speaking the behavioral event wire against a real local JSON-RPC HTTP
 * server: `shell_request` (`op: 'rpc'`) in, one `shell_request_result` out.
 *
 * @packageDocumentation
 */

type WireResult = {
  id: string
  ok: boolean
  result?: { output?: JsonObject; durationMs?: number }
  error?: { code?: string; message?: string; remoteCode?: number | string }
  space?: string
}

/** One JSON-RPC endpoint on a random localhost port; records requests. */
const rpcServer = (handler?: (body: Record<string, unknown>) => Response | Promise<Response>) => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      requests.push({ url: request.url, body, headers })
      if (handler !== undefined) return handler(body)
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { echo: body } })
    },
  })
  return {
    url: `http://localhost:${server.port}/mcp`,
    requests,
    close: () => server.stop(true),
  }
}

/** The faculty harness bound to the shell wire. */
const spawnShellWorker = () =>
  spawnFaculty({
    file: 'shell/faculty.ts',
    requestType: FACULTY_MESSAGE_KINDS.shell_request,
    resultType: FACULTY_MESSAGE_KINDS.shell_request_result,
  })

const servers: Array<ReturnType<typeof rpcServer>> = []
const workers: Array<ReturnType<typeof spawnShellWorker>> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const worker of workers.splice(0)) worker.terminate()
})

const wire = (raw: Awaited<ReturnType<ReturnType<typeof spawnShellWorker>['resultFor']>>): WireResult =>
  raw.detail as WireResult

describe('shell rpc op', () => {
  test('dispatches a generic remote JSON-RPC call and returns the output', async () => {
    const server = rpcServer()
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc1', input: { op: 'rpc', url: server.url, method: 'tools/list', params: { page: 2 } } })
    const raw = await worker.resultFor('rpc1')
    const result = wire(raw)
    expect(result.ok).toBe(true)
    const output = result.result?.output as { echo?: { method?: string } }
    expect(output.echo?.method).toBe('tools/list')
    // The generic envelope — no MCP framing.
    const body = server.requests[0]?.body as Record<string, unknown>
    expect(body.method).toBe('tools/list')
    expect(body.jsonrpc).toBe('2.0')
  })

  test('a remote JSON-RPC error payload is error data, not a throw', async () => {
    const server = rpcServer((body) =>
      Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }),
    )
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc2', input: { op: 'rpc', url: server.url, method: 'nope/x' } })
    const raw = await worker.resultFor('rpc2')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.message).toBe('nope')
    expect(result.error?.remoteCode).toBe(-32601)
  })

  test('an HTTP non-OK response is error data', async () => {
    const server = rpcServer(() => new Response('down', { status: 503 }))
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc3', input: { op: 'rpc', url: server.url, method: 'ping' } })
    const raw = await worker.resultFor('rpc3')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.remoteCode).toBe(503)
  })

  test('shell_cancel aborts the in-flight fetch — the result is canceled data', async () => {
    let seen = 0
    const server = rpcServer(async () => {
      seen += 1
      await Bun.sleep(5_000)
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
    })
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc4', input: { op: 'rpc', url: server.url, method: 'slow/x' } })
    await Bun.sleep(100)
    expect(seen).toBe(1)
    worker.post({ type: FACULTY_MESSAGE_KINDS.shell_cancel, detail: { id: 'rpc4' } })
    const raw = await worker.resultFor('rpc4')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('canceled')
  })

  test('the deadline terminates a hung call — the result is timeout data', async () => {
    const server = rpcServer(async () => {
      await Bun.sleep(5_000)
      return Response.json({ jsonrpc: '2.0', id: 1, result: {} })
    })
    servers.push(server)
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc5', input: { op: 'rpc', url: server.url, method: 'slow/x', timeoutMs: 200 } })
    const raw = await worker.resultFor('rpc5')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('timeout')
  })

  test('input that fails the rpc boundary is error data with the id intact', async () => {
    const worker = spawnShellWorker()
    workers.push(worker)
    worker.call({ id: 'rpc6', input: { op: 'rpc', method: 'ping' } })
    const raw = await worker.resultFor('rpc6')
    const result = wire(raw)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('error')
    expect(result.error?.message).toContain('invalid input')
  })
})

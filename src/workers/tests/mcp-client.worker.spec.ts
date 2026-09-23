import { describe, expect, test } from 'bun:test'
import type { JsonObject } from '../../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../workers.constants.ts'
import { spawnFamily } from './family-harness.ts'
import { startMcpServer } from './mcp-server-fixture.ts'

/**
 * MCP client worker integration tests — exercised through the real worker
 * boundary speaking the behavioral event wire: `mcp_request` events in
 * (dispatched by `detail.op`), one `mcp_request_result` out, `mcp_cancel`
 * for in-flight aborts.
 *
 * @remarks
 * The worker is spawned by URL (never imported for logic) and talks to a
 * REAL loopback MCP server: the fixture's in-process handler wrapped in
 * `Bun.serve`, so every call crosses a genuine HTTP round-trip — the
 * worker's global fetch is its own, so no fetch-swapping seam applies.
 *
 * Auth is fail-closed by construction: the worker's module-scope binding
 * reads broker env-data (absent in tests) and falls back to the keychain
 * floor (empty in tests) — unauthenticated calls against 401 servers must
 * surface the typed `authorization_required` status, never a throw.
 *
 * @packageDocumentation
 */

type WireResult = {
  id: string
  ok: boolean
  result?: Record<string, unknown>
  error?: Record<string, unknown>
  space?: string
}

/** Spawn the mcp family PROCESS and expose the same wire harness API. */
const spawnMcpWorker = () => {
  const worker = spawnFamily({
    file: 'mcp-client.worker.ts',
    requestType: WORKER_MESSAGE_KINDS.mcp_request,
    resultType: WORKER_MESSAGE_KINDS.mcp_request_result,
  })
  const call = (id: string, op: string, input: unknown, space?: string): void => {
    worker.call({ id, op, input } as JsonObject, space)
  }
  const cancel = (id: string): void => {
    worker.post({ type: WORKER_MESSAGE_KINDS.mcp_cancel, detail: { id } } as never)
  }
  const resultFor = async (id: string): Promise<WireResult> => {
    const raw = await worker.resultFor(id)
    return { ...raw.detail, id: raw.id, space: raw.space } as WireResult
  }
  return { call, cancel, resultFor, terminate: (): void => worker.terminate() }
}

/** Wrap the fixture handler in a real loopback HTTP server. */
const startLoopbackServer = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const { fetch, close } = await startMcpServer()
  const server = Bun.serve({ port: 0, fetch: (req) => fetch(req.url, req) })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    close: async () => {
      server.stop(true)
      await close()
    },
  }
}

describe('mcp client worker — event wire', () => {
  test('a call-tool request round-trips against a real MCP server', async () => {
    const mcp = spawnMcpWorker()
    const server = await startLoopbackServer()
    try {
      mcp.call('c1', 'call-tool', { url: server.url, tool: 'echo', args: { message: 'hi' } })
      const { id, ok, result } = await mcp.resultFor('c1')
      expect(id).toBe('c1')
      expect(ok).toBe(true)
      const output = result?.output as { content: Array<{ text: string }> }
      expect(output.content[0]?.text).toBe('echo:hi')
    } finally {
      await server.close()
      mcp.terminate()
    }
  })

  test('input that fails the op schema is error data, not silence', async () => {
    const mcp = spawnMcpWorker()
    try {
      // call-tool requires `tool` + `args` — this input has neither
      mcp.call('c2', 'call-tool', { url: 'http://127.0.0.1:1/mcp' })
      const { ok, error } = await mcp.resultFor('c2')
      expect(ok).toBe(false)
      expect(String(error?.message).includes('invalid input')).toBe(true)
      expect(error && 'output' in (error as Record<string, unknown>)).toBe(false)
    } finally {
      mcp.terminate()
    }
  })

  test('a 401 server surfaces typed authorization_required and echoes the request', async () => {
    const mcp = spawnMcpWorker()
    const denied = Bun.serve({
      port: 0,
      fetch: () => new Response('unauthorized', { status: 401 }),
    })
    try {
      mcp.call('c3', 'list-tools', { url: `http://127.0.0.1:${denied.port}/mcp` })
      const { ok, error } = await mcp.resultFor('c3')
      expect(ok).toBe(false)
      expect(error?.code).toBe('authorization_required')
      // the request echo is the replay spine's capture payload
      const request = error?.request as { op: string; input: Record<string, unknown> }
      expect(request.op).toBe('list-tools')
      expect(String(request.input.url)).toBe(`http://127.0.0.1:${denied.port}/mcp`)
    } finally {
      denied.stop(true)
      mcp.terminate()
    }
  })

  test('a cancel stops an in-flight call and reports canceled', async () => {
    const mcp = spawnMcpWorker()
    const hanging = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(5_000)
        return new Response('{}')
      },
    })
    try {
      mcp.call('c4', 'list-tools', { url: `http://127.0.0.1:${hanging.port}/mcp` })
      Bun.sleep(150).then(() => mcp.cancel('c4'))
      const { ok, error } = await mcp.resultFor('c4')
      expect(ok).toBe(false)
      expect(error?.code).toBe('canceled')
    } finally {
      hanging.stop(true)
      mcp.terminate()
    }
  })

  test('a deadline breach reports timeout — the second stop door', async () => {
    const mcp = spawnMcpWorker()
    const hanging = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(5_000)
        return new Response('{}')
      },
    })
    try {
      mcp.call('c5', 'list-tools', { url: `http://127.0.0.1:${hanging.port}/mcp`, timeoutMs: 150 })
      const { ok, error } = await mcp.resultFor('c5')
      expect(ok).toBe(false)
      expect(error?.code).toBe('timeout')
    } finally {
      hanging.stop(true)
      mcp.terminate()
    }
  })

  test('the request space is echoed on the result', async () => {
    const mcp = spawnMcpWorker()
    const server = await startLoopbackServer()
    try {
      mcp.call('c6', 'list-tools', { url: server.url }, 'demo')
      const { space, ok } = await mcp.resultFor('c6')
      expect(ok).toBe(true)
      expect(space).toBe('demo')
    } finally {
      await server.close()
      mcp.terminate()
    }
  })
})

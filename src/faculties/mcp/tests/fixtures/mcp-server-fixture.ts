import type { FetchLike } from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'

/**
 * Create the test MCP server — registers the echo tool, greet prompt, and
 * note resource used by the mcp-client test suite.
 */
const createTestServer = (): McpServer => {
  const server = new McpServer({ name: 'behavioral-test-server', version: '0.0.0' })

  server.registerTool(
    'echo',
    {
      description: 'Echo back the message argument as text.',
      inputSchema: z.object({ message: z.string().optional() }),
    },
    async (args: { message?: string }) => ({
      content: [{ type: 'text', text: `echo:${args.message ?? ''}` }],
    }),
  )

  server.registerPrompt(
    'greet',
    {
      description: 'A greeting prompt.',
      argsSchema: z.object({ name: z.string().optional() }),
    },
    async (args: { name?: string }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `hello ${args.name ?? 'world'}` } }],
    }),
  )

  server.registerResource(
    'note',
    'test://note',
    { description: 'A short note resource.', mimeType: 'text/plain' },
    async () => ({
      contents: [{ uri: 'test://note', mimeType: 'text/plain', text: 'a note' }],
    }),
  )

  return server
}

/**
 * Spin an in-process MCP server (no port, no socket) and return a fetch
 * function + close hook. Backs MCP client tool tests with a real SDK server
 * + real handler.fetch transport rather than a loopback HTTP server.
 *
 * The returned `url` is a synthetic identifier for pool keying — the
 * `fetch` function routes requests directly through the handler without
 * touching the network.
 */
export const startMcpServer = async (): Promise<{
  url: string
  fetch: FetchLike
  close: () => Promise<void>
}> => {
  const handler = createMcpHandler(() => createTestServer())

  return {
    url: `in-process://mcp-${crypto.randomUUID()}`,
    fetch: (input: string | URL, init?: RequestInit) => handler.fetch(new Request(input, init)),
    close: async () => {
      try {
        await handler.close()
      } catch {
        /* best-effort */
      }
    },
  }
}

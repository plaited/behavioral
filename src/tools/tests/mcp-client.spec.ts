import { describe, expect, test } from 'bun:test'
import type { FetchLike } from '@modelcontextprotocol/client'
import { ajv } from '../define-tool.ts'
import {
  McpCallToolInputSchema,
  McpCallToolOutputSchema,
  McpDiscoverInputSchema,
  McpDiscoverOutputSchema,
  McpGetPromptInputSchema,
  McpGetPromptOutputSchema,
  McpListPromptsInputSchema,
  McpListPromptsOutputSchema,
  McpListResourcesInputSchema,
  McpListResourcesOutputSchema,
  McpListToolsInputSchema,
  McpListToolsOutputSchema,
  McpReadResourceInputSchema,
  McpReadResourceOutputSchema,
  mcpCallTool as mcpCallToolBinder,
  mcpDiscover as mcpDiscoverBinder,
  mcpGetPrompt as mcpGetPromptBinder,
  mcpListPrompts as mcpListPromptsBinder,
  mcpListResources as mcpListResourcesBinder,
  mcpListTools as mcpListToolsBinder,
  mcpReadResource as mcpReadResourceBinder,
} from '../mcp-client.ts'

// Defined once, bound late — the test context carries no capabilities.
const mcpCallTool = mcpCallToolBinder(undefined)
const mcpListTools = mcpListToolsBinder(undefined)
const mcpListPrompts = mcpListPromptsBinder(undefined)
const mcpGetPrompt = mcpGetPromptBinder(undefined)
const mcpListResources = mcpListResourcesBinder(undefined)
const mcpReadResource = mcpReadResourceBinder(undefined)
const mcpDiscover = mcpDiscoverBinder(undefined)

import { startMcpServer } from './mcp-server-fixture.ts'

const validateCallToolInput = ajv.compile(McpCallToolInputSchema)
const validateCallToolOutput = ajv.compile(McpCallToolOutputSchema)
const validateListToolsInput = ajv.compile(McpListToolsInputSchema)
const validateListToolsOutput = ajv.compile(McpListToolsOutputSchema)
const validateListPromptsInput = ajv.compile(McpListPromptsInputSchema)
const validateListPromptsOutput = ajv.compile(McpListPromptsOutputSchema)
const validateGetPromptInput = ajv.compile(McpGetPromptInputSchema)
const validateGetPromptOutput = ajv.compile(McpGetPromptOutputSchema)
const validateListResourcesInput = ajv.compile(McpListResourcesInputSchema)
const validateListResourcesOutput = ajv.compile(McpListResourcesOutputSchema)
const validateReadResourceInput = ajv.compile(McpReadResourceInputSchema)
const validateReadResourceOutput = ajv.compile(McpReadResourceOutputSchema)
const validateDiscoverInput = ajv.compile(McpDiscoverInputSchema)
const validateDiscoverOutput = ajv.compile(McpDiscoverOutputSchema)

/**
 * Run `fn` with `globalThis.fetch` routed through the in-process MCP handler,
 * then restore it. The tools are flat and standalone (no injected client), so
 * the SDK's `handler.fetch` test pattern attaches at the ambient fetch
 * boundary — the same transport default the SDK docs use.
 */
const withFetch = async <T>(fetchImpl: FetchLike, fn: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl as unknown as typeof globalThis.fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

describe('mcp-client tools — schema contract (RED)', () => {
  test('each tool names itself distinctly', () => {
    expect(mcpCallTool.name).toBe('mcp-call-tool')
    expect(mcpListTools.name).toBe('mcp-list-tools')
    expect(mcpListPrompts.name).toBe('mcp-list-prompts')
    expect(mcpGetPrompt.name).toBe('mcp-get-prompt')
    expect(mcpListResources.name).toBe('mcp-list-resources')
    expect(mcpReadResource.name).toBe('mcp-read-resource')
    expect(mcpDiscover.name).toBe('mcp-discover')
  })

  test('call-tool requires url, tool, and args', () => {
    expect(validateCallToolInput({ url: 'http://x', tool: 't' })).toBe(false)
    expect(validateCallToolInput({ url: 'http://x', args: {} })).toBe(false)
    expect(validateCallToolInput({ url: 'http://x', tool: 't', args: {} })).toBe(true)
  })

  test('the listing tools require url and reject mode-specific stray fields', () => {
    expect(validateListToolsInput({})).toBe(false)
    expect(validateListToolsInput({ url: 'http://x' })).toBe(true)
    expect(validateListToolsInput({ url: 'http://x', mode: 'list-tools' })).toBe(false)
    expect(validateListPromptsInput({ url: 'http://x' })).toBe(true)
    expect(validateListResourcesInput({ url: 'http://x' })).toBe(true)
    expect(validateDiscoverInput({ url: 'http://x' })).toBe(true)
  })

  test('get-prompt requires url and name; args is optional', () => {
    expect(validateGetPromptInput({ url: 'http://x' })).toBe(false)
    expect(validateGetPromptInput({ url: 'http://x', name: 'p' })).toBe(true)
    expect(validateGetPromptInput({ url: 'http://x', name: 'p', args: { name: 'sam' } })).toBe(true)
  })

  test('read-resource requires url and uri', () => {
    expect(validateReadResourceInput({ url: 'http://x' })).toBe(false)
    expect(validateReadResourceInput({ url: 'http://x', uri: 'test://note' })).toBe(true)
  })

  test('accepts optional shared fields on any tool', () => {
    expect(
      validateListToolsInput({
        url: 'http://x',
        headers: { 'x-trace': '1' },
        timeoutMs: 5000,
        auth: { type: 'none' },
      }),
    ).toBe(true)
  })
})

describe('mcp-client tools — one round-trip per tool (in-process handler.fetch)', () => {
  test('round-trips all seven tools against a real in-process MCP server', async () => {
    const { url, fetch, close } = await startMcpServer()
    try {
      await withFetch(fetch as FetchLike, async () => {
        // mcp-list-tools
        const listed = (await mcpListTools({ url })) as { tools: { name: string }[] }
        expect(validateListToolsOutput(listed)).toBe(true)
        expect(listed.tools.map((t) => t.name)).toContain('echo')

        // mcp-call-tool
        const called = (await mcpCallTool({ url, tool: 'echo', args: { message: 'hi' } })) as {
          content: { type: string; text?: string }[]
        }
        expect(validateCallToolOutput(called)).toBe(true)
        expect(called.content[0]?.text).toBe('echo:hi')

        // mcp-list-prompts
        const prompts = (await mcpListPrompts({ url })) as { prompts: { name: string }[] }
        expect(validateListPromptsOutput(prompts)).toBe(true)
        expect(prompts.prompts.map((p) => p.name)).toContain('greet')

        // mcp-get-prompt
        const prompt = (await mcpGetPrompt({ url, name: 'greet', args: { name: 'sam' } })) as {
          messages: { role: string; content: { text?: string } }[]
        }
        expect(validateGetPromptOutput(prompt)).toBe(true)
        expect(prompt.messages[0]?.content.text).toBe('hello sam')

        // mcp-list-resources
        const resources = (await mcpListResources({ url })) as { resources: { uri: string }[] }
        expect(validateListResourcesOutput(resources)).toBe(true)
        expect(resources.resources.map((r) => r.uri)).toContain('test://note')

        // mcp-read-resource
        const read = (await mcpReadResource({ url, uri: 'test://note' })) as { contents: { text?: string }[] }
        expect(validateReadResourceOutput(read)).toBe(true)
        expect(read.contents[0]?.text).toBe('a note')

        // mcp-discover
        const discovered = (await mcpDiscover({ url })) as {
          tools: unknown[]
          prompts: unknown[]
          resources: unknown[]
        }
        expect(validateDiscoverOutput(discovered)).toBe(true)
        expect(discovered.tools).toHaveLength(1)
        expect(discovered.prompts).toHaveLength(1)
        expect(discovered.resources).toHaveLength(1)
      })
    } finally {
      await close()
    }
  })
})

describe('mcp-client tools — per-call connection lifecycle (no pool)', () => {
  test('each call opens and closes its own session — no reuse', async () => {
    const { url, fetch, close } = await startMcpServer()
    let initializes = 0
    const countingFetch: FetchLike = (input, init) => {
      if (typeof init?.body === 'string') {
        try {
          if ((JSON.parse(init.body) as { method?: unknown }).method === 'initialize') initializes += 1
        } catch {
          /* non-JSON body — not an initialize frame */
        }
      }
      return fetch(input, init)
    }
    try {
      await withFetch(countingFetch, async () => {
        await mcpListTools({ url })
        expect(initializes).toBe(1)
        await mcpListTools({ url })
        expect(initializes).toBe(2)
      })
    } finally {
      await close()
    }
  })
})

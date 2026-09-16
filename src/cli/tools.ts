/**
 * The fleet dispatcher — `behavioral tools '<json>'` invokes any tool in
 * `src/tools/` by name.
 *
 * @remarks
 * The agent-facing tool surface as a single CLI command: the input envelope
 * is `{ "tool": "<name>", "input": { ...tool input } }`. Dispatch validates
 * `input` against the named tool's input schema (with declared defaults
 * applied) and the result against its output schema, using the shared tools
 * AJV. The command-level output schema is the structural floor
 * `{ type: 'object' }`; strict per-tool validation happens at dispatch.
 *
 * Discovery: bare `--schema` prints the fleet index (name + description per
 * tool); `--schema <input|output> --tool <name>` resolves that tool's schema;
 * `--schema input` without `--tool` prints the dispatch envelope.
 *
 * @internal
 */

import type { JSONSchemaType, ValidateFunction } from 'ajv'
import {
  discoveryCreate,
  discoveryDelete,
  discoveryRead,
  discoverySearch,
  discoveryUpdate,
} from '../tools/discovery.ts'
import { frontierExplore, frontierReplay, frontierVerify } from '../tools/frontier.ts'
import { gitContext } from '../tools/git-context.ts'
import {
  htmlRender,
  htmlScaleCheck,
  htmlUpdateAttributes,
  htmlValidateAndEscape,
  htmlValidateAttributeValue,
} from '../tools/html.ts'
import {
  mcpCallTool,
  mcpDiscover,
  mcpGetPrompt,
  mcpListPrompts,
  mcpListResources,
  mcpListTools,
  mcpReadResource,
} from '../tools/mcp-client.ts'
import { pluginLoader } from '../tools/plugin-loader.ts'
import { skillDiscover, skillListResources, skillRead } from '../tools/skill-client.ts'
import { typescriptLsp } from '../tools/typescript-lsp.ts'
import { ajv } from '../tools/use-tool.ts'
import { makeCli } from './cli.ts'

// ---------------------------------------------------------------------------
// Fleet registry
// ---------------------------------------------------------------------------

/** A `useTool` product — heterogeneous across the fleet, so typed per-entry. */
type ToolProduct<TInput, TOutput> = {
  (input: TInput): Promise<TOutput> | TOutput
  name: string
  description: string
  inputSchema: JSONSchemaType<TInput>
  outputSchema: JSONSchemaType<TOutput>
}

type FleetEntry = {
  name: string
  description: string
  inputSchema: object
  outputSchema: object
  run: (input: unknown) => Promise<unknown> | unknown
}

const entry = <TInput, TOutput>(tool: ToolProduct<TInput, TOutput>): FleetEntry => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  outputSchema: tool.outputSchema,
  // Registry boundary: the dispatcher AJV-validates `input` against this
  // tool's compiled inputSchema (defaults applied) before the call.
  run: (input) => tool(input as TInput),
})

const FLEET: FleetEntry[] = [
  entry(discoveryCreate),
  entry(discoveryRead),
  entry(discoveryUpdate),
  entry(discoveryDelete),
  entry(discoverySearch),
  entry(frontierReplay),
  entry(frontierExplore),
  entry(frontierVerify),
  entry(htmlValidateAndEscape),
  entry(htmlValidateAttributeValue),
  entry(htmlRender),
  entry(htmlUpdateAttributes),
  entry(htmlScaleCheck),
  entry(mcpCallTool),
  entry(mcpListTools),
  entry(mcpListPrompts),
  entry(mcpGetPrompt),
  entry(mcpListResources),
  entry(mcpReadResource),
  entry(mcpDiscover),
  entry(pluginLoader),
  entry(skillDiscover),
  entry(skillRead),
  entry(skillListResources),
  entry(gitContext),
  entry(typescriptLsp),
]

const registry = new Map(FLEET.map((tool) => [tool.name, tool]))

// ---------------------------------------------------------------------------
// Per-tool validator cache (lazy compile)
// ---------------------------------------------------------------------------

const compiled = new Map<string, { input: ValidateFunction; output: ValidateFunction }>()

const validatorsFor = (tool: string): { input: ValidateFunction; output: ValidateFunction } => {
  let validators = compiled.get(tool)
  if (!validators) {
    const toolEntry = registry.get(tool)
    // Unreachable via the CLI: the envelope enum derives from this registry.
    if (!toolEntry) throw new Error(`Unknown tool: ${tool}`)
    validators = {
      input: ajv.compile(toolEntry.inputSchema),
      output: ajv.compile(toolEntry.outputSchema),
    }
    compiled.set(tool, validators)
  }
  return validators
}

// ---------------------------------------------------------------------------
// Dispatch envelope
// ---------------------------------------------------------------------------

type ToolsCliInput = {
  tool: string
  input: Record<string, unknown>
}

const ToolsCliInputSchema = {
  type: 'object',
  properties: {
    tool: {
      type: 'string',
      enum: FLEET.map((tool) => tool.name),
      description: 'fleet tool name — behavioral tools --schema lists every name',
    },
    input: {
      type: 'object',
      description: 'the named tool input — validated against that tool input schema',
    },
  },
  required: ['tool', 'input'],
  additionalProperties: false,
} as unknown as JSONSchemaType<ToolsCliInput>

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const help = [
  'Invoke any fleet tool by name: behavioral tools \'{"tool":"<name>","input":{...}}\'.',
  'Dispatch validates input and output against the named tool schemas.',
  '',
  'Discover tools:',
  '  behavioral tools --schema                      # fleet index: names + descriptions',
  '  behavioral tools --schema input --tool <name>   # that tool input schema',
  '  behavioral tools --schema output --tool <name>  # that tool output schema',
  '',
  'Tools:',
  ...FLEET.map(({ name, description }) => `  ${name}  ${description}`),
].join('\n')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const toolsCli = makeCli({
  name: 'tools',
  inputSchema: ToolsCliInputSchema,
  // Structural floor: strict per-tool validation happens at dispatch.
  outputSchema: { type: 'object' } as unknown as JSONSchemaType<unknown>,
  help,
  toolSchemas: {
    index: () => ({
      command: 'tools',
      usage: `behavioral tools '{"tool":"<name>","input":{...}}'`,
      tools: FLEET.map(({ name, description }) => ({ name, description })),
    }),
    resolve: (target, tool) => {
      const toolEntry = registry.get(tool)
      if (!toolEntry) return undefined
      return target === 'input' ? toolEntry.inputSchema : toolEntry.outputSchema
    },
  },
  run: async ({ tool, input }) => {
    const { input: validateInput, output: validateOutput } = validatorsFor(tool)
    if (!validateInput(input)) {
      console.error(JSON.stringify(validateInput.errors, null, 2))
      process.exit(2)
    }

    const result = await registry.get(tool)?.run(input)

    if (!validateOutput(result)) {
      console.error(JSON.stringify(validateOutput.errors, null, 2))
      process.exit(1)
    }

    return result
  },
})

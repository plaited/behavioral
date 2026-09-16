/**
 * Dispatch bridge — the kernel-side action channel that maps a model
 * `function_call` item to a tool invocation and back to a spec-valid
 * `function_call_output` item.
 *
 * @remarks
 * Per plan.md (Decision 2024-09-03): `useTrace` async callback is the action
 * channel; this module is the pure dispatch half the kernel wires into that
 * listener. It owns a name → tool registry (provisioner-injected, like the
 * connection pool) and `dispatch({ name, arguments, call_id })` looks the tool
 * up, JSON-parses the arguments, calls the tool, and returns a
 * `function_call_output` correlated by `call_id` with a fresh `id` via
 * {@link ueid}. Errors never throw into the space: an unknown tool, malformed
 * arguments, a tool `isError` result, or an unexpected exception all become a
 * `failed` output item whose `output` carries the error as data. A successful
 * call becomes a `completed` output item whose `output` is the JSON-stringified
 * result.
 *
 * @packageDocumentation
 */

import { ueid } from '../utils.ts'
import type { FunctionCallOutputItem } from '../workers/open-responses.schemas.ts'

/** A tool the bridge can dispatch to: callable + its registered name. */
export type DispatchableTool = ((input: unknown) => Promise<unknown> | unknown) & {
  name: string
}

/** A function_call item projected to the fields the bridge needs. */
export type DispatchCall = {
  name: string
  arguments: string
  call_id: string
}

/** The dispatch bridge surface owned by the kernel. */
export type DispatchBridge = {
  /** Dispatch one function_call → one spec-valid function_call_output. */
  dispatch: (call: DispatchCall) => Promise<FunctionCallOutputItem>
  /** Whether a tool is registered under `name`. */
  has: (name: string) => boolean
}

const fcoFailed = (call_id: string, payload: Record<string, unknown>): FunctionCallOutputItem => ({
  id: ueid('fco_'),
  type: 'function_call_output',
  status: 'failed',
  call_id,
  output: JSON.stringify(payload),
})

const fcoCompleted = (call_id: string, output: string): FunctionCallOutputItem => ({
  id: ueid('fco_'),
  type: 'function_call_output',
  status: 'completed',
  call_id,
  output,
})

const isToolError = (result: unknown): result is { isError: true; message: string } =>
  result !== null &&
  typeof result === 'object' &&
  (result as { isError?: unknown }).isError === true &&
  typeof (result as { message?: unknown }).message === 'string'

/**
 * Build a dispatch bridge over a name → tool registry. `tools` may be a record
 * keyed by name or an iterable of callables (keyed by each tool's `.name`).
 * Root gets the built-in set; spaces get subsets (provisioner-injected).
 */
export const createDispatchBridge = ({
  tools,
}: {
  tools: Record<string, DispatchableTool> | Iterable<DispatchableTool>
}): DispatchBridge => {
  const registry = new Map<string, DispatchableTool>()
  if (Array.isArray(tools)) {
    for (const tool of tools) registry.set(tool.name, tool)
  } else if (Symbol.iterator in tools) {
    for (const tool of tools) registry.set(tool.name, tool)
  } else {
    for (const [name, tool] of Object.entries(tools)) registry.set(name, tool)
  }
  const has = (name: string): boolean => registry.has(name)
  const dispatch = async (call: DispatchCall): Promise<FunctionCallOutputItem> => {
    const tool = registry.get(call.name)
    if (!tool) return fcoFailed(call.call_id, { error: 'unknown_tool', name: call.name })
    let parsed: unknown
    try {
      parsed = JSON.parse(call.arguments)
    } catch {
      return fcoFailed(call.call_id, { error: 'invalid_arguments', name: call.name, arguments: call.arguments })
    }
    try {
      const result = await tool(parsed)
      if (isToolError(result)) {
        return fcoFailed(call.call_id, { error: 'tool_error', name: call.name, message: result.message })
      }
      return fcoCompleted(call.call_id, typeof result === 'string' ? result : JSON.stringify(result))
    } catch (err) {
      return fcoFailed(call.call_id, {
        error: 'tool_threw',
        name: call.name,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { dispatch, has }
}

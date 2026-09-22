import type { JSONSchemaType, ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020'

export const ajv = new Ajv2020({ strict: true, validateSchema: true, strictRequired: false })

/**
 * A `defineTool` product — heterogeneous across the fleet, so typed per-entry.
 * The bound executable the fleet dispatches.
 */
export type Tool = {
  (input: unknown): Promise<unknown> | unknown
  name: string
  description: string
  inputSchema: object
  outputSchema: object
}

/**
 * The definition-time product: schemas compiled once, capabilities deferred.
 * The composition root binds per host — one definition, N bindings.
 */
export type ToolBinder<Ctx = unknown> = (ctx: Ctx) => Tool

export type DefineTool = <TInput, TOutput, Ctx = unknown>(
  args: {
    name: string
    description: string
    inputSchema: JSONSchemaType<TInput>
    outputSchema: JSONSchemaType<TOutput>
  },
  callback: (
    input: TInput,
    validate: {
      input: ValidateFunction<TInput>
      output: ValidateFunction<TOutput>
    },
    ctx: Ctx,
  ) => Promise<TOutput> | TOutput,
) => ToolBinder<Ctx>

/**
 * Define a fleet tool: schemas compile at definition; the returned binder
 * receives the host capability context at the composition root and yields the
 * executable. `ctx` reaches the callback as its third argument — capabilities
 * bind in-process, never through the JSON wire.
 */
export const defineTool: DefineTool = ({ name, description, inputSchema, outputSchema }, cb) => {
  const validate = {
    input: ajv.compile(inputSchema),
    output: ajv.compile(outputSchema),
  }
  return (ctx) => {
    const toRet = (input: unknown) => cb(input as never, validate as never, ctx)
    Object.defineProperty(toRet, 'name', { value: name, configurable: true })
    toRet.description = description
    toRet.inputSchema = inputSchema
    toRet.outputSchema = outputSchema
    return toRet as unknown as Tool
  }
}

import type { JSONSchemaType, ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020'

export const ajv = new Ajv2020({ strict: true, validateSchema: true, strictRequired: false })

export type DefineTool = <TInput, TOutput>(
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
  ) => Promise<TOutput> | TOutput,
) => {
  (input: TInput): Promise<TOutput> | TOutput
  name: string
  description: string
  inputSchema: JSONSchemaType<TInput>
  outputSchema: JSONSchemaType<TOutput>
}

export const defineTool: DefineTool = ({ name, description, inputSchema, outputSchema }, cb) => {
  const validate = {
    input: ajv.compile(inputSchema),
    output: ajv.compile(outputSchema),
  }
  const toRet = (input: Parameters<typeof cb>[0]) => cb(input, validate)
  Object.defineProperty(toRet, 'name', { value: name, configurable: true })
  toRet.description = description
  toRet.inputSchema = inputSchema
  toRet.outputSchema = outputSchema
  return toRet
}

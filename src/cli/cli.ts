/**
 * Shared CLI utilities for simple JSON-in / JSON-out commands.
 *
 * @remarks
 * Supports a stringified JSON positional input or stdin plus:
 * `--schema <input|output>`, `--dry-run`, and `--help`.
 *
 * @packageDocumentation
 */

import { resolve } from 'node:path'
import type { JSONSchemaType, ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020'

/**
 * AJV instance for CLI validation — `useDefaults: true` applies JSON Schema
 * `default` values so optional fields with defaults behave like Zod's
 * `.default(...)`. Otherwise identical to the shared tools AJV.
 */
const cliAjv = new Ajv2020({ strict: true, validateSchema: true, strictRequired: false, useDefaults: true })

/**
 * Parsed CLI flags shared by JSON-in / JSON-out commands.
 *
 * @property dryRun - When true, print the resolved request instead of executing it.
 *
 * @public
 */
export type CliFlags = {
  dryRun: boolean
}

/**
 * Options used when parsing a JSON-backed CLI request.
 *
 * @property name - Command name rendered in generated usage output.
 * @property outputSchema - Output schema used for `--schema output` and result validation.
 * @property help - Help text appended to the usage block.
 * @property toolSchemas - Optional per-tool schema resolution for fleet commands.
 * When present, bare `--schema` prints the tool index and
 * `--schema <input|output> --tool <name>` resolves that tool's schema.
 *
 * @public
 */

export type CliOptions = {
  name: string
  outputSchema: object
  help: string
  toolSchemas?: CliToolSchemas
}

/**
 * Per-tool schema resolution for a fleet command.
 *
 * @property index - Tool index printed for bare `--schema` (name + description per tool).
 * @property resolve - Resolves a named tool's input/output schema; `undefined` marks an unknown tool.
 *
 * @public
 */
export type CliToolSchemas = {
  index: () => object
  resolve: (target: 'input' | 'output', tool: string) => object | undefined
}

/**
 * Parsed CLI request data returned by `parseCliRequest`.
 *
 * @template T - Input type validated by the JSON Schema.
 * @property input - Parsed input payload.
 * @property flags - Parsed CLI flags.
 *
 * @public
 */
export type ParsedCliRequest<T> = {
  input: T
  flags: CliFlags
}

type CliHandlerConfig<TInput, TOutput, TName extends string = string> = {
  name: TName
  inputSchema: JSONSchemaType<TInput>
  outputSchema: JSONSchemaType<TOutput>
  help: string
  toolSchemas?: CliToolSchemas
  run: (input: TInput, flags: CliFlags) => Promise<TOutput> | TOutput
}

type CliRouterConfig = {
  name: string
  description: string
  commands: Record<string, (args: string[]) => Promise<void>>
}

const buildUsage = ({ name, help }: { name: string; help: string }): string =>
  [
    `Usage: ${name} '<json>' [options]`,
    `       echo '<json>' | ${name}`,
    '',
    'Options:',
    '  --schema <input|output>  Output JSON schema and exit',
    '  --dry-run                Show request details without running the command',
    '  -h, --help               Show help',
    '',
    help,
  ].join('\n')

const getSchemaTarget = (args: string[], hasToolSchemas: boolean): 'input' | 'output' | 'index' | null => {
  const schemaIndex = args.indexOf('--schema')
  if (schemaIndex === -1) return null

  const target = args[schemaIndex + 1]
  if (target === 'input' || target === 'output') return target

  // A fleet command with toolSchemas treats any bare `--schema` as a request
  // for the tool index.
  if (hasToolSchemas) return 'index'

  console.error("Invalid value for --schema. Expected 'input' or 'output'.")
  process.exit(2)
}

const getToolFlag = (args: string[]): string | undefined => {
  const toolIndex = args.indexOf('--tool')
  if (toolIndex === -1) return undefined

  const tool = args[toolIndex + 1]
  if (!tool || tool.startsWith('--')) {
    console.error('Invalid value for --tool. Expected: --tool <name>')
    process.exit(2)
  }
  return tool
}

const getPositionalInput = async (args: string[]): Promise<string | undefined> => {
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--schema') {
      index += 1
      continue
    }
    if (arg === '--dry-run' || arg === '--help' || arg === '-h') {
      continue
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg)
    }
  }

  if (positionals.length > 0) return positionals[0]?.trim()

  if (!process.stdin.isTTY) {
    const stdinData = (await Bun.stdin.text()).trim()
    if (stdinData) return stdinData
  }

  return undefined
}

const parseJsonInput = (rawInput: string): unknown => {
  try {
    return JSON.parse(rawInput)
  } catch {
    console.error('Invalid JSON input')
    process.exit(2)
  }
}

const printSchema = (schema: unknown): void => {
  console.log(JSON.stringify(schema, null, 2))
}

/**
 * Parses and validates a JSON CLI request with shared flag handling.
 *
 * @template T - Input type validated by the JSON Schema.
 * @param args - Raw command-line arguments after the command name.
 * @param schema - JSON Schema used to validate the input payload.
 * @param options - Command metadata used for usage text and output validation.
 * @returns Parsed request input plus shared CLI flags.
 *
 * @public
 */
export const parseCliRequest = async <T>(
  args: string[],
  schema: JSONSchemaType<T>,
  options: CliOptions,
): Promise<ParsedCliRequest<T>> => {
  if (args.includes('--help') || args.includes('-h')) {
    console.error(buildUsage(options))
    process.exit(0)
  }

  const toolFlag = getToolFlag(args)
  const schemaTarget = getSchemaTarget(args, Boolean(options.toolSchemas))
  if (schemaTarget === 'index') {
    printSchema(options.toolSchemas?.index() ?? {})
    process.exit(0)
  }
  if (schemaTarget) {
    if (toolFlag !== undefined && !options.toolSchemas) {
      console.error(`--tool is not supported by command '${options.name}'.`)
      process.exit(2)
    }
    if (toolFlag !== undefined) {
      const toolSchema = options.toolSchemas?.resolve(schemaTarget, toolFlag)
      if (!toolSchema) {
        console.error(`Unknown tool: ${toolFlag}`)
        process.exit(2)
      }
      printSchema(toolSchema)
      process.exit(0)
    }
    if (schemaTarget === 'input') {
      printSchema(schema)
      process.exit(0)
    }
    printSchema(options.outputSchema)
    process.exit(0)
  }
  if (toolFlag !== undefined) {
    console.error('--tool requires --schema <input|output>.')
    process.exit(2)
  }

  const rawInput = await getPositionalInput(args)
  if (!rawInput) {
    console.error(buildUsage(options))
    process.exit(2)
  }

  const validate = cliAjv.compile(schema) as ValidateFunction<T>
  const data = parseJsonInput(rawInput)
  if (!validate(data)) {
    console.error(JSON.stringify(validate.errors, null, 2))
    process.exit(2)
  }

  return {
    input: data,
    flags: {
      dryRun: args.includes('--dry-run'),
    },
  }
}

/**
 * Parses and validates a JSON CLI request, returning only the input payload.
 *
 * @template T - Input type validated by the JSON Schema.
 * @param args - Raw command-line arguments after the command name.
 * @param schema - JSON Schema used to validate the input payload.
 * @param options - Command metadata used for usage text and output validation.
 * @returns Parsed CLI input.
 *
 * @public
 */
export const parseCli = async <T>(args: string[], schema: JSONSchemaType<T>, options: CliOptions): Promise<T> => {
  const { input } = await parseCliRequest(args, schema, options)
  return input
}

/**
 * Creates a JSON-in / JSON-out CLI handler with shared parsing and validation.
 *
 * @template TInput - Input type for the command.
 * @template TOutput - Output type produced by the command handler.
 * @template TName - Command name string literal.
 * @param config - Command metadata, validation schemas, and execution callback.
 * @returns CLI handler that parses input, validates output, and prints JSON.
 *
 * @public
 */
export const makeCli = <TInput, TOutput, TName extends string>({
  name,
  inputSchema,
  outputSchema,
  help,
  toolSchemas,
  run,
}: CliHandlerConfig<TInput, TOutput, TName>): { [K in TName]: (args: string[]) => Promise<void> } =>
  ({
    [name]: async (args: string[]): Promise<void> => {
      const { input, flags } = await parseCliRequest(args, inputSchema, {
        name,
        outputSchema,
        help,
        toolSchemas,
      })

      if (flags.dryRun) {
        console.log(
          JSON.stringify(
            {
              command: name,
              input,
              dryRun: true,
            },
            null,
            2,
          ),
        )
        return
      }

      const result = (await run(input, flags)) as TOutput

      const validateOutput = cliAjv.compile(outputSchema) as ValidateFunction<TOutput>
      if (!validateOutput(result)) {
        console.error(JSON.stringify(validateOutput.errors, null, 2))
        process.exit(1)
      }

      console.log(JSON.stringify(result, null, 2))
    },
  }) as { [K in TName]: (args: string[]) => Promise<void> }

/**
 * Define and execute a self-contained CLI script.
 *
 * @remarks
 * Intended for generated `.ts` scripts invoked directly via `bun <filepath> '<json>'`.
 * Parses `process.argv`, handles `--help`, `--dry-run`, `--schema`, and runs the handler.
 * Uses the script filename as the display name in usage text.
 *
 * @template TInput - Input type for the script.
 * @template TOutput - Output type produced by the script handler.
 * @param config - Input schema, output schema, help text, and run handler.
 *
 * @public
 */
export const defineScript = async <TInput, TOutput>({
  inputSchema,
  outputSchema,
  help,
  run,
}: Omit<CliHandlerConfig<TInput, TOutput>, 'name'>): Promise<void> => {
  const scriptName = process.argv[1]?.split('/').pop()?.split('.').shift() ?? 'script'
  const args = process.argv.slice(2)

  const { input, flags } = await parseCliRequest(args, inputSchema, {
    name: scriptName,
    outputSchema,
    help,
  })

  if (flags.dryRun) {
    console.log(
      JSON.stringify(
        {
          script: scriptName,
          input,
          dryRun: true,
        },
        null,
        2,
      ),
    )
    return
  }

  const result = (await run(input, flags)) as TOutput

  const validateOutput = cliAjv.compile(outputSchema) as ValidateFunction<TOutput>
  if (!validateOutput(result)) {
    console.error(JSON.stringify(validateOutput.errors, null, 2))
    process.exit(1)
  }

  console.log(JSON.stringify(result, null, 2))
}

export const makeCliRouter =
  ({ name, description, commands }: CliRouterConfig) =>
  async (argv: string[]): Promise<void> => {
    const command = argv[2]
    const args = argv.slice(3)
    const commandNames = Object.keys(commands).sort()

    // Handle --version / -v before command lookup.
    // Read package.json at runtime via Bun.file — stays in sync with npm
    // version bumps, including prerelease suffixes like -next.0.
    if (command === '--version' || command === '-v') {
      const pkgPath = resolve(import.meta.dir, '../../package.json')
      const pkg = Bun.file(pkgPath)
      if (await pkg.exists()) {
        const { version } = await pkg.json()
        console.log(version)
      } else {
        console.error('Could not read package.json for version')
        process.exit(1)
      }
      process.exit(0)
    }

    if (!command || command === '--help' || command === '-h') {
      console.error(`Usage: ${name} <command> [options]
       ${name} <command> --schema     # Discover input schema
       ${name} <command> '<json>'    # Structured JSON input
       ${name} --schema               # List all commands

Flags:
  --version, -v  Print version and exit
  --help, -h     Show this help message

Commands:
    ${commandNames.join(', ')}`)
      process.exit(command ? 0 : 1)
    }

    if (command === '--schema') {
      console.log(
        JSON.stringify(
          {
            name,
            description,
            commands: commandNames,
            usage: `${name} <command> '<json>' | --schema input`,
            discovery: `${name} --schema`,
          },
          null,
          2,
        ),
      )
      process.exit(0)
    }

    const handler = commands[command]
    if (!handler) {
      console.error(`Unknown command: ${command}`)
      console.error(`Run '${name} --help' to see available commands`)
      process.exit(1)
    }

    await handler(args).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
  }

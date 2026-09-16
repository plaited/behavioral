/**
 * The turn CLI seam — the default behavioral usage. `behavioral turn '<json>'`
 * runs one turn end-to-end and prints the {@link TurnResult} as JSON: JSON in,
 * JSON (with the trace stream) out.
 *
 * @remarks
 * The agent as a cold, composable command — one run per invocation: create a
 * kernel (scripted model by default — deterministic, no network), run the turn,
 * print the JSON result. The interactive mode is not built yet.
 *
 * The output schema is the kernel's {@link TurnResultSchema} — the single
 * JSON-schema home for the TurnResult shape. The CLI does not hand-mirror the
 * type; it imports the schema so a kernel type change and its schema stay in
 * sync.
 *
 * @internal
 */

import type { JSONSchemaType } from 'ajv'
import { TurnResultSchema } from '../kernel/kernel.schemas.ts'
import { createKernel, type TurnResult } from '../kernel/kernel.ts'
import { makeCli } from './cli.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TurnCliInput = {
  space: string
  prompt: string
}

// ---------------------------------------------------------------------------
// JSON Schemas (AJV — matching useTool's convention)
// ---------------------------------------------------------------------------

const TurnCliInputSchema = {
  type: 'object',
  properties: {
    space: { type: 'string', minLength: 1, description: 'space/scope label for the turn' },
    prompt: {
      type: 'string',
      minLength: 1,
      description: 'the user prompt to run the turn against',
    },
  },
  required: ['space', 'prompt'],
  additionalProperties: false,
  description: 'Turn CLI input — run one turn from a prompt to a JSON result',
} as unknown as JSONSchemaType<TurnCliInput>

export const turnCli = makeCli({
  name: 'turn',
  inputSchema: TurnCliInputSchema,
  // The output schema is the kernel's TurnResultSchema — the single schema
  // home for the TurnResult shape. No hand-mirrored copy here.
  outputSchema: TurnResultSchema.schema as unknown as JSONSchemaType<TurnResult>,
  help: [
    'Run one turn: JSON in, JSON out (the result plus the trace stream).',
    '',
    'The default behavioral usage — one cold run per invocation; no daemon, no serve mode.',
    'Deterministic against the kernel default scripted model (no network).',
    '',
    'Examples:',
    `  behavioral turn '{"space":"s","prompt":"Hello"}'`,
    `  echo '{"space":"s","prompt":"Hello"}' | behavioral turn`,
  ].join('\n'),
  run: async (input) => {
    const kernel = createKernel()
    return await kernel.runTurn({ space: input.space, prompt: input.prompt })
  },
})

/**
 * JSON Schema for {@link TurnResult} — the single schema home for the turn
 * result shape. The CLI's `turn` command imports this schema rather than
 * hand-mirroring the type, so a kernel type change and its schema stay in sync.
 *
 * @remarks
 * The `items` and `trace` arrays hold heterogeneous union members. AJV can't
 * statically verify a `JSONSchemaType` for a discriminated union of arbitrary
 * objects, so those element schemas use `additionalProperties: true` — the
 * permissive item precedent set by the CLI's original `items` schema. The
 * `as unknown as` cast in the schema literal names this gap explicitly.
 *
 * @packageDocumentation
 */

import { makeSchema, type SchemaValidator, UsageSchema } from '../workers/open-responses.schemas.ts'
import type { TurnResult } from './kernel.ts'

/**
 * The raw JSON Schema object for {@link TurnResult}. The single schema home —
 * downstream consumers (the CLI `turn` command) reference this object instead
 * of hand-mirroring the type.
 *
 * The `as unknown as` cast is required because AJV's `JSONSchemaType` can't
 * statically verify permissive `additionalProperties: true` item schemas
 * against the heterogeneous `Trace` union.
 */
const schema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true, description: 'the turn executed' },
    space: { type: 'string', description: 'the space the turn ran in' },
    status: {
      type: 'string',
      enum: ['completed', 'incomplete', 'failed'],
      description: 'turn outcome',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
      description: 'full trajectory — user prompt + model outputs + tool-call outputs',
    },
    iterations: {
      type: 'integer',
      minimum: 0,
      description: 'number of model-respond rounds',
    },
    usage: {
      ...UsageSchema.schema,
      nullable: true,
      description: 'token usage from the last round, when reported',
    },
    trace: {
      type: 'array',
      // Trace is a heterogeneous union; permissive items match the items precedent.
      items: {
        type: 'object',
        additionalProperties: true,
      },
      description: 'captured trace stream — every Trace message from the run (the exhaust)',
    },
  },
  required: ['ok', 'space', 'status', 'items', 'iterations', 'trace'],
  additionalProperties: false,
  description: 'Turn result — the outcome of one turn, shaped for machine consumption',
} as unknown as SchemaValidator<TurnResult>['schema']

/**
 * The {@link SchemaValidator} for {@link TurnResult}. Exported so downstream
 * consumers (the CLI `turn` command) reuse the single schema home instead of
 * hand-mirroring the type. Use `.schema` for embedding and `.validate` for
 * runtime validation.
 *
 * @public
 */
export const TurnResultSchema: SchemaValidator<TurnResult> = makeSchema<TurnResult>(schema)

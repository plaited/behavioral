import type { ErrorObject, ValidateFunction } from 'ajv'
import Ajv2020 from 'ajv/dist/2020'

// ================================================================
// Open Responses — Phase 0 subset schemas (AJV / JSON Schema)
//
// Source of truth: https://github.com/openresponses/openresponses
//   schema/components/schemas/*.json
//
// This subset covers tool-calling loop + reasoning as content parts.
// Out of scope: hosted tools, tool_choice, truncation, service_tier,
// image generation.
//
// Request schemas validate strictly; stream events tolerate unknown
// types. Schemas are plain JSON Schema (draft 2020-12) objects, compiled
// once by a shared Ajv2020 instance. Each exported `*Schema` is a
// {@link SchemaValidator} that bundles the raw JSON Schema (`.schema`,
// for embedding in other tool schemas), the compiled validator
// (`.validate`), and a Zod-compatible `.parse()` / `.safeParse()` API so
// existing call sites keep working after the Zod → AJV swap.
// ================================================================

// ----------------------------------------------------------------
// AJV engine + Zod-compatible parse wrapper
// ----------------------------------------------------------------

/**
 * Shared Ajv2020 (draft 2020-12) instance. `strict: false` accepts
 * discriminated `oneOf`/`anyOf` + `const`/`not` subschemas embedded in
 * composite schemas without complaining about non-root structure;
 * `validateSchema` rejects structurally broken schemas at compile time.
 * Mirrors the `html.schemas.ts` / `css.schemas.ts` ajv configuration.
 * @public
 */
export const ajv = new Ajv2020({ strict: false, validateSchema: true, allErrors: true })

/**
 * Validation error thrown by {@link SchemaValidator.parse} when AJV
 * rejects the data. Message is `ajv.errorsText(...)` — the AJV
 * keyword/instance-path summary.
 * @public
 */
export class ValidationError extends Error {
  constructor(errors: ErrorObject[] | null | undefined) {
    super(!errors || errors.length === 0 ? 'validation failed' : ajv.errorsText(errors))
    this.name = 'ValidationError'
  }
}

/**
 * A JSON Schema bound to a compiled AJV validator, exposed with a
 * Zod-compatible parse API so callers can swap `z.object(...).parse(x)`
 * for `XSchema.parse(x)` without touching the rest of their code.
 *
 * - `.schema` — the raw JSON Schema object (embeddable in other schemas).
 * - `.validate` — the compiled AJV {@link ValidateFunction}.
 * - `.parse(data)` — returns the typed data or throws {@link ValidationError}.
 * - `.safeParse(data)` — returns `{ success, data } | { success, error }`.
 *
 * AJV does not transform data, so `parse` returns the input value cast to
 * `T` (the schema is the source of truth for the shape; the cast is sound
 * because AJV has just verified the runtime structure).
 *
 * @public
 */
export type SchemaValidator<T> = {
  readonly schema: object
  readonly validate: ValidateFunction<unknown>
  parse(data: unknown): T
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: ValidationError }
}

/**
 * Compile a JSON Schema into a frozen {@link SchemaValidator}. The schema
 * object is kept (`.schema`) for embedding in other schemas; the compiled
 * AJV validator backs `.parse` / `.safeParse`.
 */
export const makeSchema = <T>(schema: object): SchemaValidator<T> => {
  const validate = ajv.compile(schema) as ValidateFunction<unknown>
  return Object.freeze({
    schema,
    validate,
    parse(data: unknown): T {
      if (validate(data)) return data as T
      throw new ValidationError(validate.errors)
    },
    safeParse(data: unknown): { success: true; data: T } | { success: false; error: ValidationError } {
      if (validate(data)) return { success: true, data: data as T }
      return { success: false, error: new ValidationError(validate.errors) }
    },
  })
}

// ----------------------------------------------------------------
// Shared enums
// ----------------------------------------------------------------

const messageRoleEnum = ['user', 'assistant', 'system'] as const
const itemStatusEnum = ['in_progress', 'completed', 'incomplete', 'failed'] as const
const truncationEnum = ['auto', 'disabled'] as const

/** @public */
export const MessageRoleSchema = makeSchema<MessageRole>({ type: 'string', enum: messageRoleEnum })
/** @public */
export type MessageRole = (typeof messageRoleEnum)[number]

/** @public */
export const ItemStatusSchema = makeSchema<ItemStatus>({ type: 'string', enum: itemStatusEnum })
/** @public */
export type ItemStatus = (typeof itemStatusEnum)[number]

/** @public */
export const TruncationSchema = makeSchema<Truncation>({ type: 'string', enum: truncationEnum })
/** @public */
export type Truncation = (typeof truncationEnum)[number]

// ----------------------------------------------------------------
// Content parts (message.content entries)
// ----------------------------------------------------------------

/** @public */
export const OutputTextContentSchema = makeSchema<OutputTextContent>({
  type: 'object',
  properties: {
    type: { const: 'output_text' },
    text: { type: 'string' },
    annotations: { type: 'array' },
  },
  required: ['type', 'text'],
  additionalProperties: true,
})
/** @public */
export type OutputTextContent = {
  type: 'output_text'
  text: string
  annotations?: unknown[]
}

/** @public */
export const ReasoningTextContentSchema = makeSchema<ReasoningTextContent>({
  type: 'object',
  properties: { type: { const: 'reasoning_text' }, text: { type: 'string' } },
  required: ['type', 'text'],
  additionalProperties: true,
})
/** @public */
export type ReasoningTextContent = {
  type: 'reasoning_text'
  text: string
}

const contentPartSchema = {
  oneOf: [OutputTextContentSchema.schema, ReasoningTextContentSchema.schema],
}
/** @public */
export const ContentPartSchema = makeSchema<ContentPart>(contentPartSchema)
/** @public */
export type ContentPart = OutputTextContent | ReasoningTextContent

// ----------------------------------------------------------------
// Items — output / response-field side (full shape)
// ----------------------------------------------------------------

/** @public */
export const MessageItemSchema = makeSchema<MessageItem>({
  type: 'object',
  properties: {
    type: { const: 'message' },
    id: { type: 'string' },
    status: { type: 'string', enum: itemStatusEnum },
    role: { type: 'string', enum: messageRoleEnum },
    content: { type: 'array', items: contentPartSchema },
  },
  required: ['id', 'type', 'status', 'role', 'content'],
  additionalProperties: true,
})
/** @public */
export type MessageItem = {
  id: string
  type: 'message'
  status: ItemStatus
  role: MessageRole
  content: ContentPart[]
}

/** @public */
export const ReasoningItemSchema = makeSchema<ReasoningItem>({
  type: 'object',
  properties: {
    type: { const: 'reasoning' },
    id: { type: 'string' },
    status: { type: 'string', enum: itemStatusEnum },
    content: { type: 'array', items: contentPartSchema },
  },
  required: ['id', 'type', 'status', 'content'],
  additionalProperties: true,
})
/** @public */
export type ReasoningItem = {
  id: string
  type: 'reasoning'
  status: ItemStatus
  content: ContentPart[]
  [key: string]: unknown
}

/** @public */
export const FunctionCallItemSchema = makeSchema<FunctionCallItem>({
  type: 'object',
  properties: {
    type: { const: 'function_call' },
    id: { type: 'string' },
    status: { type: 'string', enum: itemStatusEnum },
    call_id: { type: 'string' },
    name: { type: 'string' },
    arguments: { type: 'string' },
  },
  required: ['id', 'type', 'status', 'call_id', 'name', 'arguments'],
  additionalProperties: false,
})
/** @public */
export type FunctionCallItem = {
  id: string
  type: 'function_call'
  status: ItemStatus
  call_id: string
  name: string
  arguments: string
}

/** @public */
export const FunctionCallOutputItemSchema = makeSchema<FunctionCallOutputItem>({
  type: 'object',
  properties: {
    type: { const: 'function_call_output' },
    id: { type: 'string' },
    status: { type: 'string', enum: itemStatusEnum },
    call_id: { type: 'string' },
    output: { type: 'string' },
  },
  required: ['id', 'type', 'status', 'call_id', 'output'],
  additionalProperties: false,
})
/** @public */
export type FunctionCallOutputItem = {
  id: string
  type: 'function_call_output'
  status: ItemStatus
  call_id: string
  output: string
}

/** @public */
export const CompactionItemSchema = makeSchema<CompactionItem>({
  type: 'object',
  properties: {
    type: { const: 'compaction' },
    id: { type: 'string' },
    status: { type: 'string', enum: itemStatusEnum },
    encrypted_content: { type: 'string' },
  },
  required: ['id', 'type', 'status', 'encrypted_content'],
  additionalProperties: false,
})
/** @public */
export type CompactionItem = {
  id: string
  type: 'compaction'
  status: ItemStatus
  encrypted_content: string
}

const outputItemSchema = {
  oneOf: [
    MessageItemSchema.schema,
    ReasoningItemSchema.schema,
    FunctionCallItemSchema.schema,
    FunctionCallOutputItemSchema.schema,
    CompactionItemSchema.schema,
  ],
}
/** @public */
export const OutputItemSchema = makeSchema<OutputItem>(outputItemSchema)
/** @public */
export type OutputItem = MessageItem | ReasoningItem | FunctionCallItem | FunctionCallOutputItem | CompactionItem

// ----------------------------------------------------------------
// Input-side content parts (message.content entries for user messages)
// ----------------------------------------------------------------

/** @public */
export const InputTextContentSchema = makeSchema<InputTextContent>({
  type: 'object',
  properties: { type: { const: 'input_text' }, text: { type: 'string' } },
  required: ['type', 'text'],
  additionalProperties: false,
})
/** @public */
export type InputTextContent = {
  type: 'input_text'
  text: string
}

/** @public */
export const ImageContentSchema = makeSchema<ImageContent>({
  type: 'object',
  properties: {
    type: { const: 'image' },
    image_url: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        detail: { type: 'string', enum: ['auto', 'low', 'high'] },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  required: ['type', 'image_url'],
  additionalProperties: false,
})
/** @public */
export type ImageContent = {
  type: 'image'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}

/** @public */
export const AudioContentSchema = makeSchema<AudioContent>({
  type: 'object',
  properties: {
    type: { const: 'audio' },
    data: { type: 'string' },
    format: { type: 'string', enum: ['mp3', 'wav', 'ogg', 'flac', 'aac'] },
  },
  required: ['type', 'data'],
  additionalProperties: false,
})
/** @public */
export type AudioContent = {
  type: 'audio'
  data: string
  format?: 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac'
}

/** @public */
export const VideoContentSchema = makeSchema<VideoContent>({
  type: 'object',
  properties: {
    type: { const: 'video' },
    data: { type: 'string' },
    format: { type: 'string', enum: ['mp4', 'webm', 'avi', 'mov', 'quicktime'] },
  },
  required: ['type', 'data'],
  additionalProperties: false,
})
/** @public */
export type VideoContent = {
  type: 'video'
  data: string
  format?: 'mp4' | 'webm' | 'avi' | 'mov' | 'quicktime'
}

// Extended input content part union (for use in MessageItemParam.content)
const inputContentPartSchema = {
  oneOf: [
    InputTextContentSchema.schema,
    ImageContentSchema.schema,
    AudioContentSchema.schema,
    VideoContentSchema.schema,
  ],
}
/** @public */
export const InputContentPartSchema = makeSchema<InputContentPart>(inputContentPartSchema)
/** @public */
export type InputContentPart = InputTextContent | ImageContent | AudioContent | VideoContent

// ----------------------------------------------------------------
// Items — input / request-param side (some fields optional)
// ----------------------------------------------------------------

/** @public */
export const MessageItemParamSchema = makeSchema<MessageItemParam>({
  type: 'object',
  properties: {
    type: { const: 'message' },
    id: { type: 'string' },
    status: { type: 'string', enum: itemStatusEnum },
    role: { type: 'string', enum: messageRoleEnum },
    content: { anyOf: [{ type: 'string' }, { type: 'array', items: inputContentPartSchema }] },
  },
  required: ['type', 'role', 'content'],
  additionalProperties: false,
})
/** @public */
export type MessageItemParam = {
  id?: string
  type: 'message'
  status?: ItemStatus
  role: MessageRole
  content: string | InputContentPart[]
}

/** @public */
export const FunctionCallItemParamSchema = makeSchema<FunctionCallItemParam>({
  type: 'object',
  properties: {
    type: { const: 'function_call' },
    call_id: { type: 'string' },
    id: { type: 'string' },
    status: { type: 'string', enum: itemStatusEnum },
    name: { type: 'string' },
    arguments: { type: 'string' },
  },
  required: ['call_id', 'type', 'name', 'arguments'],
  additionalProperties: false,
})
/** @public */
export type FunctionCallItemParam = {
  call_id: string
  id?: string
  type: 'function_call'
  status?: ItemStatus
  name: string
  arguments: string
}

/** @public */
export const FunctionCallOutputItemParamSchema = makeSchema<FunctionCallOutputItemParam>({
  type: 'object',
  properties: {
    type: { const: 'function_call_output' },
    call_id: { type: 'string' },
    id: { type: 'string' },
    status: { type: 'string', enum: itemStatusEnum },
    output: { type: 'string' },
  },
  required: ['call_id', 'type', 'output'],
  additionalProperties: false,
})
/** @public */
export type FunctionCallOutputItemParam = {
  call_id: string
  id?: string
  type: 'function_call_output'
  status?: ItemStatus
  output: string
}

const inputItemSchema = {
  oneOf: [MessageItemParamSchema.schema, FunctionCallItemParamSchema.schema, FunctionCallOutputItemParamSchema.schema],
}
/** @public */
export const InputItemSchema = makeSchema<InputItem>(inputItemSchema)
/** @public */
export type InputItem = MessageItemParam | FunctionCallItemParam | FunctionCallOutputItemParam

// ----------------------------------------------------------------
// Tool definition (request-side)
// ----------------------------------------------------------------

/** @public */
export const FunctionToolSchema = makeSchema<FunctionTool>({
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    parameters: { type: 'object', additionalProperties: true },
  },
  required: ['name', 'parameters'],
  additionalProperties: false,
})
/** @public */
export type FunctionTool = {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

// ----------------------------------------------------------------
// Request
// ----------------------------------------------------------------

/** @public */
export const OpenResponsesRequestSchema = makeSchema<OpenResponsesRequest>({
  type: 'object',
  properties: {
    model: {
      type: 'object',
      properties: { provider: { type: 'string' }, modelId: { type: 'string' } },
      required: ['provider', 'modelId'],
      additionalProperties: false,
    },
    input: { type: 'array', items: inputItemSchema },
    tools: { type: 'array', items: FunctionToolSchema.schema },
    truncation: { type: 'string', enum: truncationEnum },
    instructions: { type: 'string' },
  },
  required: ['model', 'input'],
  additionalProperties: false,
})
/** @public */
export type OpenResponsesRequest = {
  model: { provider: string; modelId: string }
  input: InputItem[]
  tools?: FunctionTool[]
  truncation?: Truncation
  instructions?: string
}

// ----------------------------------------------------------------
// Usage (token counts on terminal events)
// ----------------------------------------------------------------

/** @public */
export const InputTokensDetailsSchema = makeSchema<InputTokensDetails>({
  type: 'object',
  properties: { cached_tokens: { type: 'integer', minimum: 0 } },
  additionalProperties: false,
})
/** @public */
export type InputTokensDetails = { cached_tokens?: number }

/** @public */
export const OutputTokensDetailsSchema = makeSchema<OutputTokensDetails>({
  type: 'object',
  properties: { reasoning_tokens: { type: 'integer', minimum: 0 } },
  additionalProperties: false,
})
/** @public */
export type OutputTokensDetails = { reasoning_tokens?: number }

/** @public */
export const UsageSchema = makeSchema<Usage>({
  type: 'object',
  properties: {
    input_tokens: { type: 'integer', minimum: 0 },
    output_tokens: { type: 'integer', minimum: 0 },
    total_tokens: { type: 'integer', minimum: 0 },
    input_tokens_details: InputTokensDetailsSchema.schema,
    output_tokens_details: OutputTokensDetailsSchema.schema,
  },
  required: ['input_tokens', 'output_tokens', 'total_tokens'],
  additionalProperties: false,
})
/** @public */
export type Usage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: InputTokensDetails
  output_tokens_details?: OutputTokensDetails
}

// ----------------------------------------------------------------
// Error (on response.failed)
// ----------------------------------------------------------------

/** @public */
export const ErrorSchema = makeSchema<Error>({
  type: 'object',
  properties: { code: { type: 'string' }, message: { type: 'string' } },
  required: ['code', 'message'],
  additionalProperties: false,
})
/** @public */
export type Error = {
  code: string
  message: string
}

// ----------------------------------------------------------------
// Stream events — discriminated union
// ----------------------------------------------------------------

/** @public */
export const ResponseOutputItemAddedEventSchema = makeSchema<ResponseOutputItemAddedEvent>({
  type: 'object',
  properties: {
    type: { const: 'response.output_item.added' },
    sequence_number: { type: 'integer', minimum: 0 },
    output_index: { type: 'integer', minimum: 0 },
    item: outputItemSchema,
  },
  required: ['type', 'item'],
  additionalProperties: false,
})
/** @public */
export type ResponseOutputItemAddedEvent = {
  type: 'response.output_item.added'
  sequence_number?: number
  output_index?: number
  item: OutputItem
}

/** @public */
export const ResponseOutputTextDeltaEventSchema = makeSchema<ResponseOutputTextDeltaEvent>({
  type: 'object',
  properties: {
    type: { const: 'response.output_text.delta' },
    sequence_number: { type: 'integer', minimum: 0 },
    item_id: { type: 'string' },
    output_index: { type: 'integer', minimum: 0 },
    content_index: { type: 'integer', minimum: 0 },
    delta: { type: 'string' },
  },
  required: ['type', 'item_id', 'output_index', 'content_index', 'delta'],
  additionalProperties: false,
})
/** @public */
export type ResponseOutputTextDeltaEvent = {
  type: 'response.output_text.delta'
  sequence_number?: number
  item_id: string
  output_index: number
  content_index: number
  delta: string
}

/** @public */
export const ResponseReasoningTextDeltaEventSchema = makeSchema<ResponseReasoningTextDeltaEvent>({
  type: 'object',
  properties: {
    type: { const: 'response.reasoning_text.delta' },
    sequence_number: { type: 'integer', minimum: 0 },
    item_id: { type: 'string' },
    output_index: { type: 'integer', minimum: 0 },
    content_index: { type: 'integer', minimum: 0 },
    delta: { type: 'string' },
  },
  required: ['type', 'item_id', 'output_index', 'content_index', 'delta'],
  additionalProperties: false,
})
/** @public */
export type ResponseReasoningTextDeltaEvent = {
  type: 'response.reasoning_text.delta'
  sequence_number?: number
  item_id: string
  output_index: number
  content_index: number
  delta: string
}

/** @public */
export const ResponseFunctionCallArgumentsDeltaEventSchema = makeSchema<ResponseFunctionCallArgumentsDeltaEvent>({
  type: 'object',
  properties: {
    type: { const: 'response.function_call_arguments.delta' },
    sequence_number: { type: 'integer', minimum: 0 },
    item_id: { type: 'string' },
    output_index: { type: 'integer', minimum: 0 },
    delta: { type: 'string' },
  },
  required: ['type', 'item_id', 'output_index', 'delta'],
  additionalProperties: false,
})
/** @public */
export type ResponseFunctionCallArgumentsDeltaEvent = {
  type: 'response.function_call_arguments.delta'
  sequence_number?: number
  item_id: string
  output_index: number
  delta: string
}

/** @public */
export const ResponseOutputItemDoneEventSchema = makeSchema<ResponseOutputItemDoneEvent>({
  type: 'object',
  properties: {
    type: { const: 'response.output_item.done' },
    sequence_number: { type: 'integer', minimum: 0 },
    output_index: { type: 'integer', minimum: 0 },
    item: outputItemSchema,
  },
  required: ['type', 'item'],
  additionalProperties: false,
})
/** @public */
export type ResponseOutputItemDoneEvent = {
  type: 'response.output_item.done'
  sequence_number?: number
  output_index?: number
  item: OutputItem
}

/** @public */
export const ResponseCompletedEventSchema = makeSchema<ResponseCompletedEvent>({
  type: 'object',
  properties: {
    type: { const: 'response.completed' },
    sequence_number: { type: 'integer', minimum: 0 },
    status: { const: 'completed' },
    usage: UsageSchema.schema,
  },
  required: ['type', 'status'],
  additionalProperties: false,
})
/** @public */
export type ResponseCompletedEvent = {
  type: 'response.completed'
  sequence_number?: number
  status: 'completed'
  usage?: Usage
}

/** @public */
export const ResponseFailedEventSchema = makeSchema<ResponseFailedEvent>({
  type: 'object',
  properties: {
    type: { const: 'response.failed' },
    sequence_number: { type: 'integer', minimum: 0 },
    status: { const: 'failed' },
    error: ErrorSchema.schema,
    usage: UsageSchema.schema,
  },
  required: ['type', 'status', 'error'],
  additionalProperties: false,
})
/** @public */
export type ResponseFailedEvent = {
  type: 'response.failed'
  sequence_number?: number
  status: 'failed'
  error: Error
  usage?: Usage
}

/** @public */
export const ResponseIncompleteEventSchema = makeSchema<ResponseIncompleteEvent>({
  type: 'object',
  properties: {
    type: { const: 'response.incomplete' },
    sequence_number: { type: 'integer', minimum: 0 },
    status: { const: 'incomplete' },
    usage: UsageSchema.schema,
  },
  required: ['type', 'status'],
  additionalProperties: false,
})
/** @public */
export type ResponseIncompleteEvent = {
  type: 'response.incomplete'
  sequence_number?: number
  status: 'incomplete'
  usage?: Usage
}

// ----------------------------------------------------------------
// Known stream event union (strict validation)
// ----------------------------------------------------------------

const knownEventSchemas = [
  ResponseOutputItemAddedEventSchema,
  ResponseOutputTextDeltaEventSchema,
  ResponseReasoningTextDeltaEventSchema,
  ResponseFunctionCallArgumentsDeltaEventSchema,
  ResponseOutputItemDoneEventSchema,
  ResponseCompletedEventSchema,
  ResponseFailedEventSchema,
  ResponseIncompleteEventSchema,
]
const knownStreamEventSchema = { oneOf: knownEventSchemas.map((s) => s.schema) }
/** @public */
export const KnownStreamEventSchema = makeSchema<KnownStreamEvent>(knownStreamEventSchema)
/** @public */
export type KnownStreamEvent =
  | ResponseOutputItemAddedEvent
  | ResponseOutputTextDeltaEvent
  | ResponseReasoningTextDeltaEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseOutputItemDoneEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ResponseIncompleteEvent

// ----------------------------------------------------------------
// Unknown event passthrough (provider extras, _-prefixed)
//
// Tolerates any object with a 'type' field NOT matching a known type.
// The `not: { enum }` on `type` closes the union fall-through the same
// way the Zod `.refine` did: a malformed known frame (e.g. a text delta
// missing `delta`) fails the strict known schema AND is rejected here
// (its `type` IS in the known set), so it throws instead of masquerading
// as an unknown provider extra.
//
// The known-type set is derived from {@link knownEventSchemas} by reading
// each branch's `type.const` — the discriminator strings stay in sync by
// construction, no hand-maintained duplicate.
// ----------------------------------------------------------------

const KNOWN_STREAM_EVENT_TYPES: readonly string[] = knownEventSchemas.map(
  (s) => (s.schema as { properties: { type: { const: string } } }).properties.type.const,
)

/** @public */
export const UnknownStreamEventSchema = makeSchema<UnknownStreamEvent>({
  type: 'object',
  properties: { type: { type: 'string', not: { enum: KNOWN_STREAM_EVENT_TYPES } } },
  required: ['type'],
  additionalProperties: true,
})
/** @public */
export type UnknownStreamEvent = {
  type: string
  [k: string]: unknown
}

// ----------------------------------------------------------------
// Lax stream parser — tolerates unknown types
// ----------------------------------------------------------------

/** @public */
export const StreamEventLaxSchema = makeSchema<OpenResponsesStreamEvent>({
  anyOf: [knownStreamEventSchema, UnknownStreamEventSchema.schema],
})
/** @public */
export type OpenResponsesStreamEvent = KnownStreamEvent | UnknownStreamEvent

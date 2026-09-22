/**
 * Types shared by the shell worker (`shell.worker.ts`) and its event-wire
 * consumers.
 *
 * @remarks
 * Types only — no runtime values, so importing this module has no side
 * effects on either side of the worker boundary. The worker mounts
 * `self.onmessage` at top level, so the host must never import it for
 * types; both sides import here instead. The wire itself is the behavioral
 * event vocabulary (`shell_request` / `shell_cancel` in, one
 * `shell_request_result` out) defined in `src/workers/workers.types.ts` —
 * only the `detail.input` and `detail.result` payload shapes live here.
 *
 * The input is OP-DISCRIMINATED (the bun-direct conversion): `'run'`
 * executes a TypeScript script bun-direct (`bun run -`, script on stdin —
 * the recipe flavor); `'shell'` executes a Bun Shell command string through
 * the worker's constant wrapper (command via env; payload via env or, over
 * the large-payload threshold, a temp file the worker deletes on every
 * exit). The two flavors share the bounded-execution knobs; per-call data
 * for `'run'` scripts rides `env` (`bun run -` consumes stdin as the
 * script).
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'

/** Output representation for a completed execution. */
export type ShellFormat = 'paged' | 'json' | 'raw'

/** Terminal state of one execution. */
export type ShellStatus = 'completed' | 'timeout' | 'line_quota' | 'canceled' | 'error'

/**
 * Per-execution options.
 *
 * @remarks
 * `format`/`offset`/`limit` are the model-facing subset; `cwd`/`env`/`stdin`
 * and the bound knobs (`timeoutMs`/`maxLines`/`maxCharacters`) are host-only.
 * Host over-ceiling values are clamped, not rejected, and the clamp is
 * reported in {@link ShellResult.clamped}.
 */
export type ShellOptions = {
  /** Working directory for the execution. Defaults to the worker's `cwd`. */
  cwd?: string
  /** Environment overrides merged over `process.env`. */
  env?: Record<string, string>
  /** Host-only payload written to the executed command's stdin (shell op only — channeled by the worker). */
  stdin?: string
  /** Output representation. @default 'paged' */
  format?: ShellFormat
  /** Lines to skip before capturing. @default 0 */
  offset?: number
  /** Maximum lines to capture into the result. @default 50 */
  limit?: number
  /** Wall-clock deadline; the worker group-kills on expiry. @default 30_000 */
  timeoutMs?: number
  /** Total stdout+stderr lines allowed before the worker group-kills. @default 250 */
  maxLines?: number
  /** Character bound for `raw`/`json`/`stderr` output. @default 8_000 */
  maxCharacters?: number
}

// ---------------------------------------------------------------------------
// Op inputs — one shape per op, no legacy `script`-string catch-all
// ---------------------------------------------------------------------------

/** The `'run'` op input — a TypeScript script executed bun-direct. */
export type ShellRunOpInput = {
  op: 'run'
  /** The script source; `bun run -` reads it from stdin. */
  script: string
  cwd?: string
  env?: Record<string, string>
  format?: ShellFormat
  offset?: number
  limit?: number
  timeoutMs?: number
  maxLines?: number
  maxCharacters?: number
}

/** The `'shell'` op input — a Bun Shell command string through the wrapper. */
export type ShellShellOpInput = {
  op: 'shell'
  /** The Bun Shell command (pipes, &&/||, $(…), redirects — bash-like dialect). */
  command: string
  /** Data for the command's stdin — env channel, or temp file over the size threshold. */
  stdin?: string
  cwd?: string
  env?: Record<string, string>
  format?: ShellFormat
  offset?: number
  limit?: number
  timeoutMs?: number
  maxLines?: number
  maxCharacters?: number
}

/** The `shell_request` event's `detail.input` — one discriminated shape per op. */
export type ShellCallInput = ShellRunOpInput | ShellShellOpInput

// ---------------------------------------------------------------------------
// Input boundary (shared knobs + per-op payloads; strict at every level)
// ---------------------------------------------------------------------------

const sharedKnobProperties = {
  cwd: { type: 'string', nullable: true },
  env: { type: 'object', required: [], additionalProperties: { type: 'string' }, nullable: true },
  format: { type: 'string', enum: ['paged', 'json', 'raw'], nullable: true },
  offset: { type: 'integer', minimum: 0, nullable: true },
  limit: { type: 'integer', minimum: 1, nullable: true },
  timeoutMs: { type: 'integer', minimum: 1, nullable: true },
  maxLines: { type: 'integer', minimum: 1, nullable: true },
  maxCharacters: { type: 'integer', minimum: 1, nullable: true },
} as const

export const ShellRunOpInputSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'run' },
    script: { type: 'string', minLength: 1 },
    ...sharedKnobProperties,
  },
  required: ['op', 'script'],
  additionalProperties: false,
} as unknown as JSONSchemaType<ShellRunOpInput>

export const ShellShellOpInputSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', const: 'shell' },
    command: { type: 'string', minLength: 1 },
    stdin: { type: 'string', nullable: true },
    ...sharedKnobProperties,
  },
  required: ['op', 'command'],
  additionalProperties: false,
} as unknown as JSONSchemaType<ShellShellOpInput>

/**
 * The op-discriminated input boundary — `anyOf` branches (strict AJV rejects
 * union `type` arrays), `additionalProperties: false` at every level so the
 * op shapes cannot bleed into each other.
 */
export const ShellCallInputSchema = {
  anyOf: [ShellRunOpInputSchema, ShellShellOpInputSchema],
} as unknown as JSONSchemaType<ShellCallInput>

// ---------------------------------------------------------------------------
// The result envelope
// ---------------------------------------------------------------------------

/** Result of one execution — the single terminal payload the worker returns. */
export type ShellResult = {
  /** Correlation id, echoed from the request. */
  id: string
  /** Outcome discriminator. */
  status: ShellStatus
  /** Exit code, or `null` when the process was killed by a signal. */
  exitCode: number | null
  /** Terminating signal (e.g. `SIGTERM`), or `null` on a normal exit. */
  signal: string | null
  /** Captured lines when `format` is `paged`. */
  lines?: string[]
  /** Stdout lines emitted, including those outside the window — the paging denominator. */
  totalLines: number
  /** Whether stdout has more lines beyond `offset + limit`. */
  hasMore: boolean
  /** Parsed stdout when `format` is `json`. */
  jsonData?: unknown
  /** Bounded stdout when `format` is `raw`. */
  stdout?: string
  /** Bounded, ANSI-stripped stderr. */
  stderr: string
  /** Elapsed wall-clock time in milliseconds. */
  durationMs: number
  /** Over-ceiling options that were clamped, as `'<knob> <given> -> <applied>'`. */
  clamped?: string[]
  /** Failure detail when `status` is `error`. */
  message?: string
}

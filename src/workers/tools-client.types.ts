/**
 * Types shared by the tools-client worker (`tools-client.worker.ts`) and its
 * event-wire consumers.
 *
 * @remarks
 * Types only — no runtime values, so importing this module has no side
 * effects on either side of the worker boundary. `tools-client.worker.ts`
 * mounts `self.onmessage` at top level, so the host must never import it for
 * types; both sides import here instead. The wire itself is the behavioral
 * event vocabulary (`tool_call` / `tool_cancel` in, one `tool_call_result`
 * out) defined in `src/behavioral/use-behavioral.types.ts` — only the
 * `detail.input` and `detail.result` payload shapes live here.
 *
 * @packageDocumentation
 */

/** Output representation for a completed execution. */
export type ToolsFormat = 'paged' | 'json' | 'raw'

/** Terminal state of one execution. */
export type ToolsStatus = 'completed' | 'timeout' | 'line_quota' | 'canceled' | 'error'

/**
 * Per-execution options.
 *
 * @remarks
 * `format`/`offset`/`limit` are the model-facing subset (§5); `cwd`/`env`/
 * `stdin` and the bound knobs (`timeoutMs`/`maxLines`/`maxCharacters`) are
 * host-only. Host over-ceiling values are clamped, not rejected, and the clamp
 * is reported in {@link ToolsResult.clamped}.
 */
export type ToolsOptions = {
  /** Working directory for the command. Defaults to the executor's `cwd`. */
  cwd?: string
  /** Environment overrides merged over `process.env`. */
  env?: Record<string, string>
  /** Host-only payload written to the command's stdin. */
  stdin?: string
  /** Output representation. @default 'paged' */
  format?: ToolsFormat
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

/** Result of one execution — the single terminal payload the worker returns. */
export type ToolsResult = {
  /** Correlation id, echoed from the request. */
  id: string
  /** Outcome discriminator. */
  status: ToolsStatus
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

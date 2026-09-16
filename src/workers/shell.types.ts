/**
 * Wire and option types shared by the shell worker (`shell.ts`) and its host
 * consumer (`use-shell.ts`).
 *
 * @remarks
 * Types only — no runtime values, so importing this module has no side effects
 * on either side of the worker boundary. `shell.ts` mounts `self.onmessage` at
 * top level, so the host must never import it for types; both sides import
 * here instead.
 *
 * The host sends {@link ShellRequest} / {@link ShellCancel} and receives
 * {@link ShellOutbound} — zero or more {@link ShellLineEvent}s followed by
 * exactly one {@link ShellResultEvent}. A single terminal event (rather than
 * separate complete/aborted/error events) keeps the host's correlation map to
 * one branch; {@link ShellResult.status} carries the outcome.
 *
 * @packageDocumentation
 */

/** Output representation for a completed execution. */
export type ShellFormat = 'paged' | 'json' | 'raw'

/** Stream a line arrived on. */
export type ShellStream = 'stdout' | 'stderr'

/** Terminal state of one execution. */
export type ShellStatus = 'completed' | 'timeout' | 'line_quota' | 'canceled' | 'error'

/**
 * Per-execution options.
 *
 * @remarks
 * `format`/`offset`/`limit` are the model-facing subset (§5); `cwd`/`env`/
 * `stdin` and the bound knobs (`timeoutMs`/`maxLines`/`maxCharacters`) are
 * host-only. Host over-ceiling values are clamped, not rejected, and the clamp
 * is reported in {@link ShellResult.clamped}.
 */
export type ShellOptions = {
  /** Working directory for the command. Defaults to the executor's `cwd`. */
  cwd?: string
  /** Environment overrides merged over `process.env`. */
  env?: Record<string, string>
  /** Host-only payload written to the command's stdin. */
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

/** Host → worker: run one script. */
export type ShellRequest = {
  type: 'EXECUTE'
  id: string
  script: string
  options: ShellOptions
}

/** Host → worker: stop one running execution. */
export type ShellCancel = {
  type: 'CANCEL'
  id: string
  reason?: string
}

/** Messages the worker accepts. */
export type ShellInbound = ShellRequest | ShellCancel

/** Worker → host: one streamed line, emitted as it arrives. */
export type ShellLineEvent = {
  type: 'LINE'
  id: string
  /** 1-based, monotonic across stdout and stderr — the supervisor feed, not a paging index. */
  lineNumber: number
  stream: ShellStream
  line: string
}

/** Worker → host: the one terminal event per execution. */
export type ShellResultEvent = {
  type: 'RESULT'
  id: string
  result: ShellResult
}

/** Messages the worker emits. */
export type ShellOutbound = ShellLineEvent | ShellResultEvent

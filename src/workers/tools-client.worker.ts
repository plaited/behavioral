/**
 * Tools-client worker — executes one script per `tool_call` event in a
 * cancellable `bash` subprocess and returns a single bounded terminal
 * `tool_call_result` event.
 *
 * @remarks
 * Spawned by URL (never imported) and speaks the behavioral event wire:
 * `tool_call` / `tool_cancel` in, `tool_call_result` out, with any request
 * `space` echoed on the result. `detail.input` is validated against the
 * input boundary below (§5 surface + host bounds); over-ceiling bounds are
 * clamped and the clamp is reported in `ToolsResult.clamped` — policy lives
 * with enforcement. Streamed lines are counted for quotas but not posted:
 * no consumer exists (MINIMAL: router-published delta trace when one does).
 *
 * MINIMAL: `Bun.spawn` + `bash -lc` is the launch path (the spec's `Bun.$.lines()`
 * cannot stream or be cancelled — it buffers to EOF and exposes no signal/kill).
 * Upgrade path for non-bash hosts is `Bun.which('bash') ?? Bun.which('sh')`.
 *
 * MINIMAL: control characters beyond ANSI (C0, interlinear annotations) are not
 * sanitized; JSON escaping keeps them harmless in model context. Upgrade path:
 * the prior bash tool's `sanitize()` filter, should output ever feed a terminal.
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import { ajv } from '../behavioral/behavioral.types.ts'
import type { ToolsFormat, ToolsOptions, ToolsResult, ToolsStatus } from './tools-client.types.ts'
import { WORKER_MESSAGE_KINDS } from './workers.constants.ts'
import { type ToolCallEvent, validateToolCallEvent, validateToolCancelEvent } from './workers.types.ts'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default lines captured into a `paged` result. */
const DEFAULT_LIMIT = 50

/** Default lines skipped before capturing. */
const DEFAULT_OFFSET = 0

/** Default character bound for `raw`, `json`, and `stderr` output. */
const DEFAULT_MAX_CHARACTERS = 8_000

/** Grace between the SIGTERM and SIGKILL halves of a group kill. */
const KILL_GRACE_MS = 500

/** Default wall-clock deadline for one execution. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default stdout+stderr lines allowed before a group kill. */
const DEFAULT_MAX_LINES = 250

// ---------------------------------------------------------------------------
// Input boundary (§5 surface + host bounds)
// ---------------------------------------------------------------------------

/** The `tool_call` event's `detail.input`. */
export type ToolsCallInput = {
  script: string
  format?: ToolsFormat
  offset?: number
  limit?: number
  timeoutMs?: number
  maxLines?: number
  maxCharacters?: number
  stdin?: string
  cwd?: string
  env?: Record<string, string>
}

export const ToolsCallInputSchema: JSONSchemaType<ToolsCallInput> = {
  type: 'object',
  properties: {
    script: { type: 'string', minLength: 1 },
    format: { type: 'string', enum: ['paged', 'json', 'raw'], nullable: true },
    offset: { type: 'integer', minimum: 0, nullable: true },
    limit: { type: 'integer', minimum: 1, nullable: true },
    timeoutMs: { type: 'integer', minimum: 1, nullable: true },
    maxLines: { type: 'integer', minimum: 1, nullable: true },
    maxCharacters: { type: 'integer', minimum: 1, nullable: true },
    stdin: { type: 'string', nullable: true },
    cwd: { type: 'string', nullable: true },
    env: { type: 'object', required: [], additionalProperties: { type: 'string' }, nullable: true },
  },
  required: ['script'],
  additionalProperties: false,
}

const validateToolsCallInput = ajv.compile(ToolsCallInputSchema)

/** Hard bounds a caller cannot exceed — clamping lives with enforcement. */
const CEILINGS = { timeoutMs: 120_000, maxLines: 5_000, maxCharacters: 200_000, limit: 1_000 } as const

const CLAMPED_KEYS = ['timeoutMs', 'maxLines', 'maxCharacters', 'limit'] as const

/** Clamp over-ceiling bounds, recording every adjustment as `'<key> <given> -> <applied>'`. */
const clampOptions = (input: ToolsCallInput): { options: ToolsOptions; clamped: string[] } => {
  const clamped: string[] = []
  const options: ToolsOptions = {
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }),
    ...(input.maxCharacters === undefined ? {} : { maxCharacters: input.maxCharacters }),
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
  }
  for (const key of CLAMPED_KEYS) {
    const given = options[key]
    if (given !== undefined && given > CEILINGS[key]) {
      clamped.push(`${key} ${given} -> ${CEILINGS[key]}`)
      // CLAMPED_KEYS are all numeric ToolsOptions fields.
      ;(options as Record<string, number>)[key] = CEILINGS[key]
    }
  }
  return { options, clamped }
}

/** Why an execution was stopped early. */
type StopReason = 'canceled' | 'timeout' | 'line_quota' | 'byte_quota'

/** In-flight execution — enough state to stop it by correlation id. */
type Execution = {
  /** Process-group leader pid. `detached` makes the group id equal this pid. */
  pid: number
  /** First stop signal wins, so a late cancel cannot relabel a timeout. */
  stopReason: StopReason | null
}

/** Interpreter bridge — `-lc` so the script runs as shell source with login PATH. */
const SHELL = Bun.which('bash') ?? Bun.which('sh') ?? 'bash'

/** Executions currently running, keyed by correlation id. */
const active = new Map<string, Execution>()

/**
 * Signal an execution's whole process group, escalating to SIGKILL.
 *
 * @remarks
 * `Bun.spawn`'s `AbortSignal` and native `timeout` kill only the leader: a
 * `bash -lc` that forks (`echo x; sleep 30`) leaves the grandchild orphaned and
 * reparented to init. Signals must target `-pid` (the group created by
 * `detached: true`), and SIGTERM alone can be trapped or ignored, hence the
 * SIGKILL escalation.
 */
const killGroup = ({ pid }: { pid: number }): void => {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Already exited.
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone — the common case.
    }
  }, KILL_GRACE_MS)
}

/** Record why an execution stopped and signal its group. First writer wins. */
const stopExecution = ({ execution, reason }: { execution: Execution; reason: StopReason }): void => {
  if (execution.stopReason !== null) return
  execution.stopReason = reason
  killGroup({ pid: execution.pid })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a decoded chunk into complete lines, returning the unterminated tail. */
const takeLines = ({ chunk, carry }: { chunk: string; carry: string }): { lines: string[]; carry: string } => {
  const parts = `${carry}${chunk}`.split('\n')
  const nextCarry = parts.pop() ?? ''
  return { lines: parts, carry: nextCarry }
}

/**
 * Read one process stream to EOF, invoking `onLine` per complete line.
 *
 * @remarks
 * Both streams are pumped concurrently: an unread pipe fills at ~64KB and
 * blocks the child, so a command that writes heavily to stderr would deadlock
 * if stderr were drained only after stdout.
 *
 * `flushLimit` bounds a line that never ends: a chunk without newlines (a
 * minified blob, `cat` of a binary) is flushed in `flushLimit`-sized pieces so
 * `carry` — and every line handed downstream — stays bounded. Pieces are
 * UTF-16 slices, so a split astral character yields escaped surrogates in the
 * JSON result; the alternative (byte-accurate grapheme slicing) is not worth
 * the machinery for guardrail output.
 */
const pumpLines = async ({
  stream,
  onLine,
  flushLimit,
}: {
  stream: ReadableStream<Uint8Array>
  onLine: (line: string) => void
  flushLimit: number
}): Promise<void> => {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let carry = ''
  const emit = (segment: string): void => {
    let rest = segment
    while (rest.length > flushLimit) {
      onLine(rest.slice(0, flushLimit))
      rest = rest.slice(flushLimit)
    }
    if (rest !== '') onLine(rest)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const split = takeLines({ chunk: decoder.decode(value, { stream: true }), carry })
    carry = split.carry
    for (const line of split.lines) emit(line)
    while (carry.length >= flushLimit) {
      emit(carry.slice(0, flushLimit))
      carry = carry.slice(flushLimit)
    }
  }
  if (carry !== '') emit(carry)
}

/** Post the single terminal result event for an execution, echoing any request space. */
const postResult = ({ id, result, space }: { id: string; result: ToolsResult; space?: string }): void => {
  self.postMessage({
    type: WORKER_MESSAGE_KINDS.tool_call_result,
    detail: { id, result },
    ...(space === undefined ? {} : { space }),
  })
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Characters of stdout echoed into a JSON parse-failure message. */
const JSON_SNIPPET_CHARS = 200

/**
 * Run one script and return its bounded result.
 *
 * @remarks
 * Everything captured is bounded by construction: the paged window by
 * `offset`/`limit`, `raw`/`stderr` by tail-truncation, `json` by the byte
 * quota's group kill, and the whole run by `maxLines` and the deadline.
 */
const runScript = async ({
  id,
  script,
  options,
}: {
  id: string
  script: string
  options: ToolsOptions
}): Promise<ToolsResult> => {
  const started = performance.now()
  const format = options.format ?? 'paged'
  const offset = options.offset ?? DEFAULT_OFFSET
  const limit = options.limit ?? DEFAULT_LIMIT
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES

  const proc = Bun.spawn([SHELL, '-lc', script], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    // Always piped: an unread stdin would hang any command that reads it, so
    // the sink is written when the host supplied one and closed either way.
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })

  if (options.stdin !== undefined) proc.stdin.write(options.stdin)
  proc.stdin.end()

  const execution: Execution = { pid: proc.pid, stopReason: null }
  active.set(id, execution)
  const deadline = setTimeout(() => stopExecution({ execution, reason: 'timeout' }), timeoutMs)

  try {
    const pagedLines: string[] = []
    const jsonLines: string[] = []
    let sequence = 0
    let stdoutSeen = 0
    let jsonChars = 0
    let rawTail = ''
    let rawChars = 0
    let rawDropped = 0
    let rawTruncated = false
    let stderrTail = ''
    let stderrChars = 0
    let stderrDropped = 0
    let stderrTruncated = false

    /**
     * Enforce the hard line bound.
     *
     * @remarks
     * The line that trips the cap is still captured and streamed, then the group
     * is killed and both handlers go inert — so `totalLines` can never exceed
     * `maxLines` no matter how fast the command floods. This is the guarantee
     * §4.2 wanted from a quota thread; it lives here because the worker is the
     * only party holding the pid.
     */
    const enforceLineCap = (): void => {
      if (sequence >= maxLines) stopExecution({ execution, reason: 'line_quota' })
    }

    const onStdoutLine = (raw: string): void => {
      if (execution.stopReason !== null) return
      const clean = Bun.stripANSI(raw)
      sequence += 1
      stdoutSeen += 1
      if (format === 'paged') {
        if (stdoutSeen > offset && pagedLines.length < limit) pagedLines.push(clean)
      } else if (format === 'json') {
        jsonLines.push(clean)
        jsonChars += clean.length + 1
        // A JSON blob over the character bound would flood the model's context
        // wholesale — §2's hard claim — so the group dies rather than the parse.
        if (jsonChars > maxCharacters) stopExecution({ execution, reason: 'byte_quota' })
      } else {
        // Tail-biased: errors surface at the end of output, so the dropped head is
        // the least useful part. Only the tail window is retained — the full
        // stream is never buffered.
        const next = rawTail === '' ? clean : `${rawTail}\n${clean}`
        rawChars += next.length - rawTail.length
        rawTail = next
        if (rawTail.length > maxCharacters) {
          rawTruncated = true
          rawTail = rawTail.slice(-maxCharacters)
          rawDropped = rawChars - rawTail.length
        }
      }
      enforceLineCap()
    }

    const onStderrLine = (raw: string): void => {
      if (execution.stopReason !== null) return
      const clean = Bun.stripANSI(raw)
      sequence += 1
      // Tail-biased like `raw`: failures print at the end, so the dropped head
      // is the least useful part.
      const next = stderrTail === '' ? clean : `${stderrTail}\n${clean}`
      stderrChars += next.length - stderrTail.length
      stderrTail = next
      if (stderrTail.length > maxCharacters) {
        stderrTruncated = true
        stderrTail = stderrTail.slice(-maxCharacters)
        stderrDropped = stderrChars - stderrTail.length
      }
      enforceLineCap()
    }

    await Promise.all([
      pumpLines({ stream: proc.stdout, onLine: onStdoutLine, flushLimit: maxCharacters }),
      pumpLines({ stream: proc.stderr, onLine: onStderrLine, flushLimit: maxCharacters }),
    ])

    await proc.exited

    // A stopped run reports what it managed to produce: the streams end when the
    // group dies, so the partial window is already in hand. `byte_quota` is only
    // raised on the json path, which returns its own error before using this.
    const stopped: ToolsStatus =
      execution.stopReason === null
        ? 'completed'
        : execution.stopReason === 'byte_quota'
          ? 'error'
          : execution.stopReason
    const base = {
      id,
      exitCode: proc.exitCode,
      signal: proc.signalCode,
      totalLines: stdoutSeen,
      stderr: stderrTruncated ? `${stderrTail}\n[...truncated: ${stderrDropped} chars dropped]` : stderrTail,
      durationMs: Math.round(performance.now() - started),
    }

    if (format === 'json') {
      if (execution.stopReason === 'byte_quota') {
        return {
          ...base,
          status: 'error',
          hasMore: false,
          message: `output_exceeds_max_characters: ${maxCharacters}`,
        }
      }
      // Any other stop (cancel, timeout, line cap) leaves a partial document —
      // report the stop, do not parse half a JSON blob.
      if (execution.stopReason !== null) return { ...base, status: stopped, hasMore: false }
      const text = jsonLines.join('\n')
      try {
        return { ...base, status: stopped, hasMore: false, jsonData: JSON.parse(text) }
      } catch {
        return {
          ...base,
          status: 'error',
          hasMore: false,
          message: `json_parse_failed: ${text.slice(0, JSON_SNIPPET_CHARS)}`,
        }
      }
    }

    if (format === 'raw') {
      const notice = rawTruncated
        ? `\n[...truncated: ${rawDropped} chars dropped — use format 'paged' with offset/limit to page]`
        : ''
      return { ...base, status: stopped, hasMore: rawTruncated, stdout: `${rawTail}${notice}` }
    }

    return {
      ...base,
      status: stopped,
      lines: pagedLines,
      hasMore: stdoutSeen > offset + limit,
    }
  } finally {
    clearTimeout(deadline)
    active.delete(id)
  }
}

// ---------------------------------------------------------------------------
// Worker message loop
// ---------------------------------------------------------------------------

/** An error result carrying no capture — the run never produced a process. */
const errorResult = ({ id, message }: { id: string; message: string }): ToolsResult => ({
  id,
  status: 'error',
  exitCode: null,
  signal: null,
  totalLines: 0,
  hasMore: false,
  stderr: '',
  durationMs: 0,
  message,
})

/** Route one inbound event. */
const handleInbound = async (message: unknown): Promise<void> => {
  if (validateToolCancelEvent(message)) {
    const execution = active.get(message.detail.id)
    if (execution !== undefined) stopExecution({ execution, reason: 'canceled' })
    return
  }
  // Events failing the shared schema have no correlation id to report to and
  // are dropped — the router only forwards schema-valid events, so this is
  // defense in depth at the process boundary.
  if (!validateToolCallEvent(message)) return
  const event = message as ToolCallEvent
  const { id, input } = event.detail
  // Input that fails the boundary is error data, not a throw: the id is valid,
  // so the caller learns why nothing ran.
  if (!validateToolsCallInput(input)) {
    postResult({
      id,
      result: errorResult({ id, message: `invalid input: ${ajv.errorsText(validateToolsCallInput.errors)}` }),
      space: event.space,
    })
    return
  }
  const { options, clamped } = clampOptions(input)
  // `runScript` never rejects on the host side: any worker-side throw (bad cwd,
  // missing interpreter, a kill race) becomes `status: 'error'` data instead.
  try {
    const result = await runScript({ id, script: input.script, options })
    postResult({ id, result: clamped.length === 0 ? result : { ...result, clamped }, space: event.space })
  } catch (err) {
    postResult({
      id,
      result: errorResult({ id, message: err instanceof Error ? err.message : String(err) }),
      space: event.space,
    })
  }
}

// The wire is the behavioral event vocabulary, validated with the shared
// schemas — the trust boundary for anything crossing into this process.
self.onmessage = (event: MessageEvent): void => {
  void handleInbound(event.data)
}

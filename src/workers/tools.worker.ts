/**
 * Tools worker — executes one script per request in a cancellable `bash`
 * subprocess, streams stdout/stderr lines to the host as they arrive, and
 * returns a single bounded terminal result.
 *
 * @remarks
 * Spawned by URL from `use-tools.ts` (`new Worker(new URL('./tools.worker.ts', ...))`)
 * and imported by nobody, so it needs no main-vs-worker detection: Bun exposes
 * `self` and `self.postMessage` on the main thread too, and `self.importScripts`
 * is undefined in both, so every ambient discriminator lies.
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

import type {
  ToolsInbound,
  ToolsLineEvent,
  ToolsRequest,
  ToolsResult,
  ToolsResultEvent,
  ToolsStatus,
  ToolsStream,
} from './tools.types.ts'

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

/** Post one output line to the host. */
const postLine = ({
  id,
  lineNumber,
  stream,
  line,
}: {
  id: string
  lineNumber: number
  stream: ToolsStream
  line: string
}): void => {
  const event: ToolsLineEvent = { type: 'LINE', id, lineNumber, stream, line }
  self.postMessage(event)
}

/** Post the single terminal event for an execution. */
const postResult = ({ id, result }: { id: string; result: ToolsResult }): void => {
  const event: ToolsResultEvent = { type: 'RESULT', id, result }
  self.postMessage(event)
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
const runScript = async ({ request }: { request: ToolsRequest }): Promise<ToolsResult> => {
  const { id, script, options } = request
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
      postLine({ id, lineNumber: sequence, stream: 'stdout', line: clean })
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
      // is the least useful part. LINE events still carry every line.
      const next = stderrTail === '' ? clean : `${stderrTail}\n${clean}`
      stderrChars += next.length - stderrTail.length
      stderrTail = next
      if (stderrTail.length > maxCharacters) {
        stderrTruncated = true
        stderrTail = stderrTail.slice(-maxCharacters)
        stderrDropped = stderrChars - stderrTail.length
      }
      postLine({ id, lineNumber: sequence, stream: 'stderr', line: clean })
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

/** Route one inbound message. */
const handleInbound = async (message: ToolsInbound): Promise<void> => {
  if (message.type === 'CANCEL') {
    const execution = active.get(message.id)
    if (execution !== undefined) stopExecution({ execution, reason: 'canceled' })
    return
  }
  // `execute` never rejects on the host side: any worker-side throw (bad cwd,
  // missing interpreter, a kill race) becomes `status: 'error'` data instead.
  try {
    const result = await runScript({ request: message })
    postResult({ id: message.id, result })
  } catch (err) {
    postResult({
      id: message.id,
      result: errorResult({
        id: message.id,
        message: err instanceof Error ? err.message : String(err),
      }),
    })
  }
}

// The wire payload is produced by our own host code, so it is typed by
// assertion rather than re-validated here — model input is validated once, at
// the tool boundary (see `use-tools.ts`). MINIMAL: add an AJV wire validator if
// the worker ever accepts messages from outside this process.
self.onmessage = (event: MessageEvent): void => {
  void handleInbound(event.data as ToolsInbound)
}

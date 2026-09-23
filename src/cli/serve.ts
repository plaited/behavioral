import { join } from 'node:path'
import { TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type { BPEvent, JsonObject } from '../behavioral/behavioral.types.ts'
import { behavioralHome } from '../faculties/behavioral-home.ts'
import { bProgram } from './b-program.ts'
import { createJsonRpcServer, type JsonRpcMessage, type JsonRpcServer } from './json-rpc.ts'
import { loadConfig } from './load-config.ts'
import { collectSecretValues, createTraceConsumer, traceLogSink } from './trace-consumer.ts'

/**
 * The host's runtime surface — a narrow view of {@link bProgram}'s handle.
 *
 * @public
 */
export type HostRuntime = Pick<ReturnType<typeof bProgram>, 'trigger' | 'useTrace' | 'start' | 'terminate'>

/** Map one inbound JSON-RPC message onto the engine. */
const dispatch = (runtime: HostRuntime, message: JsonRpcMessage): unknown => {
  const { method, params } = message
  if (method === 'trigger') {
    runtime.trigger((params as { event: BPEvent }).event)
    return { accepted: true }
  }
  if (method === 'ui_event') {
    // The controller's `ui_event` carries a BPEvent; ingress it directly.
    runtime.trigger((params as { event: BPEvent }).event)
    return undefined
  }
  if (method.startsWith('ui_')) {
    runtime.trigger({ type: method, detail: params as JsonObject })
    return undefined
  }
  throw new Error(`unknown method: ${method}`)
}

/**
 * Wire the JSON-RPC codec to a runtime: ingress messages become triggers, `ui_*`
 * selections become client notifications, and redacted traces fan out to a JSONL
 * log and a `trace` notification. Subscribes, then `start()`s the composition.
 *
 * @public
 */
export const createHost = ({
  runtime,
  input,
  write,
  home = behavioralHome(),
}: {
  runtime: HostRuntime
  input: ReadableStream<Uint8Array>
  write: (line: string) => void
  home?: string
}): { rpc: JsonRpcServer } => {
  const rpc = createJsonRpcServer({ input, write, onMessage: (message) => dispatch(runtime, message) })

  // Observability: redacted traces to the JSONL log and the client.
  const consumer = createTraceConsumer({
    secrets: collectSecretValues(),
    sinks: [traceLogSink({ root: join(home, 'traces') }), (trace) => rpc.notify('trace', trace)],
  })
  runtime.useTrace(consumer)

  // Egress-as-selection: a `ui_*` selection becomes a client notification.
  runtime.useTrace((trace) => {
    if (trace.kind !== TRACE_MESSAGE_KINDS.selection) return
    const selected = trace.selected
    if (selected.type.startsWith('ui_')) rpc.notify(selected.type, selected.detail)
  })

  runtime.start()
  rpc.notify('ready')
  return { rpc }
}

/**
 * The stdio entry: compose the runtime from the home config and serve IPC until
 * the client closes the input stream.
 *
 * @public
 */
export const serve = async (): Promise<void> => {
  const runtime = bProgram(await loadConfig())
  const { rpc } = createHost({
    runtime,
    input: Bun.stdin.stream(),
    write: (line) => {
      process.stdout.write(line)
    },
  })
  await rpc.done
  runtime.terminate()
}

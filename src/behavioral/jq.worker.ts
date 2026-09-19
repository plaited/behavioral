import { type JqError, loadJq } from 'jq-wasm'
import { isTypeOf } from '../utils.ts'
import type { JsonObject, TransformEvaluation } from './behavioral.types.ts'

const jq = await loadJq() // async init once — all handle methods are synchronous

const encoder = new TextEncoder()

/**
 * The jq eval worker — spawned per evaluation by the `evaluateTransform`
 * bridge in `behavioral.utils.ts`.
 *
 * Protocol: the host posts `{ sab, query, detail }` where `sab` is a
 * SharedArrayBuffer laid out as `[status Int32][byteLength Int32][result
 * bytes...]`. The host is blocked in `Atomics.wait` on the status slot when
 * this runs — its event loop is frozen, so a result sent via `postMessage`
 * could never be received. Results travel through shared memory only:
 * the worker writes the JSON-serialized {@link TransformEvaluation} into the
 * buffer, stores the status, notifies, and closes. Worker messages received
 * before module evaluation completes (the wasm `loadJq`) are buffered by the
 * worker runtime, so the eval timeout covers evaluation, not compilation.
 */
self.onmessage = ({ data }: MessageEvent<{ sab: SharedArrayBuffer; query: string; detail?: JsonObject }>) => {
  const { sab, query, detail } = data
  const header = new Int32Array(sab, 0, 2)
  const resultBytes = new Uint8Array(sab, 8)

  let evaluation: TransformEvaluation
  if (detail === undefined || detail === null) {
    evaluation = { ok: false, reason: 'no_detail' }
  } else {
    try {
      const value: unknown = jq.first(detail, query)
      if (value === undefined) {
        evaluation = { ok: false, reason: 'empty_output' }
      } else if (isTypeOf<JsonObject>(value, 'object')) {
        evaluation = { ok: true, value }
      } else {
        evaluation = { ok: false, reason: 'non_object_output' }
      }
    } catch (err) {
      const { stderr, exitCode } = err as JqError
      evaluation = { ok: false, reason: 'jq_error', stderr, exitCode }
    }
  }

  let json = encoder.encode(JSON.stringify(evaluation))
  if (json.byteLength > resultBytes.byteLength) {
    // The evaluated value exceeds the shared-buffer cap — the fallback
    // evaluation is always small.
    evaluation = { ok: false, reason: 'output_too_large' }
    json = encoder.encode(JSON.stringify(evaluation))
  }
  resultBytes.set(json)
  Atomics.store(header, 1, json.byteLength)
  Atomics.store(header, 0, 1) // done — the host may be parked on this slot
  Atomics.notify(header, 0)
  self.close()
}

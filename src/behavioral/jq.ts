import { type JqError, loadJq } from 'jq-wasm'
import { isTypeOf } from '../utils.ts'
import type { JsonObject, TransformFailureReason } from './behavioral.types.ts'

const jq = await loadJq() // async init once — all handle methods are synchronous

/**
 * The one place a jq evaluation becomes data — the whole first output, parsed,
 * or a machine-readable failure reason. Never throws: `JqError`, missing
 * detail, empty output, and non-object output all become traced failures
 * (errors-as-data like `trigger_error`/`add_thread_error`); on failure the
 * target event never fires.
 */
export type TransformEvaluation =
  | { ok: true; value: JsonObject }
  | { ok: false; reason: TransformFailureReason; stderr?: string; exitCode?: number }

export const evaluateTransform = (query: string, detail: JsonObject | undefined): TransformEvaluation => {
  if (detail === undefined || detail === null) return { ok: false, reason: 'no_detail' }
  try {
    const value: unknown = jq.first(detail, query)
    if (value === undefined) return { ok: false, reason: 'empty_output' }
    if (!isTypeOf<JsonObject>(value, 'object')) return { ok: false, reason: 'non_object_output' }
    return { ok: true, value }
  } catch (err) {
    const { stderr, exitCode } = err as JqError
    return { ok: false, reason: 'jq_error', stderr, exitCode }
  }
}

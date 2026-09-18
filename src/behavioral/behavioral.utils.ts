import { loadJq, type JqError } from 'jq-wasm'
import { FRONTIER_STATUS, IDIOMS, TRACE_MESSAGE_KINDS } from './behavioral.constants.ts'
import type {
  BPEvent,
  CandidateBid,
  Frontier,
  Idioms,
  JsonObject,
  PendingBid,
  RegisteredBPListener,
  RegisteredIdioms,
  RegisteredTransformListener,
  RulesFunction,
  RunningBid,
  SendTrace,
  Transformer,
  TransformFailureReason,
  UseThread,
} from './behavioral.types.ts'
import { ajv } from './behavioral.types.ts'
import { isTypeOf } from '../utils.ts'

/**
 * @internal
 * Creates a checker function to determine if a given BPListener matches a CandidateBid.
 */
export const isListeningFor = ({ type, detail, space, ingress }: CandidateBid) => {
  return (listener: RegisteredBPListener | RegisteredTransformListener): boolean => {
    const spaceMatches = listener.space ? space === listener.space : true
    const schemaMatches = listener.detailSchema ? detailValidators.get(listener)!(detail) : true
    const detailMatches = listener.detailMatch === false ? !schemaMatches : schemaMatches
    const ingressMatches = listener.ingressMatch === undefined || listener.ingressMatch === (ingress === true)
    return listener.type === type && spaceMatches && detailMatches && ingressMatches
  }
}

/**
 * Compiles and caches an Ajv validator per registered listener's
 * `detailSchema` (WeakMap-keyed so looped threads recompile nothing).
 */
const detailValidators = new WeakMap<RegisteredBPListener | RegisteredTransformListener, (detail: unknown) => boolean>()

/** @internal — called from generateRulesFunctions when a listener is registered. */
const compileListenerValidator = (listener: RegisteredBPListener | RegisteredTransformListener): void => {
  if (listener.detailSchema && !detailValidators.has(listener)) {
    try {
      detailValidators.set(listener, ajv.compile(listener.detailSchema))
    } catch (error) {
      throw new Error(`un-compilable detailSchema for listener "${listener.type}": ${(error as Error).message}`)
    }
  }
}
/**
 * @internal
 * Computes the execution frontier from pending bids.
 *
 * The frontier captures:
 * - all requested candidates
 * - the subset enabled after applying block listeners
 * - a scheduler-facing status classification
 */
export const computeFrontier = (pending: Set<PendingBid>): Frontier => {
  const blocked: RegisteredBPListener[] = []
  const candidates: CandidateBid[] = []

  for (const { request, priority, block, ingress, space } of pending) {
    block && blocked.push(...block)
    request &&
      candidates.push({
        priority,
        ingress,
        space,
        ...request,
      })
  }

  const enabled: CandidateBid[] = []
  const length = candidates.length
  for (let i = 0; i < length; i++) {
    const candidate = candidates[i]!
    if (!blocked.some(isListeningFor(candidate))) {
      enabled.push(candidate)
    }
  }

  if (enabled.length > 0) {
    return { candidates, enabled, status: FRONTIER_STATUS.ready }
  }
  if (candidates.length > 0) {
    return { candidates, enabled, status: FRONTIER_STATUS.deadlock }
  }
  return { candidates, enabled, status: FRONTIER_STATUS.idle }
}

export const advanceRunningToPending = (running: Set<RunningBid>, pending: Set<PendingBid>) => {
  for (const bid of running) {
    const { generator, priority, label, ingress, space } = bid
    const { value, done } = generator.next()
    !done &&
      pending.add({
        priority,
        ingress,
        label,
        generator,
        space,
        ...value,
      })
    running.delete(bid)
  }
}

const eventMatchesCandidate = (request: BPEvent, selectedEvent: CandidateBid) => {
  if (selectedEvent.type !== request.type) return false
  if (selectedEvent.space && selectedEvent.space !== request.space) return false
  return Bun.deepEquals(request.detail, selectedEvent.detail)
}

export const resumePendingThreadsForSelectedEvent = ({
  running,
  pending,
  selectedEvent,
  sendTrace,
  instanceId,
  step,
}: {
  running: Set<RunningBid>
  pending: Set<PendingBid>
  selectedEvent: CandidateBid
  sendTrace?: SendTrace
  instanceId: string
  step: number
}) => {
  const transformers: Transformer[] = []
  for (const bid of pending) {
    const { waitFor, request, generator, interrupt, transform, label } = bid
    const isInterrupted = interrupt?.some(isListeningFor(selectedEvent))
    const isWaitedFor = waitFor?.some(isListeningFor(selectedEvent))
    const isTransform = transform?.flatMap((listener) =>
      isListeningFor(selectedEvent)(listener) ? { target: listener.target, query: listener.query, thread: label, space: listener.space } : [],
    )
    const hasPendingRequest = request && eventMatchesCandidate(request, selectedEvent)
    if (isInterrupted) {
      generator.return?.()
      pending.delete(bid)
      sendTrace?.({
        kind: TRACE_MESSAGE_KINDS.interrupt,
        timestamp: Date.now(),
        step,
        instanceId,
        selected: selectedEvent,
        threadLabel: label,
      })
      continue
    }
    if (hasPendingRequest || isWaitedFor || isTransform?.length) {
      running.add({ ...bid })
      pending.delete(bid)
    }
    if (isTransform?.length) {
      transformers.push(...isTransform)
    }
  }
  return transformers
}

export const generateRulesFunctions = (rules: Idioms[], space?: string): RulesFunction[] => {
  const syncs: RulesFunction[] = []
  for (const { request, waitFor, block, interrupt, transform } of rules) {
    const registeredIdioms: RegisteredIdioms = {}
    if (request) {
      registeredIdioms[IDIOMS.request] = {
        type: request.type,
        space,
        detail: request.detail,
      }
    }
    if (block) {
      registeredIdioms[IDIOMS.block] = block.map((listener) => {
        const registered = { ...listener, space }
        compileListenerValidator(registered)
        return registered
      })
    }
    if (waitFor) {
      registeredIdioms[IDIOMS.waitFor] = waitFor.map((listener) => {
        const registered = { ...listener, space }
        compileListenerValidator(registered)
        return registered
      })
    }
    if (interrupt) {
      registeredIdioms[IDIOMS.interrupt] = interrupt.map((listener) => {
        const registered = { ...listener, space }
        compileListenerValidator(registered)
        return registered
      })
    }
    if (transform) {
      registeredIdioms[IDIOMS.transform] = transform.map((listener) => {
        const registered = { ...listener, space }
        compileListenerValidator(registered)
        return registered
      })
    }
    syncs.push(function* () {
      yield registeredIdioms
    })
  }
  return syncs
}

/**
 * Composes an ordered array of rule generators into a single behavioral thread generator.
 *
 * @param rules - Rule generators (each yielding one `RegisteredIdioms`) to compose.
 * @param once - When `true`, the thread runs through the rules once and completes.
 *               When omitted, the thread loops the rules indefinitely.
 * @returns A generator function yielding the idioms from each rule in sequence.
 *
 * @remarks
 * - The `once` flag controls repetition semantics for the behavioral scheduler.
 * - Empty rule arrays complete immediately (the generator is `done` on first call).
 *
 * @see {@link generateRulesFunctions} for building the rule array from author-facing `Idioms`.
 */
export const useThread: UseThread = (rules: RulesFunction[], once?: true) =>
  once
    ? function* () {
        const length = rules.length
        for (let i = 0; i < length; i++) {
          yield* rules[i]!()
        }
      }
    : function* () {
        while (true) {
          const length = rules.length
          for (let i = 0; i < length; i++) {
            yield* rules[i]!()
          }
        }
      }
const jq = await loadJq() // async init once — all handle methods are synchronous

/**
 * @internal
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

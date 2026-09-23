/**
 * The System Two family's config surface — the two halves that make the family
 * pluggable without changing its wire contract.
 *
 * @remarks
 * `configSystemTwo` is the PROCESS-SIDE factory, invoked at the top of a
 * provider entry file. It owns the generic plumbing — inbound routing, the
 * result envelope, cancel and timeout — and calls the supplied `respond` for
 * the actual model call. A provider supplies only `respond` (ours is the Open
 * Responses implementation in `system-two.behavior.ts`); the event contract,
 * and therefore the guard threads the composition derives, are unchanged.
 *
 * `useSystemTwo` is the HOST-SIDE helper: it references a provider entry file
 * (default: the bundled Open Responses entry) and wires `useBehavior`, seeding
 * the endpoint map as environment data. Its return is what `bProgram` takes as
 * `systemTwo` — no default exists, because a System Two family without an
 * endpoint is simply absent.
 *
 * @packageDocumentation
 */

import type { JsonObject } from '../behavioral/behavioral.types.ts'
import { BEHAVIOR_MESSAGE_KINDS } from './behaviors.constants.ts'
import {
  SystemTwoCancelEventSchema,
  type SystemTwoRequestEvent,
  SystemTwoRequestEventSchema,
  SystemTwoRequestResultEventSchema,
  validateSystemTwoCancelEvent,
  validateSystemTwoRequestEvent,
} from './behaviors.types.ts'
import { emit, envData, wireInbound } from './process-lane.ts'
import { validateSystemTwoInput } from './system-two.schemas.ts'
import {
  SYSTEM_TWO_ENDPOINTS_KEY,
  type SystemTwoEndpoints,
  type SystemTwoInput,
  type SystemTwoOutput,
} from './system-two.types.ts'
import { useBehavior } from './use-behavior.ts'

/** The in-flight request timeout — the provider call is aborted past this. */
const FETCH_TIMEOUT_MS = 60_000

/** What `configSystemTwo` hands a provider's `respond`: the endpoint map and the abort signal. */
export type SystemTwoRespondContext = {
  endpoints: SystemTwoEndpoints
  signal: AbortSignal
}

/** A provider's model call: one validated input in, one output (or error data) out. */
export type SystemTwoRespond = (input: SystemTwoInput, context: SystemTwoRespondContext) => Promise<SystemTwoOutput>

type ActiveRequest = {
  controller: AbortController
  /** First stop reason wins. */
  reason: 'canceled' | 'timeout' | null
  timer: ReturnType<typeof setTimeout>
}

/**
 * The process-side factory: wire the inbound lane around one provider's
 * `respond`. Called at the top of a System Two provider entry file.
 */
export const configSystemTwo = (respond: SystemTwoRespond): void => {
  const endpoints = (envData(SYSTEM_TWO_ENDPOINTS_KEY) ?? {}) as SystemTwoEndpoints
  /** In-flight requests, keyed by correlation id. */
  const active = new Map<string, ActiveRequest>()

  const postResult = (id: string, result: unknown, space?: string): void => {
    emit({
      type: BEHAVIOR_MESSAGE_KINDS.system_two_request_result,
      // The uniform envelope: { isError: true, … } → error branch; the model
      // respond output → ok branch.
      detail: ((): JsonObject & { id: string } => {
        if (typeof result === 'object' && result !== null && 'isError' in result) {
          const { isError, ...rest } = result as { isError: boolean } & JsonObject
          return { id, ok: false, error: { code: 'error', ...(isError ? rest : {}) } }
        }
        return { id, ok: true, result: (result ?? {}) as JsonObject }
      })(),
      ...(space === undefined ? {} : { space }),
    })
  }

  /** Route one inbound event. */
  const handleInbound = async (message: unknown): Promise<void> => {
    if (validateSystemTwoCancelEvent(message)) {
      const request = active.get(message.detail.id)
      if (request !== undefined && request.reason === null) {
        request.reason = 'canceled'
        request.controller.abort()
      }
      return
    }
    // Events failing the shared schema have no correlation id to report to and
    // are dropped — the guard thread only forwards schema-valid events, so this
    // is defense in depth at the process boundary.
    if (!validateSystemTwoRequestEvent(message)) return
    const event = message as SystemTwoRequestEvent
    const { id, input } = event.detail
    // Input that fails the boundary is error data, not a throw: the id is valid,
    // so the caller learns why nothing ran.
    if (!validateSystemTwoInput(input)) {
      const detail = validateSystemTwoInput.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')
      postResult(id, { isError: true, message: `invalid input: ${detail}` }, event.space)
      return
    }

    const controller = new AbortController()
    const request: ActiveRequest = {
      controller,
      reason: null,
      timer: setTimeout(() => {
        if (request.reason === null) {
          request.reason = 'timeout'
          controller.abort()
        }
      }, FETCH_TIMEOUT_MS),
    }
    active.set(id, request)

    // `respond` never rejects the process: any provider throw becomes result data.
    try {
      const result = await respond(input, { endpoints, signal: controller.signal })
      postResult(id, result, event.space)
    } catch (error) {
      if (request.reason === 'timeout')
        postResult(id, { isError: true, message: `model request timed out after ${FETCH_TIMEOUT_MS}ms` }, event.space)
      else if (request.reason === 'canceled')
        postResult(id, { isError: true, message: 'model request canceled' }, event.space)
      else
        postResult(id, { isError: true, message: error instanceof Error ? error.message : String(error) }, event.space)
    } finally {
      clearTimeout(request.timer)
      active.delete(id)
    }
  }

  wireInbound((message) => handleInbound(message))
}

/**
 * The host-side helper: wire the System Two family process for a provider entry.
 * `endpoints` is delivered as environment data (secrets never cross the wire).
 */
export const useSystemTwo = ({
  endpoints,
  entry = 'system-two.behavior.ts',
}: {
  /** Provider label → endpoint config, delivered to the process via environment data. */
  endpoints: SystemTwoEndpoints
  /** The provider entry file (relative to `src/behaviors`). Defaults to the bundled Open Responses entry. */
  entry?: string
}) =>
  useBehavior({
    command: ['bun', 'run', entry],
    name: 'systemTwo',
    threads: [],
    env: { [SYSTEM_TWO_ENDPOINTS_KEY]: JSON.stringify(endpoints) },
    requestSchema: SystemTwoRequestEventSchema,
    cancelSchema: SystemTwoCancelEventSchema,
    resultSchema: SystemTwoRequestResultEventSchema,
  })

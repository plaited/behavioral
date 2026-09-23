import type { ValidateFunction } from 'ajv'
import type { BPEvent, Thread } from '../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from './workers.constants.ts'
import type { AddThreads, WorkerMessage } from './workers.types.ts'

/**
 * The per-family wiring primitive — the one function every family (and every
 * per-space satellite stack) wires through.
 *
 * @remarks
 * Curried in two stages: the initial call captures the family's Worker
 * instance, its wire name, its thread pack, and its two event validators;
 * the returned function — awaiting `(addThreads, space?)` — is what a
 * composition (or a host building a sandboxed variant) hands to the engine
 * port. On invocation it wires:
 *
 * - **reenter** — the family's result events (gated by
 *   `validateResultEvent` — the REQUEST validators belong to the routing
 *   side) re-enter the engine as once-threads, `message.space` PRESERVED
 *   (root threads stay root, space results re-enter their space);
 * - **onerror → worker_error** — only the router can see a satellite crash,
 *   so the crash is synthesized as one `worker_error` event (errors-as-data);
 * - **thread-pack mounting** — the pack stamps with the wiring space (root
 *   when unset).
 *
 * CONTRACT: one wiring per Worker instance — a second invocation on the same
 * Worker silently clobbers `onmessage`/`onerror` (single-slot handlers) and
 * double-mounts the pack. Per-space means per-Worker.
 *
 * The `invalidEventGate` is the family's OWN boundary check (its two event
 * schemas are `type`-const-discriminated, so an event can only satisfy its
 * own family's schema) — the composition consults it before routing, which
 * replaces any cross-family union chain.
 */
export const useWorker =
  ({
    worker,
    name,
    threads,
    validateRequestEvent,
    validateEventCancel,
    validateResultEvent,
  }: {
    worker: Worker
    name: string
    threads: Thread[]
    validateRequestEvent: ValidateFunction<WorkerMessage>
    validateEventCancel: ValidateFunction<WorkerMessage>
    validateResultEvent: ValidateFunction<WorkerMessage>
  }) =>
  (addThreads: AddThreads, space?: string) => {
    // Teardown race conversion: a straggler result (or a crash event) racing
    // the host's engine.terminate() posts to a dead port — a known end-of-life
    // failure, converted to a silent drop so satellite teardown never crashes
    // the host process. Any other error still throws.
    const addThreadsSafe = (threads: Thread[]): void => {
      try {
        addThreads(threads)
      } catch (err) {
        if (!(err instanceof Error && err.name === 'InvalidStateError')) throw err
      }
    }
    const reenter = (message: WorkerMessage): void => {
      addThreadsSafe([
        {
          ...(message.space === undefined ? {} : { space: message.space }),
          label: `on_${message.type}_${message.detail.id}`,
          once: true,
          rules: [{ request: { type: message.type, detail: message.detail } }],
        },
      ])
    }
    // The RESULT validator gates the inbound lane (the request validator
    // belongs to the routing side); results re-enter, requests do not.
    worker.onmessage = ({ data }: MessageEvent) => {
      if (!validateResultEvent(data)) return
      reenter(data)
    }
    // Only the router can see a satellite crash — no thread ever could — so the
    // crash is synthesized as one worker_error event (errors-as-data).
    worker.onerror = (error: ErrorEvent): void => {
      addThreadsSafe([
        {
          label: `on_worker_error_${name}`,
          once: true,
          rules: [
            {
              request: {
                type: WORKER_MESSAGE_KINDS.worker_error,
                detail: { worker: name, message: error.message },
              },
            },
          ],
        },
      ])
    }

    // Stamp only when set: an explicit `space: undefined` riding the thread
    // breaks the strict Thread schema (the reenter rule, applied to packs).
    addThreadsSafe(threads.map((thread) => (space === undefined ? thread : { ...thread, space })))

    // True for INVALID events — the family's own boundary check (the two
    // schemas are type-const-discriminated: an event can only satisfy its
    // own family's). The composition consults this before routing.
    const invalidEventGate = (event: BPEvent) => !validateRequestEvent(event) && !validateEventCancel(event)

    return {
      name,
      port: worker,
      invalidEventGate,
    }
  }

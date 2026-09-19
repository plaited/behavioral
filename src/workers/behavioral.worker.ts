/**
 * The engine worker — a dumb transport over one behavioral program.
 *
 * Two message kinds, both of which evaluate:
 * - `addThreads` — provision each thread, then `step()`. The trailing step is
 *   the re-entry contract: host async results (model/tools-client workers) come back
 *   as response threads, and adding them resumes the cascade. Boot uses the
 *   same kind: provisioned threads that only `waitFor` stay quiet until
 *   `trigger`; threads that `request` self-start the program.
 * - `trigger` — inject one external (ingress) event; `trigger` runs its own
 *   cascade (`step(true)` internally).
 *
 * There is deliberately no standalone `step` kind — `addThread` alone is inert
 * at the engine level (public-API invariant), so the step that accompanies
 * provisioning lives here, at the transport, where the host's intent
 * ("resume the program with these threads") is the unit.
 *
 * All trace messages (including `thread_added` provisions) are posted to the
 * host as they emit. MINIMAL: no explicit idle signal yet — `trigger`/`step`
 * return at quiescence (the engine never awaits), so the worker could
 * postMessage one after each handled message; the kernel needs it to
 * distinguish "waiting on host I/O" from "turn over."
 */

import { behavioral } from '../behavioral/behavioral.ts'
import { WORKER_MESSAGE_KINDS } from './workers.constants.ts'
import type { WorkerMessage } from './workers.types.ts'

const { addThread, trigger, step, useTrace } = behavioral()
useTrace((message) => postMessage(message))

self.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
  const { kind } = data
  if (kind === WORKER_MESSAGE_KINDS.add_threads) {
    for (const thread of data.threads) addThread(thread)
    step()
  }
  if (kind === WORKER_MESSAGE_KINDS.trigger) {
    trigger(data.event)
  }
}

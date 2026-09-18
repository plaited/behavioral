import { WORKER_MESSAGE_KINDS } from "../behavioral/behavioral.constants.ts"
import { behavioral } from "../behavioral/behavioral.ts"
import type { WorkerMessage } from "../behavioral/behavioral.types.ts"

const { addThread, trigger, step, useTrace } = behavioral()
useTrace(message => postMessage(message))

self.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
  const { kind } = data
  if (kind === WORKER_MESSAGE_KINDS.step) {
    step()
  }
  if (kind === WORKER_MESSAGE_KINDS.addThreads) {
    for(const thread of data.threads) addThread(thread)
  }
  if (kind === WORKER_MESSAGE_KINDS.trigger) {
    trigger(data.event)
  }
}

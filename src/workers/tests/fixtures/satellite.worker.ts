/*
 * Test fixture: stub satellite speaking the behavioral event wire for the
 * worker families. Echoes a deterministic result for shell_request,
 * response_request, and frontier_request (with the request's space echoed
 * back), and reports cancel receipt through the result channel with a
 * `cancel-` prefixed id so specs can observe cancel routing without real
 * in-flight state.
 */
import { WORKER_MESSAGE_KINDS } from '../../workers.constants.ts'

type InboundEvent = {
  type: string
  detail: { id: string; op?: string; input?: { op?: unknown } }
  space?: string
}

self.onmessage = ({ data }: MessageEvent<InboundEvent>): void => {
  const space = data.space === undefined ? {} : { space: data.space }
  if (data.type === WORKER_MESSAGE_KINDS.shell_request) {
    self.postMessage({
      type: WORKER_MESSAGE_KINDS.shell_request_result,
      detail: { id: data.detail.id, result: { ok: true, value: { op: data.detail.input?.op } } },
      ...space,
    })
  } else if (data.type === WORKER_MESSAGE_KINDS.response_request) {
    self.postMessage({
      type: WORKER_MESSAGE_KINDS.response_request_result,
      detail: { id: data.detail.id, result: { items: [], status: 'completed' } },
      ...space,
    })
  } else if (data.type === WORKER_MESSAGE_KINDS.frontier_request) {
    self.postMessage({
      type: WORKER_MESSAGE_KINDS.frontier_request_result,
      detail: { id: data.detail.id, result: { analysis: data.detail.op } },
      ...space,
    })
  } else if (data.type === WORKER_MESSAGE_KINDS.shell_cancel) {
    self.postMessage({
      type: WORKER_MESSAGE_KINDS.shell_request_result,
      detail: { id: `cancel-${data.detail.id}`, result: { canceled: true } },
    })
  } else if (data.type === WORKER_MESSAGE_KINDS.response_cancel) {
    self.postMessage({
      type: WORKER_MESSAGE_KINDS.response_request_result,
      detail: { id: `cancel-${data.detail.id}`, result: { canceled: true } },
    })
  }
}

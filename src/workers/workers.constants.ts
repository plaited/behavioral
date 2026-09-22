import { keyMirror } from '../utils.ts'

/**
 * Discriminant values for the worker event wire — every `*_request` /
 * `*_request_result` pair a satellite family speaks, plus the engine
 * transport kinds and the crash event. The wire layer's registry.
 */
export const WORKER_MESSAGE_KINDS = keyMirror(
  'trigger',
  'add_threads',
  'response_request',
  'response_request_result',
  'response_cancel',
  'tool_call',
  'tool_call_result',
  'tool_cancel',
  'mcp_request',
  'mcp_request_result',
  'mcp_cancel',
  'frontier_request',
  'frontier_request_result',
  'store_request',
  'store_request_result',
  'worker_error',
)

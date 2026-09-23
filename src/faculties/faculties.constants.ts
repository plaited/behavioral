import { keyMirror } from '../utils.ts'

/**
 * Discriminant values for the faculty event wire — every `*_request` /
 * `*_request_result` pair a faculty speaks, plus the crash event. The
 * wire layer's registry.
 */
export const FACULTY_MESSAGE_KINDS = keyMirror(
  'system_two_request',
  'system_two_request_result',
  'system_two_cancel',
  'system_one_request',
  'system_one_request_result',
  'system_one_cancel',
  'shell_request',
  'shell_request_result',
  'shell_cancel',
  'mcp_request',
  'mcp_request_result',
  'mcp_cancel',
  'frontier_request',
  'frontier_request_result',
  'store_request',
  'store_request_result',
  'faculty_error',
)

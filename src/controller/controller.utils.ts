import type { Disconnect } from '../behavioral/behavioral.types.ts'
import { isTypeOf } from '../utils.ts'
import { SWAP_MODES, SWAP_TARGETS, UI_CORE_MAX_RETRIES, UI_CORE_RETRY_STATUS_CODES } from './controller.constants.ts'
import { WebSocketError, WebSocketMessageError } from './controller.errors.ts'
import type {
  ClientMessage,
  DetectXssViolations,
  ServerMessage,
  Transport,
  TransportEvent,
  XssViolation,
} from './controller.types.ts'

/**
 * EventListener adapter for delegated controller callbacks.
 *
 * @template T - Event type (MouseEvent, KeyboardEvent, etc.)
 * @implements {EventListener}
 *
 * @remarks
 * Wraps sync or async callbacks in an object accepted by native
 * `addEventListener`. Controller islands use it for `b-trigger` bindings and
 * imported modules can reuse it for their own delegated DOM listeners.
 *
 * @see {@link delegates} for the WeakMap storage
 *
 * @public
 */
export class DelegatedListener<T extends Event = Event> {
  callback: (ev: T) => void | Promise<void>
  constructor(callback: (ev: T) => void | Promise<void>) {
    this.callback = callback
  }
  handleEvent(evt: T) {
    void this.callback(evt)
  }
}

/**
 * Classify whether a swap mode's structural boundary is the target element
 * itself (`'self'` — content nests *into* the target) or the target's parent
 * (`'parent'` — content *replaces or flanks* the target, so the parent is the
 * boundary).
 *
 * - **Into** (`afterbegin`, `beforeend`, `innerHTML`): the target IS the
 *   structural container → `'self'`.
 * - **Replace/beside** (`beforebegin`, `afterend`, `outerHTML`): the target's
 *   parent is the container → `'parent'`.
 *
 * Shared by the Renderer (SSR) and Controller (browser) so both surfaces apply
 * the same boundary rule before reading `b-scale`.
 *
 * @param swap - A {@link SWAP_MODES} value.
 * @returns `'self'` for into modes, `'parent'` for replace/beside modes.
 * @public
 */
export const swapBoundary = (swap: keyof typeof SWAP_MODES): keyof typeof SWAP_TARGETS => {
  switch (swap) {
    case SWAP_MODES.afterbegin:
    case SWAP_MODES.beforeend:
    case SWAP_MODES.innerHTML:
      return SWAP_TARGETS.self
    default:
      return SWAP_TARGETS.parent
  }
}

// Hoist static lookups outside the function call
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'data',
  'poster',
  'xlink:href',
  // SVG animation target attributes that can dynamically inject URLs
  'values',
  'to',
])

const DANGEROUS_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:text/html',
  'data:application/xhtml+xml',
  'data:text/xml',
  'data:image/svg+xml',
]

/**
 * Strips ASCII 0-32 (whitespace & control characters) to prevent scheme evasion
 * without triggering ESLint's no-control-regex rule.
 */
const normalizeUrl = (raw: string): string => {
  let cleaned = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 32) {
      cleaned += raw[i]
    }
  }
  return cleaned.toLowerCase()
}

/**
 * Recursively collects all elements, traversing through nested <template> fragments.
 */
const collectAllElements = (root: Element | DocumentFragment): Element[] => {
  const elements: Element[] = []
  const queue: (Element | DocumentFragment)[] = [root]

  while (queue.length > 0) {
    const current = queue.pop()!
    if (current instanceof Element) {
      elements.push(current)
    }

    const descendants = current.querySelectorAll('*')
    for (let i = 0; i < descendants.length; i++) {
      const el = descendants[i]!
      elements.push(el)

      // Traverse nested <template> DocumentFragments to prevent blind-spot bypasses
      if (el instanceof HTMLTemplateElement) {
        queue.push(el.content)
      }
    }
  }

  return elements
}

export const detectXssVectors: DetectXssViolations = (root) => {
  const target = root instanceof HTMLTemplateElement ? root.content : root
  const elements = collectAllElements(target)
  const violations: XssViolation[] = []

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!
    const tagName = el.tagName.toLowerCase()

    // 1. Disallow script execution, base hijacking, and active SVG animations
    if (tagName === 'script' || tagName === 'base') {
      violations.push({
        element: (el.cloneNode(false) as Element).outerHTML,
        reason: `Disallowed tag: <${tagName}>`,
      })
      continue
    }

    // 2. Scan attributes
    for (let j = 0; j < el.attributes.length; j++) {
      const attr = el.attributes[j]!
      const name = attr.name.toLowerCase()

      // Block native inline event attributes (e.g., onclick, onerror)
      // Preserves inert custom attributes (e.g., on-click, on:change)
      if (/^on[a-z]/.test(name)) {
        violations.push({
          element: (el.cloneNode(false) as Element).outerHTML,
          reason: `Disallowed native event attribute: "${attr.name}"`,
        })
        break
      }

      // Block inline iframe document injection
      if (name === 'srcdoc') {
        violations.push({
          element: (el.cloneNode(false) as Element).outerHTML,
          reason: 'Disallowed attribute: "srcdoc"',
        })
        break
      }

      // Block dangerous URL schemes
      if (URL_ATTRS.has(name) || name.endsWith(':href')) {
        const normalizedValue = normalizeUrl(attr.value)
        const matchedScheme = DANGEROUS_SCHEMES.find((scheme) => normalizedValue.startsWith(scheme))

        if (matchedScheme) {
          violations.push({
            element: (el.cloneNode(false) as Element).outerHTML,
            reason: `Dangerous scheme "${matchedScheme}" detected in attribute "${attr.name}"`,
          })
          break
        }
      }
    }
  }

  return violations
}

/**
 * Reports whether a `b-trigger` value is malformed.
 *
 * A value is valid only when it is a non-empty string of semicolon-separated
 * `event:action` pairs, each with a non-empty key and value after trimming,
 * and no duplicate keys. Returns `true` **only** for invalid values: non-string
 * input, no declarations, a declaration without a `:`, an empty key or value,
 * or a duplicate key.
 *
 * Kept local (not derived from the html.schemas.ts data) so the browser
 * controller bundle pulls in no ajv/css-tree.
 */
export const isInvalidTrigger = (data: unknown): boolean => {
  if (!isTypeOf<string>(data, 'string')) return true
  const declarations = data.split(';').filter(Boolean)
  if (!declarations.length) return true
  const seen = new Set<string>()
  for (const decl of declarations) {
    const colonIndex = decl.indexOf(':')
    if (colonIndex === -1) return true
    const key = decl.slice(0, colonIndex).trim()
    const value = decl.slice(colonIndex + 1).trim()
    if (!key || !value) return true
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

/** Options passed to the built-in WS carrier. */
export type WebSocketTransportOptions = {
  /**
   * Registers a teardown callback with the controller's disconnect set so a
   * pending reconnect timer is cleared on pagehide (preserving the pre-seam
   * teardown semantics). Defaults to a no-op for non-controller callers.
   */
  registerDisconnect?: (disconnect: Disconnect) => void
}

export class WebSocketTransport implements Transport {
  #url: string
  #socket: WebSocket | undefined
  #queue: string[] = []
  #retryCount = 0
  #messageHandlers = new Set<(message: ServerMessage) => void>()
  #statusHandlers = new Set<(event: TransportEvent) => void>()
  #registerDisconnect: (disconnect: Disconnect) => void

  constructor(url: string, options: WebSocketTransportOptions = {}) {
    this.#url = url
    this.#registerDisconnect = options.registerDisconnect ?? (() => {})
    this.#connect()
  }

  send(message: ClientMessage): void {
    const onOpen = () => {
      for (const msg of this.#queue) this.#socket?.send(msg)
      this.#queue = []
      this.#socket?.removeEventListener('open', onOpen)
    }
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message))
      return
    }
    this.#queue.push(JSON.stringify(message))
    if (!this.#socket) this.#connect()
    this.#socket?.addEventListener('open', onOpen)
  }

  onMessage(handler: (message: ServerMessage) => void): Disconnect {
    this.#messageHandlers.add(handler)
    return () => {
      this.#messageHandlers.delete(handler)
    }
  }

  onStatus(handler: (event: TransportEvent) => void): Disconnect {
    this.#statusHandlers.add(handler)
    return () => {
      this.#statusHandlers.delete(handler)
    }
  }

  #connect(): void {
    this.#closeSocket(this.#socket)
    this.#socket = new WebSocket(this.#url)
    this.#socket.addEventListener('open', this.#onSocketEvent)
    this.#socket.addEventListener('message', this.#onSocketEvent)
    this.#socket.addEventListener('error', this.#onSocketEvent)
    this.#socket.addEventListener('close', this.#onSocketEvent)
  }

  #onSocketEvent = (event: Event): void => {
    try {
      const target = event.target
      if (!(target instanceof WebSocket)) {
        throw new WebSocketError(`WebSocket listener received event without WebSocket target`, {
          cause: {
            eventType: event.type,
            socketUrl: target instanceof WebSocket ? target.url : null,
            socketReadyState: target instanceof WebSocket ? target.readyState : null,
          },
        })
      }
      if (target !== this.#socket) return
      if (event.type === 'open') {
        this.#retryCount = 0
        for (const msg of this.#queue) this.#socket?.send(msg)
        this.#queue = []
        this.#socket.removeEventListener('open', this.#onSocketEvent)
        return
      }
      if (event instanceof MessageEvent) {
        this.#handleMessage(event)
        return
      }
      if (event instanceof CloseEvent && UI_CORE_RETRY_STATUS_CODES.has(event.code)) this.#retry()
      if (event.type === 'error') {
        throw new WebSocketError(`WebSocket error on ${target.url} (readyState: ${target.readyState})`, {
          cause: {
            eventType: event.type,
            socketUrl: target instanceof WebSocket ? target.url : null,
            socketReadyState: target instanceof WebSocket ? target.readyState : null,
          },
        })
      }
    } catch (err) {
      const error = err instanceof Error ? err : new WebSocketError('page listener error', { cause: err })
      this.#emitError(error)
    }
  }

  #handleMessage(event: MessageEvent): void {
    let parsed: ServerMessage
    try {
      parsed = JSON.parse(String(event.data)) as ServerMessage
    } catch (err) {
      const error = err instanceof Error ? err : new WebSocketMessageError('web socket listener error', { cause: err })
      this.#emitError(error)
      return
    }
    for (const handler of this.#messageHandlers) handler(parsed)
  }

  #retry(): void {
    this.#closeSocket(this.#socket)
    if (this.#retryCount >= UI_CORE_MAX_RETRIES) return
    const maxDelay = Math.min(9_999, 1_000 * 2 ** this.#retryCount)
    const id = setTimeout(() => this.#connect(), Math.floor(Math.random() * maxDelay))
    this.#registerDisconnect(() => clearTimeout(id))
    this.#retryCount++
  }

  #closeSocket(socket?: WebSocket): void {
    if (!socket) return
    this.#socket = undefined
    socket.removeEventListener('open', this.#onSocketEvent)
    socket.removeEventListener('message', this.#onSocketEvent)
    socket.removeEventListener('error', this.#onSocketEvent)
    socket.removeEventListener('close', this.#onSocketEvent)
    if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close()
  }

  #emitError(error: Error): void {
    for (const handler of this.#statusHandlers) handler({ type: 'error', error })
  }
}

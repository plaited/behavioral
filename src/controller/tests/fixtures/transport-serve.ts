/**
 * Fixture server for the transport-seam spec.
 *
 * Serves a single page that installs an in-memory `window.__transport` (a real
 * second carrier — not a FakeWebSocket, not a WebSocket) and loads a bundled
 * controller constructed with `{ transport: window.__transport }`. No WebSocket
 * server is needed: outgoing ClientMessages land on `transport.send`; incoming
 * ServerMessages are pushed through `transport.__deliver`.
 *
 * The page exposes:
 *   - `window.__transport.sent`   — ClientMessage[] captured from `send`.
 *   - `window.__transport.__deliver(message)` — push a ServerMessage in.
 *   - `window.__controller`      — the constructed Controller instance.
 */

const FIXTURES_DIR = import.meta.dir
const TRANSPORT_ROUTE = '/.behavioral/transport-connect.js'
const VIRTUAL_ENTRY = '/.behavioral/transport-connect.ts'

/**
 * Bundles the controller runtime with a transport-injecting entry: constructs
 * `new Controller({ transport: window.__transport })` and connects. Mirrors
 * `bundleController`'s build-to-Response pattern (gzipped, browser target).
 */
const bundleTransportController = async () => {
  const controllerEntry = Bun.resolveSync('../../controller.ts', FIXTURES_DIR)
  const entrySource = `
import { Controller } from ${JSON.stringify(controllerEntry)}

const controller = new Controller({ transport: window.__transport })
window.__controller = controller
controller.connect()
`
  const { outputs, logs, success } = await Bun.build({
    entrypoints: [VIRTUAL_ENTRY],
    files: { [VIRTUAL_ENTRY]: entrySource },
    minify: true,
    target: 'browser',
  })
  if (!success) {
    throw new AggregateError(logs, 'Failed to build transport-injected controller')
  }
  const artifact = outputs[0]!
  const content = await artifact.text()
  const compressed = Bun.gzipSync(content)
  return {
    [TRANSPORT_ROUTE]: new Response(compressed as BodyInit, {
      headers: new Headers({ 'content-type': artifact.type, 'content-encoding': 'gzip' }),
    }),
  }
}

// The in-page transport: an in-memory carrier implementing the Transport
// contract. Installed before the connect module so the controller can read it
// at construction. `__deliver` / `__status` are test hooks for pushing inbound
// traffic; `sent` is the test hook for reading outbound traffic.
const IN_PAGE_TRANSPORT = `
<script>
  window.__transport = (function () {
    var sent = []
    var messageHandlers = new Set()
    var statusHandlers = new Set()
    return {
      sent: sent,
      send: function (msg) { sent.push(msg) },
      onMessage: function (h) { messageHandlers.add(h); return function () { messageHandlers.delete(h) } },
      onStatus: function (h) { statusHandlers.add(h); return function () { statusHandlers.delete(h) } },
      __deliver: function (msg) { messageHandlers.forEach(function (h) { h(msg) }) },
      __status: function (e) { statusHandlers.forEach(function (h) { h(e) }) }
    }
  })()
  window.__transportReady = true
</script>`

const HTML_TRANSPORT_PAGE = `<!DOCTYPE html><html><head>${IN_PAGE_TRANSPORT}</head><body>
  <div b-target="main"><p id="initial">initial</p></div>
  <button id="transport-btn" b-trigger="click:do_thing">Go</button>
  <script type="module" src="${TRANSPORT_ROUTE}"></script>
</body></html>`

/** Handle to a running transport fixture server. */
export type TransportFixtureServer = {
  port: number
  stop: () => Promise<void>
}

/**
 * Start the transport fixture HTTP server on the given port (0 picks a free
 * port). Serves `/transport.html` and the bundled transport-injected
 * controller module.
 */
export const startTransportServer = async (port = 0): Promise<TransportFixtureServer> => {
  const routes = await bundleTransportController()
  const server = Bun.serve({
    port,
    routes: {
      '/health': new Response('OK'),
      '/transport.html': new Response(HTML_TRANSPORT_PAGE, { headers: { 'Content-Type': 'text/html' } }),
      [TRANSPORT_ROUTE]: () => routes[TRANSPORT_ROUTE]!.clone(),
    },
    fetch() {
      return new Response('Not Found', { status: 404 })
    },
  })
  return {
    port: server.port!,
    stop: async () => {
      server.stop(true)
    },
  }
}

if (import.meta.main) {
  const fixture = await startTransportServer(3458)
  console.log(`Transport fixture listening on http://localhost:${fixture.port}`)
}

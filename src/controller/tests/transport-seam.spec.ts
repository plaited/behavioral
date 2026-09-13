/**
 * Transport seam spec (RED).
 *
 * Single observable interface: the {@link Controller} running on a real web
 * page with an injected in-memory {@link Transport} carrier (a real second
 * carrier — not a FakeWebSocket, not a WebSocket). Follows the controller.spec
 * harness: spawn `bunx @playwright/cli --browser=chromium`, load a serve
 * fixture, construct the Controller in-page.
 *
 * RED before the seam: `ControllerConstructorArgs` has no `transport` option,
 * so the type-level assertion below fails `tsc`, and the in-page controller
 * ignores the injected transport (uses WebSocket) — so `transport.send` is
 * never called and `transport.__deliver` reaches no registered handler. After
 * the seam, the controller delegates `#send` to `transport.send`, registers
 * `onMessage`/`onStatus`, and the default-WS path is byte-for-byte unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ControllerConstructorArgs, Transport } from '../controller.types.ts'
import { startTransportServer } from './fixtures/transport-serve.ts'

// RED until the seam: ControllerConstructorArgs must accept an injected
// transport. `Transport` is not exported today → tsc TS2305; the conditional
// type resolves to `false` so assigning `true` is tsc TS2322. Both resolve
// once the seam lands. Type-only — erased at runtime.
type _AssertTransportArg = ControllerConstructorArgs extends { transport?: Transport } ? true : false
const _assertTransportArg: _AssertTransportArg = true
void _assertTransportArg

let port = 0
const SESSION = 'transport-seam'
const BROWSER_NOT_OPEN = `The browser '${SESSION}' is not open`
const BROWSER = '--browser=chromium'

const runCli = async (...args: string[]) => {
  const proc = Bun.spawn(['bunx', '@playwright/cli', `-s=${SESSION}`, ...args], { stdout: 'pipe', stderr: 'pipe' })
  setTimeout(() => proc.kill(), 60_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return `${stdout}${stderr}`.trim()
}

const cli = async (...args: string[]) => {
  const first = await runCli(...args)
  if (first.includes(BROWSER_NOT_OPEN) && args[0] !== 'open' && args[0] !== 'close') {
    await runCli('open', BROWSER)
    return runCli(...args)
  }
  return first
}

const parseResult = (output: string) => {
  const match = output.match(/### Result\n([\s\S]*?)(?:\n### |$)/)
  if (!match) return { ok: false as const, value: undefined }
  const raw = (match[1] ?? '').trim()
  if (raw === '') return { ok: true as const, value: undefined }
  try {
    return { ok: true as const, value: JSON.parse(raw) }
  } catch {
    return { ok: true as const, value: raw }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const evalJs = async (expr: string) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const out = await cli('eval', expr)
    const result = parseResult(out)
    if (result.ok) return result.value
    await sleep(200)
  }
  throw new Error(`evalJs: CLI returned no result after 5 attempts: ${expr}`)
}

const waitFor = async <T>(read: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (value === undefined && Date.now() < deadline) {
    await sleep(50)
    value = await read()
  }
  if (value === undefined) throw new Error('Timed out waiting for browser state.')
  return value
}

const goto = async (path: string) => {
  await cli('goto', `http://localhost:${port}${path}`)
  // Wait for the in-page transport to be installed (before the connect module).
  await waitFor(async () => {
    const ready = await evalJs('() => window.__transportReady === true ? true : undefined')
    return ready === true ? true : undefined
  }, 8_000)
  // Wait for the controller to be constructed (the bundle sets window.__controller).
  await waitFor(async () => {
    const controller = await evalJs('() => window.__controller ? true : undefined')
    return controller === true ? true : undefined
  }, 8_000)
}

let server: Awaited<ReturnType<typeof startTransportServer>> | undefined

beforeAll(async () => {
  server = await startTransportServer(0)
  port = server.port
  await cli('open', BROWSER)
}, 30000)

afterAll(async () => {
  try {
    await runCli('close')
  } catch {
    // ignore
  }
  if (server) {
    await server.stop()
    server = undefined
  }
}, 15000)

describe('controller: injectable transport seam', () => {
  test('constructs and accepts the injected transport', async () => {
    await goto('/transport.html')
    const controller = await waitFor(async () => {
      const ok = await evalJs('() => window.__controller instanceof Object ? true : undefined')
      return ok === true ? true : undefined
    })
    expect(controller).toBe(true)
    // The controller must hold the injected transport, not have opened a WebSocket.
    const usesTransport = await evalJs(
      '() => (window.__transport && window.__transport.sent !== undefined) ? true : false',
    )
    expect(usesTransport).toBe(true)
  }, 20_000)

  test('outgoing: a b-trigger delivers a ClientMessage to transport.send', async () => {
    await goto('/transport.html')
    // Click the b-trigger button; its handler emits a ui_event via #send,
    // which must delegate to transport.send (not a WebSocket).
    await evalJs('() => document.getElementById("transport-btn").click()')
    const sent = await waitFor(async () => {
      const messages = await evalJs(
        '() => window.__transport && window.__transport.sent ? window.__transport.sent : []',
      )
      const uiEvents = Array.isArray(messages) ? messages.filter((m: { type?: string }) => m?.type === 'ui_event') : []
      return uiEvents.length > 0 ? uiEvents : undefined
    }, 5_000)
    expect(Array.isArray(sent)).toBe(true)
    expect(sent.length).toBeGreaterThan(0)
    const first = sent[0] as { type?: string; detail?: { event?: { type?: string } } }
    expect(first.type).toBe('ui_event')
    expect(first.detail?.event?.type).toBe('do_thing')
  }, 20_000)

  test('incoming: a ServerMessage via transport.__deliver applies to the DOM', async () => {
    await goto('/transport.html')
    // Push a render ServerMessage through the transport's incoming registration.
    await evalJs(
      '() => window.__transport.__deliver({ type: "render", detail: { id: "r1", target: "main", html: "<p id=\\"injected\\">injected via transport</p>", swap: "innerHTML" } })',
    )
    const text = await waitFor(async () => {
      const t = await evalJs('() => document.getElementById("injected")?.textContent')
      return t && t !== 'undefined' ? t : undefined
    }, 5_000)
    expect(text).toContain('injected via transport')
  }, 20_000)
})

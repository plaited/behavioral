# UI Layer — Controller and html tools

Reference for an agent assisting an engineer in wiring up the UI layer of a
behavioral app. There are two surfaces, both driven by a
[behavioral program](./behavioral.md)'s `selection` listeners (the action
channel):

- **Browser `Controller`** — applies `render`/`attrs` (plus
  `dispatch_custom_event`/`navigate`/`scale_check`) to a **live DOM** over a
  WebSocket.
- **Stateless html tools** — apply `render`/`attrs` to an **HTML string** in
  memory, in a Bun process (SSR).

There is **no `Renderer` class** — SSR is stateless html-in / html-out tools.
The two surfaces share the same `render`/`attrs` vocabulary; the substrate
(live DOM vs string) is the variable.

## Browser Controller

`Controller` is exported via the `@behavioral/sh/controller` package export
(re-exported from `src/controller/controller.ts`). Construct one instance per
page, loaded as an async module script in `<head>`:

```ts
import { Controller } from '@behavioral/sh/controller'
```

The constructor takes lifecycle hooks and optional extensions:

```ts
new Controller({
  extensions,            // optional Map<string, ControllerExtension>
  onPageReveal,          // page reveal callback
  onPageSwap,            // page swap callback
  onPageHide,            // pagehide callback
  onPageShow,            // pageshow callback
})
```

### The push model

This is the load-bearing concept: a behavioral page is **push-based**, not
pull-based. The controller does not fetch state and render client-side; it
opens a WebSocket to its serving agent and applies server-pushed messages:

| Server → browser (`CONTROLLER_INCOMING_MESSAGE_TYPES`) | What the Controller does |
|----------------------------------------------------------|---------------------------|
| `render` | Apply HTML to `[b-target]` elements per the `swap` mode |
| `attrs` | Set/remove attributes on `[b-target]` elements |
| `dispatch_custom_event` | Fire a `CustomEvent` on the target |
| `navigate` | Navigate the page (URL change) |
| `scale_check` | Resolve the effective `b-scale` for a target and reply with `scale_check_result` |

User interactions and page lifecycle emit messages back to the agent:

| Browser → agent (`CONTROLLER_OUTGOING_MESSAGE_TYPES`) | When |
|---------------------------------------------------------|------|
| `ui_event` | A `b-trigger` declaration fired (DOM event → BP event with `getAttributes` detail) |
| `snapshot` | A page lifecycle event (`pagereveal`/`pageswap`/`pagehide`/`pageshow`) — serialized HTML via `getHTML({ serializableShadowRoots: true })` |
| `success` | A server message was applied successfully (carries the request `id`) |
| `error` | A message handler threw (carries `name`, `error`, `stack`, `id`) |
| `scale_check_result` | Reply to a `scale_check` message (carries `effectiveScale`) |
| `form_submit` | A `b-form` form POST completed |

The agent — running a behavioral program — is the source of truth for what
the page shows; the Controller is the DOM applier.

## Server-side html (the floors + classifier story)

The compiled SSR html tools are **retired** (HTMLRewriter was Bun-only, dead
in both target hosts; the ICL conversion removed the fleet). What survives:

- **Deterministic floors** — `isInvalidTrigger` / `detectXssVectors`
  (`src/controller/controller.utils.ts`): hardcoded invariants (empty
  b-trigger = invalid, the semicolon grammar, on*/scheme vectors) that run
  in every host, browser included, with no ajv/css-tree in the bundle.
- **Schemas as data** — `src/controller/html.schemas.ts` + `css.schemas.ts`:
  pure JSON-schema data (the classifier's context, not compiled validators).
- **The classifier ceiling** — the System One/Jev gate story:
  
  — probabilistic admission over the schema context, with the floors as the
  deterministic backstop. Probabilistic gates never own security invariants.

## When to use which

- **Wiring a multi-page app**: one `Controller` per page, constructed in the
  page's `<head>` async module. The WebSocket URL is derived from the page's
  origin (`location.href.replace(/^http/, 'ws')`).
- **Binding interactive elements**: declare `b-trigger` and `b-form`
  attributes in the DOM; the Controller wires them to emit `ui_event`
  messages on user interaction. No manual `addEventListener` in your code.
- **Page lifecycle**: the `onPage*` hooks fire on `pagereveal`/`pageswap`/
  `pagehide`/`pageshow`. The browser owns document-bound teardown (listeners,
  sockets, timers) on unload and bfcache freeze; the Controller does **not**
  force-close the socket on `pagehide` so a queued snapshot can flush during
  teardown.
- **SSR / pre-render**: a behavioral-program `selection` listener calls the
  html tools directly to produce an HTML string for an initial page load or
  snapshot — see [html](../../behavioral-tools/references/html.md) for the tool
  surface.
- **Scale pre-flight**: the agent sends `scale_check` (browser) or calls
  `html-scale-check` (SSR) to learn the effective `b-scale` a render target
  lives in before generating content.

## A common wiring mistake to avoid

Calling `Controller` methods directly to mutate the DOM. The Controller is a
**message applier**, not a DOM API — `render`/`attrs`/`dispatch_custom_event`/
`navigate` arrive as server-pushed messages and are dispatched internally,
not called by your code. If you find yourself reaching for a Controller method
to change the page, the correct path is to emit a `ui_event` (via a
`b-trigger`/`b-form` declaration) and let the agent's behavioral program
respond with a server-pushed `render`. The DOM is downstream of the agent,
not the other way around.

The second common mistake: expecting the WebSocket to be manually managed.
The Controller handles connect, retry (with bounded backoff on codes 1006/
1012/1013, max 3 retries), and message queuing during disconnect internally.
Do not wrap it in your own reconnection logic — that duplicates the built-in
faculty and races with the Controller's own retry.

## See also

- [behavioral](./behavioral.md) — the runtime whose `selection` listeners
  drive both surfaces (the action channel).
- [html](../../behavioral-tools/references/html.md) — the SSR tool surface:
  I/O contracts, dispatch examples, gotchas.

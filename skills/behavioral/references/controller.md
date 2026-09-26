# UI Layer — the Controller

Reference for an agent assisting an engineer in wiring up the UI layer of a
behavioral app. The live surface is the browser **`Controller`** — it applies
`ui_*` wire messages to a **live DOM** over a WebSocket (or an injected
`Transport`). It is driven by a [behavioral program](./behavioral.md)'s
`selection` listeners (the action channel).

The compiled SSR html tools are **retired** (the ICL conversion removed the
fleet). There is **no `Renderer` class** and no server-side html surface — the
`ui_*` vocabulary's server side is emitted by the agent's behavioral program,
and its browser side is the Controller below.

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
  transport,             // optional injected Transport (default: built-in WebSocket carrier)
})
```

### The push model

This is the load-bearing concept: a behavioral page is **push-based**, not
pull-based. The controller does not fetch state and render client-side; it
opens a carrier to its serving agent and applies server-pushed `ui_*`
messages:

| Agent → browser (`CONTROLLER_INCOMING_MESSAGE_TYPES`) | What the Controller does |
|-------------------------------------------------------|--------------------------|
| `ui_render` | Apply HTML to `[b-target]` elements per the `swap` mode |
| `ui_attrs` | Set/remove attributes on `[b-target]` elements |
| `ui_dispatch_custom_event` | Fire a `CustomEvent` on the target |
| `ui_navigate` | Navigate the page (URL change) |
| `ui_scale_check` | Resolve the effective `b-scale` for a target and reply with `ui_scale_check_result` |

User interactions and page lifecycle emit `ui_*` messages back to the agent:

| Browser → agent (`CONTROLLER_OUTGOING_MESSAGE_TYPES`) | When |
|-------------------------------------------------------|------|
| `ui_event` | A `b-trigger` declaration fired (DOM event → BP event with `getAttributes` detail) |
| `ui_snapshot` | A page lifecycle event (`pagereveal`/`pageswap`/`pagehide`/`pageshow`) — serialized HTML via `getHTML({ serializableShadowRoots: true })` |
| `ui_success` | A server message was applied successfully (carries the request `id`) |
| `ui_error` | A message handler threw (carries `name`, `error`, `stack`, `id`) |
| `ui_scale_check_result` | Reply to a `ui_scale_check` message (carries `effectiveScale`) |
| `ui_form_submit` | A `b-form` form POST completed |

The agent — running a behavioral program — is the source of truth for what
the page shows; the Controller is the DOM applier.

The kind names are `keyMirror` constants in
`src/controller/controller.constants.ts`
(`CONTROLLER_INCOMING_MESSAGE_TYPES` / `CONTROLLER_OUTGOING_MESSAGE_TYPES`).

### The schema home

`CONTROLLER_DETAIL_SCHEMAS` (`src/controller/controller.schemas.ts`) maps
every `ui_*` kind to its AJV detail schema — the guard/reflection home. The
host threads import it (`validateControllerDetail`) to gate controller
messages at the composition boundary. The browser bundle **never** carries
the compiled validators — it ships only the deterministic floors below.

### The floors + classifier story

What keeps the wire safe across every host:

- **Deterministic floors** — `isInvalidTrigger` / `detectXssVectors`
  (`src/controller/controller.utils.ts`): hardcoded invariants (empty
  b-trigger = invalid, the semicolon grammar, on*/scheme vectors) that run
  in every host, browser included, with no ajv/css-tree in the bundle.
- **Schemas as data** — `src/controller/html.schemas.ts` + `css.schemas.ts`:
  pure JSON-schema data (the classifier's context, not compiled validators).
- **The classifier ceiling** — the System One/Jev gate story:
  probabilistic admission over the schema context, with the floors as the
  deterministic backstop. Probabilistic gates never own security invariants.

## The ui_* producer threads

Nothing above emits `ui_*` on the agent side by itself — the view-generation
policy is composition threads: `src/cli/ui-threads.ts`, mounted by `bProgram`
when shell + store + systemTwo are all on (absent systemTwo there is no
generation lane and the threads don't mount). The initial set is the thin
vertical — ingress `ui_event` → scale preflight → generation → `ui_render` —
refined by the autoresearch loop, not by argument.

### The design tenant (DESIGN.md → store)

At boot a scan recipe (the shell faculty's `run` op, the SKILL.md
fence-slicing + `YAML.parse` contract) reads the USER'S `<home>/DESIGN.md` —
[Google's DESIGN.md format](https://github.com/google-labs-code/design.md):
YAML frontmatter token groups plus `##` prose sections — and lands it in the
store as the `design` collection's `context` value:
`{ tokens, sections, warnings }` (warnings-as-data). **The no-lock contract**:
the shipped asset (`skills/behavioral/assets/DESIGN.md`) is an init-copied
seed only — the runtime never reads the asset, never re-syncs it; a user who
edits, replaces, or deletes their home file fully controls (or removes) their
design context. The design lane is an optional input, never a gate: with no
tenant (or a null-tokens tenant) generation proceeds plain and still produces
a conforming `ui_render`.

Consumption is lenient per the format's consumer table: unknown frontmatter
groups and section headings ride verbatim; the spec-named groups
(`colors`/`typography`/`rounded`/`spacing`) validate by shape with a bad
group dropping to a warning; a duplicate `##` section heading rejects the
file (tokens and sections null, the rejection riding the warnings). A missing
`DESIGN.md` is not an error — no tenant, no warnings.

## Wiring guidance

- **Wiring a multi-page app**: one `Controller` per page, constructed in the
  page's `<head>` async module. The default carrier derives the WebSocket URL
  from the page's origin (`location.href.replace(/^http/, 'ws')`); pass
  `transport` to inject a different one.
- **Binding interactive elements**: declare `b-trigger` and `b-form`
  attributes in the DOM; the Controller wires them to emit `ui_event`
  messages on user interaction. No manual `addEventListener` in your code.
- **Page lifecycle**: the `onPage*` hooks fire on `pagereveal`/`pageswap`/
  `pagehide`/`pageshow`. The browser owns document-bound teardown (listeners,
  sockets, timers) on unload and bfcache freeze; the Controller does **not**
  force-close the socket on `pagehide` so a queued snapshot can flush during
  teardown.
- **Scale pre-flight**: the agent sends `ui_scale_check` before generating
  content to learn the effective `b-scale` a render target lives in; the
  Controller replies with `ui_scale_check_result` carrying `effectiveScale`.

## A common wiring mistake to avoid

Calling `Controller` methods directly to mutate the DOM. The Controller is a
**message applier**, not a DOM API — `ui_render`/`ui_attrs`/
`ui_dispatch_custom_event`/`ui_navigate` arrive as server-pushed messages and
are dispatched internally, not called by your code. If you find yourself
reaching for a Controller method to change the page, the correct path is to
emit a `ui_event` (via a `b-trigger`/`b-form` declaration) and let the
agent's behavioral program respond with a server-pushed `ui_render`. The DOM
is downstream of the agent, not the other way around.

The second common mistake: expecting the WebSocket to be manually managed.
The Controller handles connect, retry (bounded backoff on close codes
1006/1012/1013 — max 3 attempts, jittered exponential delay capped at
`UI_CORE_MAX_RETRIES` in `controller.constants.ts`), and message queuing
during disconnect (the queue flushes on reconnect) internally. Do not wrap it
in your own reconnection logic — that races with the Controller's built-in
retry.

## See also

- [behavioral](./behavioral.md) — the runtime whose `selection` listeners
  drive the agent side of the `ui_*` wire (the action channel).
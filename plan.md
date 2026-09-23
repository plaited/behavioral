# Behavioral Agent Harness

A minimal behavioral-programming agent runtime. The engine is in-process;
capability families run as processes behind one behavioral wire; hosts drive the
runtime through an egress/ingress vocabulary, and validation is threads.

## Current State

The runtime, config, observability, and IPC host are landed.

- **Composition** — `src/cli/b-program.ts` (`bProgram`): the
  in-process engine + frontier, the four capability families (shell, store,
  responses, mcp) spawned per space, a `behaviors` allow-list, and shell/store
  overrides. `start()` flushes the deferred pack mounts after subscribers
  attach; `trigger` admits events only; `terminate` kills every family it
  invoked. The process primitive is `useBehavior` (`src/behaviors/use-behavior.ts`).
- **Public surface** — `src/behaviors.ts` (package export `./behaviors`): the
  `Behavior` union, the wire types + schemas/validators, the override thread packs
  (`shellThreads`, `mcpThreads`), and `useBehavior` — what a `config.ts` imports.
  (`behaviorsThreads`, the root guard pack, is internal.)
- **Config & home** — `behavioralHome()` (`src/behaviors/behavioral-home.ts`) is
  the single `.behavioral` root, overridable by `BEHAVIORAL_HOME`.
  `loadConfig()` (`src/cli/load-config.ts`) loads `<home>/config.ts` — executable
  TS carrying the `behaviors` array and `useBehavior(...)` overrides — and fails
  fast with the path on an invalid shape.
- **Observability** — `src/cli/trace-consumer.ts`: one deterministic redaction
  pass (declared secret values, sensitive field names, known credential shapes)
  → a JSONL log under `<home>/traces` plus an egress sink. The engine emits an
  `idle` trace on quiescence (no candidates, not deadlocked) — the settle signal.
- **IPC host** — `src/cli/serve.ts` + `src/cli/json-rpc.ts`: the `serve`
  subcommand. Line-framed JSON-RPC over stdio; ingress `ui_*`/`trigger` become
  triggers, `ui_*` selections become client notifications (egress-as-selection),
  redacted traces flow out as `trace` notifications.
- **Controller contract** — `src/controller/controller.types.ts` holds the `ui_*`
  vocabulary and the `ClientMessage`/`ServerMessage` unions. The AJV detail
  schemas live beside them in `src/controller/controller.schemas.ts` (a separate
  file, so the browser bundle never pulls AJV): `CONTROLLER_DETAIL_SCHEMAS` keyed
  by the message-type constants, `validateControllerDetail(type, detail)`.
- **Validation** — threads, not the host or controller. `src/behaviors/behaviors.threads.ts`
  is the composition's root pack: a guard thread `block`s every controller
  message whose detail does not conform to its schema (`detailMatch: false`),
  both directions. The reject is visible in the `frontier`/`pending_bids` traces;
  the controller and the JSON-RPC codec stay dumb.

## Next

**The interface pack — the `ui_*` producers.** Nothing emits `ui_*` yet, so the
guard and the serve egress path are inert. Sketch before building:

1. Ingress → egress: which `ui_event` / `ui_snapshot` / `ui_form_submit` / … produce
   which `ui_render` / `ui_attrs` / `ui_navigate` / … requests (view-generation policy).
2. `ui_scale_check` → `ui_render`: a fixed two-step preflight, or policy.
3. Snapshot rehydration.
4. CLI `--schema input|output` reflection from `CONTROLLER_DETAIL_SCHEMAS`.

## Open Questions

- **Where the interface pack lives** — the root pack (`behaviors.threads.ts`,
  always mounted) vs a family-scoped pack (e.g. a `ui.threads.ts`).
- **How much view-generation policy is thread-authored vs model-authored** — the
  fixed routes vs the agent composing `ui_*` requests itself.

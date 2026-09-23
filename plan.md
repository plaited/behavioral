# Behavioral Agent Harness

A minimal behavioral-programming agent runtime. The engine is in-process;
capability families run as processes behind one behavioral wire; hosts drive the
runtime through an egress/ingress vocabulary, and validation is threads.

## Current State

The runtime, config, observability, and IPC host are landed.

- **Composition** — `src/cli/b-program.ts` (`bProgram`): the
  in-process engine + frontier, the default capability families (shell, store,
  mcp) spawned per space, a `behaviors` allow-list, and the override families
  (`shell`, `store`, `systemOne`, `systemTwo`). `start()` flushes the deferred
  pack mounts after subscribers attach; `trigger` admits events only;
  `terminate` kills every family it invoked. The process primitive is
  `useBehavior` (`src/behaviors/use-behavior.ts`): it takes a family's event
  schemas, compiles them, and returns them so the composition derives a guard
  thread (a malformed family message is blocked, visible in traces).
- **System families** — `system-two/behavior.ts` (Open Responses; the bundled
  provider entry) and `system-one/behavior.ts` (TypeSafe/OpenRouter Decisions;
  429/529 retry). Each is a provider entry: `configSystemTwo(respond)` /
  `configSystemOne(respond)` owns the wire plumbing, and `useSystemTwo({ endpoints })`
  / `useSystemOne({ endpoint })` is the host helper that seeds the endpoint via
  environment data and wires `useBehavior`. No defaults — `bProgram` takes them
  as overrides; absent means no process and no route.
- **Public surface** — `src/behaviors.ts` (package export `./behaviors`): the
  `Behavior` union, the wire types + schemas/validators, the override thread packs
  (`shellThreads`, `mcpThreads`), the System One/Two config surface, and
  `useBehavior` — what a `config.ts` imports. (`behaviorsThreads`, the root guard
  pack, is internal.)
- **Config & home** — `behavioralHome()` (`src/behaviors/behavioral-home.ts`) is
  the single `.behavioral` root, overridable by `BEHAVIORAL_HOME`.
  `loadConfig()` (`src/cli/load-config.ts`) loads `<home>/config.ts` — executable
  TS carrying the `behaviors` array and `useBehavior(...)` overrides — and fails
  fast with the path on an invalid shape. `behavioral init` (`src/cli/init.ts`)
  generates that config: interactive tour by default at a TTY (injectable `ask`
  collector, driven end-to-end through a real PTY), or agent JSON via the
  framework command; absent families default on (TypeSafe + OpenAI urls),
  api keys ride as env-var-name references that fail fast, and optional
  provider scaffolding lands under `<home>/providers/` wired via `entry`.
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

## Decision Log

### 2026-09-23 — the import/config story and the init command
- **Resolution/B** — the GLOBAL INSTALL is the import story. `bun add -g @behavioral/sh`
  (user) or `bun link` (dev) puts the `behavioral` bin on PATH AND makes
  `@behavioral/sh/behaviors` importable from anywhere — Bun's resolver falls
  back to `~/.bun/install/global/node_modules` when a file's own walk finds
  nothing. Verified empirically: a bare import from a `~/.behavioral`-path file
  failed pre-link and resolved post-link. No self-contained global home, no
  baked absolute import paths.
- **Secrets/A** — generated configs reference env var NAMES
  (`apiKey: process.env.<NAME>`), never literals; load fails fast with the var
  name if the family needs it and it is unset. `Bun.secrets`/keychain stays a
  possible second resolver (a discriminated `apiKey` union) — not v1.
- **Custom providers/A** — generated provider entries live under
  `<home>/providers/`; the `entry` passed to `useSystemOne`/`useSystemTwo` must
  resolve against the home (absolute), not the spawn cwd (`src/behaviors`).
  Prerequisite slice: entry absolutization + a temp-home custom-entry test.
- **init/A** — a `behavioral init` command generates `<home>/config.ts`
  (interactive or `--json`), env-name secrets, and optionally scaffolds provider
  entries. The interface pack keeps its `Next` slot; init's ordering vs it is
  the pilot's call.

### 2026-09-23 — result-lane visibility: the pump re-enters, the guard rejects
- **Division/A** — the `useBehavior` pump discards only what cannot be this
  lane's event (non-JSON, non-object payloads, any type other than the
  family's result kind). Schema validity of the detail is the family guard's
  job: a parsed-but-invalid result re-enters as an engine event and is blocked
  visibly (frontier/pending_bids/deadlock) instead of vanishing.
- **Lane seal preserved/B** — the old full-schema pump gate was replaced by a
  type-const gate, not removed: a family process still cannot inject
  request/cancel events into its own or another family's lane. The full-schema
  check had conflated the seal with detail validity.
- **Note** — bProgram mounts guards only for the systemOne/systemTwo overrides
  today; shell/store/mcp results that are schema-invalid re-enter and appear
  as selected events (visible, unmatched) rather than guard-blocked. Mounting
  guards for the default families is the natural follow-up if wanted.

### 2026-09-23 — init: interactive default, no --interactive flag
- **Shape/B** — `behavioral init` with no input at a TTY runs the prompt tour;
  JSON positional or piped stdin is the agent path (the framework's existing
  stdin convention). `--interactive` was cut: it forced the tour onto piped
  stdin, which both collides with the JSON path and races readline (lines
  arriving between questions are dropped — observed as a hang).
- **Testability/A** — the collector takes an injectable `ask` (scripted in the
  specs; the defaulting contract lives in the collector, not the wrapper); the
  isTTY branch is proven by an e2e that spawns the real CLI behind a PTY
  (`Bun.spawn` `terminal` option) and answers each rendered prompt.

## Open Questions

- **Sequencing** — the interface pack (`ui_*` producers) is next up; guard
  mounts for the default families (shell/store/mcp) are an optional
  follow-up.
- **Where the interface pack lives** — the root pack (`behaviors.threads.ts`,
  always mounted) vs a family-scoped pack (e.g. a `ui.threads.ts`).
- **How much view-generation policy is thread-authored vs model-authored** — the
  fixed routes vs the agent composing `ui_*` requests itself.
- **Where the interface pack lives** — the root pack (`behaviors.threads.ts`,
  always mounted) vs a family-scoped pack (e.g. a `ui.threads.ts`).
- **How much view-generation policy is thread-authored vs model-authored** — the
  fixed routes vs the agent composing `ui_*` requests itself.

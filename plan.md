# Behavioral Agent Harness

A **minimal behavioral kernel meant to be improved.** The agent ships with an
irreducible coordination floor — the behavioral engine (`behavioral()`) plus the
agent loop (turn cycle, stop condition, compaction gate, tool dispatch bridge;
Phase 1) — and almost no policy rules. Improvement happens by composing plugins:
everything above the kernel is a plugin (`plugin.json`), and the agent grows as
behaviors (threads + handlers), tools, and skills are added to or removed from a
space. The self-improving loop (Phase 5.5) is the agent authoring candidate
behaviors/skills, verifying them, and promoting them into a space — which is
plugin mutation, observed and gated. This is the neuro-symbolic harness from
`research/talk-self-improving-agents-from-behavioral-exhaust.md`: neural
generation proposes, symbolic verification disposes, and the exhaust is the
teacher.

**Fixed floor vs. improvable surface:** the engine + the Phase 1 agent loop are
the kernel and are NOT removable plugins — without them there is no turn cycle,
no spec-event streaming, no tool dispatch. A space that could eject the turn loop
would brick the agent. The *behavioral policy* layer (guards, conventions,
space-local behaviors, skills) is minimal and improvable; the *loop machinery*
is the stable floor beneath it.

Built on the in-repo behavioral runtime (`src/behavioral/behavioral.ts`, the
BP engine: data-threads, super-step scheduler, trace union). No pi SDK. No
TUI. No ACP (deferred). The agent is a `behavioral` CLI command
(`bin/behavioral.ts`); the dev client is pi's `!`/`!!` shell escapes;
validation is Bun test.

## Current State

The agent runs a turn end-to-end. The tools surface is complete; the kernel
floor exists; the daemon model is dropped in favor of cold invocation + gated
ingress + a plugin-shipped behavior surface.

- **Tools (`src/tools/`) — landed, all `useTool` units.** File tools (`read`,
  `bash`, `edit`, `write`, `grep`, `find`, `ls`), frontier tools
  (`frontier-replay`/`frontier-explore`/`frontier-verify`), html tools
  (`html-validate-and-escape`, `html-validate-attribute-value`, `html-render`,
  `html-update-attributes`, `html-scale-check`), and the Open Responses
  endpoint tools (`model-respond`, `model-compact`). Shared byte-accurate
  `truncate.ts`. `open-responses.schemas.ts` is the spec vocabulary (the
  daemon-era `useResponse`/`Adapter` seam is deleted).
- **Discovery (`src/tools/`) — landed, dormant pending Slice F.** `mcp-client`
  (7 modes), `skill-client` (3 modes), `discovery` (SQLite CRUD+search,
  provisioner-injected `dbPath`). Built, tested, not yet wired into
  provisioning. Pool + v2 keychain OAuth live in `src/kernel/`.
- **Kernel (`src/kernel/`) — landed.** `kernel.ts` (`createKernel`: pool,
  `dispatch` bridge, `runTurn`, shutdown-drains-pool), `dispatch.ts`
  (function_call → tool → `function_call_output`, `call_id`-correlated via
  `ueid()`, errors as data), `oauth/` (keychain + v2 provider), `threads.ts`
  (the scaffolding turn-loop thread, MINIMAL — moves into the default plugin
  once plugin-loading lands, Q3/C).
- **CLI — landed.** `behavioral turn '{"space","prompt"}'` runs a turn cold and
  prints JSON (deterministic against the scripted model seam — the Harbor /
  autoresearch seam). No daemon, no TUI.
- **Harbor tasks (`tasks/`) — landed.** Two skill-authoring tasks
  (`build-git-context-skill`, `build-typescript-lsp-skill`) for the
  autoresearch loop; agent authors + installs an AgentSkills skill at
  `.agents/skills/<name>`, verifier recomputes truth from fixtures → fractional
  `reward.json`. Validated on docker + Daytona.
- **Skills — consolidating.** `skills/` → single `behavioral` skill (Q2).
  `.agents/skills` is a symlink to `skills/`.
- **Decisions this session (2026-09-07, see Decision Log):** no daemon + gated
  ingress (Q1); default plugin ships one `behavioral` skill (Q2); threads are
  a first-class plugin component under `threads/` + `extensions."sh.behavioral"`
  (Q3); skill gating default-allow host-side (Q4); generative-UI dev server
  (Q5); space = project folder, isolation invariant (Q6). Phase 6 rewritten to
  cold invocation + gated ingress + dev server.
- **Decisions this session (2026-09-12, see Decision Log + the Desktop/Rust
  decision map in Open Questions):** finish the TS agent first; Rust conversion
  dead as a general plan (Rust lives only in the Tauri shell/relay, and someday
  the atproto client logic); desktop = Tauri app — the eventual atproto client —
  with the controller dropping WebSockets entirely for Tauri IPC (transport
  seam refactor charted; implementation parked behind TS-first); daemon stays
  dead (cold-per-turn, mid-turn stdin triggers); deployed-headless parked as
  the server-side complement (Workers/DO or containers, TS-native either way).
  The atproto pack stays deferred with its "future GUI" trigger now named.
- **Landed (2026-09-18): step/StepTrace + in-engine transforms — GREEN.**
  `step()` is public (super-steps emit StepTrace; trigger marks ingress).
  Transforms execute in-engine: jq-wasm `first()` via `evaluateTransform`
  (errors-as-data: jq_error | no_detail | empty_output |
  non_object_output → `transform_error` trace, target never fires);
  re-entry via addThread + the trailing step(). 141/141 behavioral tests,
  zero tsc errors in src/behavioral.
- **Landed (2026-09-18, uncommitted-to-committed): API + worker-shape refactor.**
  `useAddThread(space)(args)` is dead — `addThread(args)` with `space` on the
  `Thread` itself (schema + type). `instanceId` kept as auto-ueid per
  instantiation (merged multi-worker streams + reference-trace integrity are
  the retained value; caller injection removed as the daemon artifact).
  `evaluateTransform` lives in `jq.ts` alone (library; SAB nested worker entry
  is the bridge slice); `behavioral.utils` is wasm-free so frontier tools no
  longer load jq.wasm at init. Worker entry: `src/workers/behavioral.ts`
  (postMessage traces, onmessage {trigger|addThreads|step}). All 10 spec
  files migrated (135 usages).
  **`src/workers/use-behavioral.ts` is an empty stub — the client slice is
  next.** **src/kernel is decided for RECODE (see Decision Log) — its red tsc
  and stale API usage are reference, not work items. Do not patch it.**
- **Landed (2026-09-18): the jq worker bridge.** `jq.ts` IS the eval worker
  (spawned by URL, never imported); `evaluateTransform` in `behavioral.utils`
  spawns it per eval, blocks on `Atomics.wait` (sync syscall — the
  engine-never-awaits invariant holds), and `terminate()`s at timeout.
  Never-terminating queries are now `jq_timeout` errors-as-data — the last
  silent-forever failure mode in the engine is dead. `output_too_large`
  guards the 64KB shared-buffer cap. 143/143 behavioral tests (12 transform
  tests, TDD red→green). MINIMAL: spawn-per-eval — upgrade path is a
  pre-warmed pool of one. Works Bun main-thread and inside the engine
  worker (webview) with the same SAB protocol.
- **In-flight / next:** (0) **Controller transport seam — LANDED
  2026-09-13** (red 1b32de04 + green 9f306044; see Decision Log 2026-09-13
  "Transport seam landed"). Remaining transport-workstream tasks, in order
  (reordered 2026-09-13, see Decision Log "Bun.WebView swap pulled
  forward"): (1) **Bun.WebView harness swap — LANDED 2026-09-13** (see
  Decision Log "Bun.WebView harness landed on the chrome backend";
  commits d2d025ca + e7905525): both browser specs green under Bun.WebView,
  @playwright/cli removed, the seam's runtime green delivered — the
  seam-landing open item (browser specs never ran green) is resolved.
  Then (2) Tauri IPC carrier — NEXT
  (`@tauri-apps/api`: invoke/Channel/listen), then (3) WS removal +
  serve-fixture rewrite (in-memory transport — now smaller, harness
  stable), then (4) the desktop-carrier integration test (in-repo
  Unix-socket bridge + minimal Rust stub relay). The seam-landing open
  item (browser specs never ran green in this env) resolves via task (1),
  not an env fix — fixing the Playwright env would be throwaway work
  against a harness already scheduled for replacement. The autoresearch loop
  itself has left this repo (the 2026-09-17 extraction decision, below) — its
  in-repo prerequisite list is superseded; see Q8/E. What remains in-repo:
  the transport workstream above, then the public-event ingress registry
  (Q1/B), Slice F (provision discovery primitives), and the dev server (Q5).
- **Known pre-existing test failures (not from recent work):** controller
  specs — **resolved 2026-09-13** by the Bun.WebView harness swap
  (d2d025ca; the sharper diagnosis: `@playwright/cli open` crashed as a
  daemon under Node 26, failures at browser-launch, not import/build). The
  `match-listener.spec.ts:596` `prefixItems` failure is **resolved** — it was
  an AJV strict-mode tuple-compile rejection (bare `prefixItems` without
  `minItems`/`maxItems` disambiguates to `add_thread_error`, so the consumer
  thread was rejected wholesale, not a runtime matching bug as previously
  guessed). Fix: close the tuple with `minItems`/`maxItems`.
- **Known flake (documented 2026-09-17, fix deferred):** `shell.spec.ts` —
  "the line cap group-kills a flooding command at maxLines" intermittently
  times out at bun-test's 5s default **under full-suite load only**; the
  isolated spec is green. The test's internal race budget is 2s, and the
  group-kill + reap of a `while true` flooding process stalls past the
  outer 5s timeout when the whole suite contends. Untouched pre-existing
  `src/workers/shell` code — no product bug is suspected (the kill does
  resolve; it is a timing race between the flood and the kill under load).
  Fix when next in `src/workers/`: likely raise the test's explicit timeout
  or assert the kill result rather than racing the flood.


## Decision Log

### 2026-09-19 — html-tool consolidation committed: schemas as data in the controller; the fleet is 13

- **The pilot's consolidation, completed and committed:** html.schemas.ts
  + css.schemas.ts moved to src/controller/ as PURE SCHEMA DATA (no ajv,
  no validation functions — validatePTrigger/validateAttribute/
  validateCSSValue deleted with the move); the html fleet tools deleted
  entirely (they rode HTMLRewriter, a Bun-only global — dead code in both
  target hosts); fleet 18 -> 13 (mcp-client 7, plugin-client 1,
  skill-client 5). cli/tools.ts registrations removed; tools.spec
  re-homed onto skill-*; AGENTS.md synced.
- **The generator follows the new shape:** scripts/css-schemas/generate.ts
  emits schema-only output (one exported CSSPropertiesSchema object, no
  imports); run.ts points at src/controller/css.schemas.ts; the diff-mode
  acceptance test pins byte-stability (changed:false, exit 0) — the CI
  drift workflow enforces it. 757 properties, 141 keyword enums.
- **The going-forward pattern (in prompts/html-classifier-gate.md, the
  bun-tools skill now points there instead of html tools):** (1) schemas
  as data in the controller — floors vocabulary + classifier context,
  regenerated never hand-edited; (2) deterministic hardcoded floors —
  isInvalidTrigger, detectXssVectors, id-correlated errors; (3) the
  System One classifier above them reading the schema context, judging
  runtime-generated html. No gate threads, no fleet html tools.
- **Standing gap (Phase 0 decision item):** attrs-path on*/scheme checks
  have no deterministic guard since the thread gate deletion —
  #attrs validates b-trigger only. Recommendation on record: mirror the
  lean rules into #attrs.

### 2026-09-19 — src/threads/html.ts DELETED — threads were scaffolding; the classifier is the validator

- **The pilot's reveal — the point of the whole work:** consumers of
  useWorkers (local PWA, Tauri mobile) run everything in one context and
  GENERATE html at runtime. The attrs-gate threads were not the
  destination. html.ts + its spec deleted (9/9-green scaffolding — the
  gate pattern, complementary detailSchemas, the transform mechanics
  stay as reference in git history if thread gates ever return).
- **The design:** a System One classifier (Jev-class) receives the
  SCHEMA DATA as context — css.schemas.ts + html.schemas.ts minus the
  validation functions (validatePTrigger/validateAttribute/
  validateCSSValue are code, not context) — and classifies whether the
  generated html is valid, before it reaches the controller. The
  controller floors just landed (isInvalidTrigger, detectXssVectors)
  are the deterministic backstop. Floor/ceiling doctrine unchanged:
  the classifier never owns a security invariant.
- **GAP OPENED BY THE DELETION (flagged, awaiting pilot):** the attrs
  path lost its deterministic on*/scheme/style guard — the thread gate
  was the only block on attrs-carried onclick / javascript: href /
  expression() in style. Controller #attrs checks b-trigger only;
  detectXssVectors runs render-path only. Recommended: mirror the lean
  rules into #attrs as hardcoded floors (the prompt's Phase 0 decision
  item). UNTIL RULED: attrs-carried inline handlers pass unopposed.
- prompts/html-classifier-gate.md REWRITTEN around the new center:
  schemas-as-classifier-context assembly (derived from source schemas,
  versioned, functions never cross the boundary), the classification
  call (response_request with structured noul/choice/score questions),
  correction loop via type-2 rewriter, store admission as the second
  call site, offline story for iOS/PWA. AGENTS src/threads/ bullet
  removed (dir back to empty stakes).

### 2026-09-19 — pilot reverts the render-time scale error-back; scale_check preflight is the pattern

- The pilot reverted ScaleMismatchError, the ERROR_TYPES entry, the
  RenderMessage `scale?` field, and the #render check (4 files). Ruling:
  `scale_check` already exists as a preflight — threads compose the
  check before rendering and pick the variant; nothing render-time.
  Navigator cleaned the residue: the scale error-back browser tests +
  fixture removed; the html thread relay's `scale` passthrough field
  removed (consumer-less — the relay schema is structure + correlation
  only; scale handling is thread-side preflight).
- **isInvalidTrigger vs validatePTrigger — one divergence surfaced for
  the pilot's ruling:** everything matches (split ';', colon required,
  non-empty key/value, duplicate keys rejected), EXCEPT empty/whitespace
  b-trigger: validatePTrigger (the fleet tool's AJV keyword, documented
  "Empty/whitespace strings are valid (no triggers)") says VALID;
  isInvalidTrigger (the controller floor, unit-tested deliberately as
  invalid) says INVALID — a fragment with b-trigger="" passes
  html-validate-and-escape but is refused at the browser floor: the two
  validation homes disagree. Also #bindTriggers treats empty as a no-op
  skip (harmless). Recommendation: empty = valid everywhere (one
  rulebook, matches runtime no-op semantics); pilot to rule.

  **RULED (same turn): empty b-trigger = INVALID, everywhere.** The
  controller floor's strictness was the intent; the rulebook flipped to
  match — validatePTrigger now rejects empty/whitespace strings (docstring
  updated; one-line change, TDD: the 'accepts empty string' test flipped
  to reject-first RED, then green). A fragment carrying b-trigger="" now
  fails html-validate-and-escape AND is refused at the controller render
  floor — the two homes agree. Absent attribute (undefined) remains valid;
  #bindTriggers at initial page load still no-op-skips empty (the floor
  guards pushed renders only).

### 2026-09-19 — html/controller slice landed (TDD, worktree, uncommitted)

- **Cycle 0 — b-meta removed completely:** parseMeta/stringifyMeta/
  extractBMetaBlock + the script[b-meta] rewriter handler + the three
  meta tools gone (html.ts 1150 -> 894 lines); meta.schema.ts deleted;
  html.schemas [B_META] gone; fleet 21 -> 18 (verified live); skill docs
  + AGENTS synced; the behavioral "parseMeta pattern" comments reworded
  to "the two-guards pattern". html-validate-and-escape is deliberately
  looser: script[type=application/json] is no longer specially validated
  (the OKF data-okf-* vocabulary replaces it later).
- **Cycles 1-2 — pilot's implementations confirmed end-to-end:** the
  pilot's WIP commit already carried the semicolon split (#bindTriggers),
  isInvalidTrigger (render floor + attrs-path rejection), detectXssVectors,
  and three error classes (render_invalid_trigger,
  update_trigger_attribute, xss_vectors_detected). Browser-path
  confirmation tests added: two-pair semicolon b-trigger binds both
  pairs; malformed b-trigger render rejected + never swapped in; on*
  fragment rejected + never swapped in; malformed attrs b-trigger
  rejected + element unchanged. All green against the real-browser
  harness with id correlation.
- **Cycles 3-4 — scale error-back (implemented, TDD):** RenderMessage
  detail gains optional `scale`; #render computes the target's effective
  scale (the #scaleCheck closest rule, strictest non-rel) and rejects
  mismatched renders with `scale_mismatch` (new ERROR_TYPES entry +
  ScaleMismatchError) carrying requested + effective; no swap. Matched
  renders swap normally. Lessons: getElementById returns null not
  undefined for absent elements (a test-assertion bug cost three debug
  cycles); fixture double-render invalidated a residual-text assertion
  (assert absence of the rejected fragment, not leftover text).
- **Classifier prompt delivered:** prompts/html-classifier-gate.md —
  the auto-research prompt for the probabilistic ceiling: floor/ceiling
  invariant (Phase 0 pins it with an offline test), provider research
  for iOS/PWA (System One/Jev-class vs local models; graceful
  degradation), the admission thread composing store put with a
  classification (draft -> stable, errors-as-data, classifier outage =
  pending not pass), the type-2 correction loop, model routing. Open
  decisions flagged: classification result embedded (data-okf-*) vs
  ledger; stable-promotion vs git export.
- **AGENTS.md:** src/controller/ bullet updated (validation-free relay +
  hardcoded floors); src/threads/ bullet added (gate threads + the host
  route-table law).

### 2026-09-19 — controller slice rulings (pilot) + the OKF-HTML north star

- **Rulings on the consensus points:** (1) b-trigger separator is
  SEMICOLON — controller's #bindTriggers moves from space-split to ';',
  unifying with validatePTrigger (no rulebook fork, no leaf extraction —
  validation stays a controller private method, #validateTriggers, pilot's
  stub). (2) b-meta is REMOVED completely this pass (pilot deleted the
  constant; the removal sweeps html.schemas [B_META], meta.schema.ts,
  parseMeta/stringifyMeta/extractBMetaBlock in html.ts, the three meta
  fleet tools + specs + skill docs; fleet 21 -> 18). (3) #validateTriggers
  also serves the attrs-path b-trigger updates. (4) Two new ERROR_TYPES:
  scale_mismatch + fragment_invariant (on* and malformed b-trigger share
  the remediation class; message text distinguishes). Implementation-review
  flags on the pilot's draft, fixed during the cycles: the on* scan must
  scope to template.content (not document — a whole-page scan would block
  all renders forever); #performSwap needs the message id threaded through
  for error correlation.
- **OKF-HTML north star (NOT this pass):** one semantic HTML fragment =
  knowledge representation + LLM context + UI (zero translation tax);
  data-okf-* attributes + rel/href microdata for semantics; SQLite (the
  store worker) as storage + FTS5 index for canonical OKF-HTML fragments;
  git-authored okf/ folder synced into the store (matches the 2026-09-17
  growth-model law: git authority, db as regenerable index); agent
  self-edits fragments back into the store. Adaptation notes: the store
  needs FTS as a store op (deferred-ops lane); html-templates collection
  becomes okf_fragments; BMeta's draft/stable lifecycle is superseded by
  data-okf-status attributes — the b-meta removal above is its first step.

### 2026-09-19 — git + typescript fleet tools deleted; the fleet is 21

- **Pilot's ruling, on the analysis + TS7 research.** git.ts (4 tools):
  structure-over-stable-porcelain that modern models compose directly
  through the tools shell worker (one `tool_call` script replaces
  git-context; fleet tools are reached THROUGH the shell anyway). 
  typescript.ts (2 tools): rode `typescript/unstable/*` — a surface
  Microsoft replaces with a new API in 7.1 (Nov 24, 2026); nothing depends
  on it before then, and a TS LSP satellite (long-lived `tsc --lsp --stdio`
  session, standard LSP, own event family) is the right rebuild shape when
  a consumer exists. Users needing either get there via skills or threads
  instructing shell/LSP usage — not compiled fleet tools.
- **CLI spec re-homed:** the git/typescript-backed tests (schema
  addressing, invocation, dry-run, reject-path) moved onto surviving
  tools (skill-read, skill-discover, html-validate-and-escape). One test
  died without a subject: input-defaults-at-dispatch (no surviving tool
  declares an input default) — returns when one does.
- **AGENTS.md corrected:** fleet count was stale (said 29; live was 27
  before this cut, 21 after).


### 2026-09-19 — process layer moves to src/workers/; useBehavioral → useWorkers

- **Pilot's call, verified against the import graph and executed.** The wire's
  consumers were already majority-workers (6 of 9 importers); behavioral/ held
  two process entries plus the jq spawn bridge — the process layer was smeared
  across both dirs. After the move: `src/behavioral/` is the pure language
  (types, constants, utils, interpreter core, internal jq subprocess);
  `src/workers/` is the entire process layer (wire home, engine entry, router,
  four satellite families). Dependency arrow is one-way: workers → behavioral.
- **Move rule (settled, non-ad-hoc):** a process file lives in `src/workers/`
  iff something outside behavioral/ speaks its wire. The engine entry and the
  satellites qualify; `jq.worker.ts` does not (engine-internal SAB frames, no
  request/result family) — it stays in behavioral/ with its spawner.
- **Naming per repo convention:** `workers.types.ts` / `workers.constants.ts`
  (the wire + kind registry), `use-workers.ts` (`useWorkers` — matches the
  settled `workers` map param). The engine-transport envelope types
  (`WorkerMessage`/`AddThreadsMessage`/`TriggerMessage`) moved to the wire home
  too, so the pure layer holds zero wire references.
- **The rename hit at its cheapest window:** the router had exactly one
  importer (its spec). After the turn-loop proof and Tauri hosts exist, the
  name would be baked into every host.

### 2026-09-19 — `src/kernel/threads.ts` deleted; the kernel directory is no more

- **Pilot deleted the last kernel file** — resolving the fold-vs-move question
  as neither: the turn-loop thread is **authored raw** against the new worker
  event wire, not ported. The old material (createReentryThread,
  `TURN_LOOP_THREAD` speaking `user.prompt`/`model.respond`/`turn.end`) lives
  in git history if authoring needs a reference. The proof is now entirely
  greenfield: thread-authoring surface decisions + `TURN_LOOP_THREAD` on the
  tools/responses/store wire.

### 2026-09-19 — `src/tools/discovery.ts` deleted; the catalog becomes store-tenant authoring

- **Q: re-cut discovery onto the store now? A: no — delete it.** The fleet tool
  was a red zombie (its only import was the deleted kernel, breaking the whole
  CLI fleet at boot), its writer died with the kernel (reconcile scan), and its
  persistence role is superseded by the store worker. The catalog *semantics*
  (kinds ∈ mcp-tool|skill|thread|html, unified rows, search) are consumed by
  nothing today; they become **values authored in store collections** when
  autoresearch — the first real consumer — arrives (the 2026-09-17 read-model
  framing holds; only the implementation moves to the store family). Fleet
  34 → 29; CLI registrations, skill references, and AGENTS.md synced.

### 2026-09-19 — Store worker: fourth family, envelope-first (schema deferred to the worker)

- **Q: ship the store port before the sqlite schema is final? A: yes — envelope
  final, payloads loose.** The store is its own worker family like responses and
  frontier: `store_request` / `store_request_result` events, `detail =
  { id, op, input }` with **`op ∈ put | get | delete | query`** (enum-constrained
  at the schema — an op outside the enum dies at the trust boundary), space
  echo on results, `worker_error` on crash, **no cancel** (ops are short-lived).
  The strict input grammar, the sqlite schema, migrations, and FTS live inside
  the worker — **schema churn never becomes protocol churn.** (Grammar notes:
  `query` must allow an empty filter — collection-wide enumeration — and
  `delete` is keyed-only; purge/bulk/subscribe are deferred ops until a consumer
  exists. Engine super-steps are sync and the worker's queue is ordered, so
  read-modify-write is safe and no atomic-increment op is needed.)
- **Q: threads persisted to the db? A: no — the 2026-09-17 growth-model decision
  holds.** Authority stays files+git (`space/threads/`, `space/html/`; git history
  is the learning log); the store holds **regenerable index + non-authority
  durable data** — run counters, budget ledgers, the discovery catalog as its
  first namespace/tenant. The store never becomes the learning surface.
- **Storage-agnostic rule: only JSON ops cross the wire — no SQL, no expressions.**
  `query` stays collection-scoped (filter object, never joins — joins happen
  inside the worker if the catalog ever wants them); values are JSON only. This
  is what keeps backings swappable per host: CLI = `bun:sqlite` WAL, Tauri =
  sql.js or a Rust-side engine, browser embed = IndexedDB — same wire, no
  redesign. Discovery's `src/tools/discovery.ts` re-cut rides along: catalog
  tables + the dead reconcile scan become this worker's namespace, retiring the
  deleted-kernel import (the file's only error) and its per-call open/close
  MINIMAL.
- **Boundary floor carried forward now, not deferred:** space identity is
  provisioner-injected, never agent-supplied — no path/dbKey/host fields in any
  op input; rows are space-scoped at the worker boundary (discovery's rule,
  generalized).
- **Landed same day (TDD, uncommitted):** the `workers` map param is settled —
  `useBehavioral({ threads, traceListener, workers: { tools, responses, frontier?, store? },
  useTrigger })`, family keys are the crash-event names too. The store family is implemented:
  `store.worker.ts` (bun:sqlite WAL, one owned connection, version-stamped migrations,
  space-stamped rows with the root default, per-op `additionalProperties: false` inputs so
  space/host keys die at the boundary, shallow-field `query` filter with empty-filter
  enumeration, errors-as-data, `:memory:` via `STORE_DB_PATH_KEY` for hermetic spawns,
  file-persistence-across-respawn proven incl. WAL recovery) + `store.types.ts` (seeding key,
  op input/result shapes) + 15 worker tests, 5 vocabulary tests, 1 router round-trip on the
  real worker. Discovered the hard way: `bun:sqlite` `.get()` returns **null** (not undefined)
  for no rows.
- **Core-finalization sequence agreed (navigator + pilot):** (1) `workers`-map
  param → (2) store worker v1 (KV + catalog tenant, MINIMAL) → (3) thread-authoring
  surface decisions (raw events vs `src/threads/` factories; id-minting
  convention; model-input sourcing) → (4) `TURN_LOOP_THREAD` re-cut as the
  proof artifact — the core is final when the first real program thread runs a
  full turn on the new wire. Autoresearch threads build after the proof.

### 2026-09-18 — Responses-client family; compaction is a direct-fetch tool; spec-alignment verdicts

- **Renames:** `use-model.ts` → `use-responses-client.ts`, `model.ts` →
  `responses-client.ts` (files named by role: the client of the Open Responses
  API). `model.schemas.ts` → back to `open-responses.schemas.ts` (the pilot's
  rename fixed a stray-`l` typo; schemas are named for the spec, clients for
  the role). `model.types.ts` keeps its name — the wire-protocol types module
  (flag: rename to match the family if the drift starts to bite). Test files
  renamed to match their modules.
- **Compaction REMOVED (2026-09-18, same session):** the extraction above
  lasted one session. Verdict chain: `/responses/compact` IS spec (HTTP path
  in the canonical OpenAPI + compliance suite, not WebSocket-scoped as first
  believed) and IS deployed (OpenAI first-party — Codex's backbone; xAI;
  LiteLLM/Vercel/Bifrost gateways) — but NO local inference server supports
  it (llama.cpp/Ollama/LM Studio ❌; vLLM mainline ❌, PR #56970 open,
  merge-dirty). This harness targets **local inference**, so the client was
  dead code against every provisioable endpoint. Decisive rationale:
  **context management is client-side by architecture** — threads implement
  RLM (alexzhang13.github.io/blog/2025/rlm/) with our tooling, and
  distillation/compaction is just an ordinary `/responses` call the thread
  makes; html tooling stores context/memory/knowledge. Removed:
  `src/tools/compaction-client.ts` + spec + fixture route + analyzer oracle.
  Kept: `CompactionItemSchema` in the output item union (spec output
  vocabulary — servers may emit compaction items in-stream). Re-add trigger
  (greppable): a local server ships `/responses/compact` (e.g. vLLM PR #56970
  merging).
- **Spec-alignment review (canonical schema:
  github.com/openresponses/openresponses `schema/`):**
  - **`ReasoningEffort` IS spec** (superseded same session — see the
    filter-manifest discovery below: the RAW component file
    `ReasoningEffortEnum.json` reads
    `none|minimal|low|medium|high|xhigh`, but the published/filtered spec
    drops `minimal`; the param itself, `reasoning.effort`, remains spec). The
    prose page's `#reasoning` anchor only describes reasoning *items*, which
    is why it read as non-spec. Verdict corrected; doc'd with spec provenance,
    and the type moved to its spec home (`open-responses.schemas.ts`).
  - **`/responses/compact` IS spec** (`schema/paths/responses.compact.json`;
  body: `model` required, `input`/`prompt_cache_key` optional).
    **`prompt_cache_key` IS spec** (CreateResponseBody too).
  - **Fixed drift:** `OpenResponsesRequestSchema.model` was an object
    `{provider, modelId}` — non-spec (spec: plain string). Now a string;
    `provider` is documented as this repo's client-side provisioning
    vocabulary that never crosses the wire. `CompactionItemSchema` required
    `status` — spec `CompactionBody` requires only `type|id|encrypted_content`
    (the prose's "every item has id/type/status" conflicts with the normative
    schema; schema wins). Status now optional, extras tolerated loosely.
    Fixture's compaction item got its spec `id`.
  - **Filter-manifest discovery (corrects the earlier verdict):** the spec is
    OpenAI's OpenAPI **filtered** — `openapi_filter_manifest.yaml` + additive
    patches → the PUBLISHED openapi.json at openresponses.org is the normative
    machine artifact. The published `ReasoningEffortEnum` is
    `none|low|medium|high|xhigh` — OpenAI's `minimal` is explicitly dropped;
    `user`/`conversation`/`prompt_cache_retention` are denied from
    CreateResponseBody. Our enum had `minimal` (non-spec) — fixed.
  - **Loose-declare + passthrough enum pattern:** `reasoningEffort` is an
    `anyOf` — first branch declares the spec enum (visible in `--schema`
    output), second branch is a non-empty passthrough string, so non-conformant
    / superset endpoints accept their own values (e.g. OpenAI-only `minimal`)
    through the named field. Rationale: effort support is model-dependent and
    the endpoint is the authority; the spec blesses superset implementers;
    errors come back as data. TS idiom: `ReasoningEffort | (string & {})`.
  - **Arg passthrough landed:** `ModelRespondInput` carries
    `[key: string]: unknown`; the worker's `buildRespondBody` forwards every
    non-named key verbatim (named mappings win collisions). Spec params we
    don't name (`prompt_cache_key`, `temperature`, `previous_response_id`, …)
    and endpoint extensions flow through without being coded. Args never
    reconfigure the endpoint (url/apiKey in args are inert body data).
  - **Analyzer oracle switched** to the published openapi.json snapshot
    (139KB, specs/open-responses/openapi.json) — the raw repo components
    (unfiltered OpenAI source) were the wrong oracle and hid the `minimal`
    filter.
  - **The audit tooling was session-temp — deleted after the audit** (same
    session): `specs/` snapshots + `scripts/analyze-open-responses-spec.ts`
    are gone, never committed. The repo vendors no external specs (same rule
    as MCP/AgentSkills). The durable record is this log + the spec-provenance
    comments in `open-responses.schemas.ts` + the tests (they encode the
    contract). Re-audit on a future spec version = fetch the published
    openapi.json for that version and diff the field/enum lists — the
    published-artifact-not-raw-components principle above is the thing to
    remember.
  - **Confirmed aligned:** `truncation`, `instructions`, `stream`, `tools`
    (function subset), `Error {code, message}` (spec Error.json requires
    exactly those), usage, item status enums, stream events (strict known
    union + lax unknown-passthrough matches the spec's extension rules).

### 2026-09-18 — Transforms execute in-engine via sync jq-wasm; `first()` + errors-as-data

- **jq-wasm** (owenthereal v3, real jq 1.8.2 via Emscripten, no native deps, Bun
  OK): `const jq = await loadJq()` once at `behavioral.ts` module scope (TLA);
  all evaluation synchronous. Replaces the two-phase prime/execute trace
  contract — the TransformTrace demotes from contract-for-external-executor to
  record-of-what-the-engine-did. Kills: `createTransformLoop`-style consumers,
  the prime-once pool discipline, every `Bun.sleep` race, the jq-on-PATH
  portability bug, and the kernel's future chore of implementing the loop.
- **`jq.first(detail, query)` through a one-place errors-as-data wrapper**
  (`evaluateTransform`): runs the whole program, returns the whole first output,
  parsed. Failure paths → traced, never thrown: `JqError` (carries
  stderr/exitCode/query), empty output (`undefined`), non-object output
  (`detail` must be JsonObject). New trace kind `transform_error`; target event
  never fires on failure (errors-as-data like `trigger_error`/`add_thread_error`).
  `raw()` rejected: never-throws is half-true — it moves the throw to a
  contentless `JSON.parse` (pretty-print, multi-output). `stream()` rejected
  (lazy iterator, no final object). Async API rejected: promise-wrapped sync
  wasm, no timeout protection anyway.
- **Async engine rejected; "the engine never awaits" is now a named invariant.**
  The sync chain is what makes reentrancy safe without locks (every trigger
  runs atomically; concurrent I/O completions queue on the microtask queue),
  keeps traces totally ordered and reproducible, and preserves
  trigger-returns-processed. Async lives only at the kernel boundary (chain-end
  + bridge re-entry). If transforms ever need true async (model-mediated), the
  home is the bridge, not the scheduler.
- **Re-entry needs no kick:** `nextStep` evaluates after resume, adds the target
  once-thread via `useAddThread(space)`; the trailing `step()` in `nextStep`
  picks it up — request-origin, same chain. Multi-output queries take the first
  output (v1: one transformer = one target event; multi-output fan-out is a
  later decision).
- Pathological queries (`def f: f; f`) hang the sync engine — accepted with a
  MINIMAL comment: sync calls can't be time-bounded; blast radius is a
  user-promoted thread hanging their own run (git-authority + promotion gate are
  the trust boundary). Upgrade path: worker-isolated jq (reintroduces async —
  accept-for-now).
- `frontier.ts` is a pure simulation (never drives the engine, zero awaits) that
  already models transform listeners; to stay truthful for transform-bearing
  threads it imports the same jq handle — gate determinism preserved by
  composition.

### 2026-09-18 — `step` is the public super-step primitive; StepTrace is the record

- The engine exports `step()` (the super-step scheduler) as public API; every
  super-step emits a first-class trace message (`TRACE_MESSAGE_KINDS.step`,
  `StepTrace`: step number + optional `ingress: true`). Internal continuations
  emit unmarked StepTraces; `trigger` calls `step(true)` so external ingress is
  distinguishable in the stream. The exported handle takes no ingress param —
  callers cannot fake ingress.
- **bp.step/`run()` abandoned before commit** (the pilot's first cut: synthetic
  bp.step request-thread + restricted Trigger/listener schemas). A pseudo-event
  pollutes the event vocabulary — frontier tools would special-case it. The
  step boundary is a trace message, not an event — the trace union already had
  the pattern (trigger_error, add_thread_error, interrupt, transform are
  non-event kinds). Navigator correction on record: the earlier
  recommendation to reject exported-step ("silent, unenforceable") was wrong
  on both counts — step injects nothing (only advances registered threads,
  no-ops when idle) and StepTrace makes every use observable.
- StepTrace.step aligns 1:1 with the selection traces of the same super-step
  (pre-increment stepId passed through).
- `PROGRESSIVE_DISCLOSURE_THREAD` deleted along with its spec (NOT inlined —
  pilot reversed the earlier inline-fixture plan; the subject lives in agenthub).
- Macro vocabulary (runTurn/turn.end/TurnResult/`behavioral turn`) still open
  (Q1) — `run` is not taken after all (reverted), but the word "step" now means
  the super-step unit, so the macro terminator word still needs settling.

### 2026-09-17 — Autoresearch extracted to `behavioral-agenthub` (clean break)

- The autoresearch program — the loop, Harbor evaluation, and the
  experiment infrastructure — moves OUT of this repo into a new, separate
  repo: `git@github.com:plaited/behavioral-agenthub.git` (bare repo,
  created by the pilot). Bun-native, patterned on
  `github.com/ygivenx/agenthub` (karpathy's agent-first collaboration
  platform: bare git repo + SQLite message board; agents push git
  bundles; commit-DAG queries — children/leaves/lineage/diff; channels/
  posts/replies; per-agent API keys + rate limits) with **Daytona
  sandboxes + DGX Spark** as the agent infrastructure for the skills +
  threads program.
- Rationale (from the 09-13 evaluation, now decided): the loop targets
  behavioral itself, so in-repo experiments risk candidate churn in the
  harness's history and product gates applying to research scratch; the
  loop must consume **behavioral-as-artifact** (CLI/package seam), not
  behavioral-as-source-tree. `bun link` locally during development.
- **Skill-reference doc split (docs follow the code they describe):**
  `skills/behavioral/references/autoresearch.md` MOVES to agenthub (it
  documents the loop — now agenthub's program; agenthub pulls it via the
  pinned gh ref and adapts it as its design doc; behavioral deletes it).
  `eval.md` and `frontier-analysis.md` STAY — they document behavioral's
  own primitives (`useTrace` eval capture; the frontier tools agenthub
  calls via CLI) — agenthub reads them via gh, never copies.
- **Provenance pins** (gh pinned-ref access survives later deletion here):
  - Reference loop: `plaited/behavioral` `src/kernel/autoresearch.ts` @
    `82f73a360bfe056173c97cd0958de455f02c1aea` (last touched by
    `503f6c6e`, the model-worker move).
  - Daytona sandbox wrapper history: commit `cb34ac3c` (feat(scripts):
    daytona sandbox wrapper for the autoresearch loop) — check current
    location via that commit if the file moved.
  - Harbor `tasks/` (the evaluation content) moves to agenthub.
- **In-behavioral cleanup — MOSTLY DONE (2026-09-17, pilot commits
  4ed5df56..b32512b3):** loop deleted from src/kernel (26937ef2,
  "the loop leaves for agenthub"); src/plugin/ removed (ecaeb49a);
  Harbor tasks/ removed (b32512b3 — the pinned 82f73a36 ref is now the
  only source); init reworked to home-skeleton-only (26937ef2, -1038
  lines); skill deduplicated against behavioral-tools (a7ec0846) —
  autoresearch.md removed from the skill, eval.md cross-links fixed,
  frontier-analysis.md now correctly states there is no
  `@behavioral/sh/tools` export (the CLI is the surface); deps
  @tauri-apps/cli and @daytonaio/sdk both gone from package.json;
  untracked leftovers resolved. DONE 2026-09-17: plan Q8/D + Q8/E text
  superseded (config.json models + the agenthub extraction note) and the
  stale in-repo Q8/E prerequisite list in Current State removed.
- **Seam note — RESOLVED (2026-09-17): CLI-only consumption; no package
  export needed.** `src/cli/tools.ts` already wraps the whole tool fleet
  as CLI commands named by `tool.name` (`behavioral frontierVerify
  '<json>'`, `frontierExplore`, `frontierReplay`), registered in
  `bin/behavioral.ts`, with self-describing contracts via
  `--schema input|output`. The gate is 2-3 deterministic calls per
  candidate — subprocess cost is noise vs. generation/sandboxing; the
  dispatcher's boundary AJV validates the candidate Thread for free
  (malformed -> gate schema error -> discard-not-crash). `bun link`
  exposes the `behavioral` BIN from the local working tree (no package
  imports at all). Imperative export stays a MINIMAL fallback note only.

### 2026-09-17 — Growth model: space-first `~/.behavioral/`, git as authority, discovery as the read-model

Supersedes the growth-model reading of Q3/Q7 (2026-09-09): the plugin format
stays the **distribution input** for third-party behaviors, but the agent's own
growth is a function of the space, not of plugin mutation. The distinction the
plan previously blurred — and the Agent Plugins spec itself draws — is that the
format prescribes packaging, not enablement/update/growth; client-extension
behavior is explicitly client-owned. **All `sh.behavioral` interpretation is
removed from the client**: `plugin-client` reads only the portable surface —
manifest + mcp.json conformance, `skills/` discovery, plain ungated `threads/`
component discovery, the warnings channel. Model declarations move to a
host-owned config file (below); gating is host structure + governor threads;
spaces config is gone. The annex stays the spec-sanctioned slot if third-party
behavioral-specific declarations ever need it — re-adding it later is a reader,
not a format change. The default plugin's `extensions.sh.behavioral` block
disappears entirely — the `"threads": {"include": []}` self-gating wart with
it.

**Growth is files in the space, git-tracked.** The agent learns by writing
threads and html into the space's learned dir; the autoresearch gate (Q8/F:
`frontier-verify` safety + `frontier-replay`-reaches-reference-trace usefulness)
decides keep/discard; **git history is the learning log** — diff = the review
artifact, rollback = `git revert`, "remove the governor" = `git rm` with the
reason preserved. Weighed against in-memory (evaporates at cold-per-turn exit)
and a persisted db-as-authority (no diff/review/rollback story, corruptible,
duplicates git, contradicts the discovery-store-is-regenerable rule): files+git
win decisively for the authoritative surface; memory is scratch (candidates
under evaluation); the db stays a regenerable index. In-memory objects as the
growth mechanism were rejected as no-learning-at-all for a cold agent.

**Directory pattern: space-first.** Every space — root included — is one folder
with identical structure; isolation is enforced by scoping to the space root
once, at provisioning:

```
~/.behavioral/              # USER HOME, not per-project (see below)
  config.json               # host config: models + future host settings (git-tracked)
  db.sqlite                 # gitignored; single discovery db (see below)
  root/                     # the $root space — name reserved
    threads/                # learned + governor threads (git-tracked)
    html/                    # shared-context HTML knowledge (git-tracked)
    logs/                    # gitignored; per-run turn traces, jsonl (runtime exhaust)
      archive/               # compacted/rotated runs
  <space-name>/             # identical shape per space
    threads/ html/ logs/ archive/
```

**The tree lives at `~/.behavioral` — user-level, not per-project.** Learning
follows the user across projects; spaces remain projects (Q6/A) keyed by name
in the tree. The authority model requires git history there, so **`~/.behavioral`
is initialized as its own git repository** — an idempotent `git init` +
skeleton at first provisioning (`behavioral init`) — and the learning log is
that repo's history: `threads/`, `html/`, `config.json` tracked; `db.sqlite`
and `logs/` gitignored (exhaust is data for the teacher, not the learning log).
Precedent: skill-client already scans user-level `~/.agents/skills`.
**Models are declared in `~/.behavioral/config.json`** — `{ models: [{
provider, modelId, endpointUrl, apiKeyRef, locality? }] }`, AJV-validated,
user-curated (users add models to this file directly; plugins never declare
model endpoints); the apiKeyRef-not-raw-apiKey rule moves from `sh.behavioral`
validation to this config schema.

Space-first beats per-concern trees (`threads/<space>/` etc.) because per-space
queries are the discovery store's job, not the filesystem's; every concern-tool
re-deriving the space mapping is a fresh isolation seam; and per-space history
stays atomic under one prefix. The word is **`html/`**, not `views/` — these
are agent-shared context that happens to be renderable by the dev server
(Q5's "the UI is a space the agent acts on"); name by medium, not role. The
dev server (Phase 6) serves this tree as its render surface and connects to
the trigger ingress.

**Single discovery db, provisioner-scoped.** One `~/.behavioral/db.sqlite`,
every row carrying `space` + `metadata.commitSha`. **Space identity is
provisioner-injected, never agent-supplied** — the discovery tools bind the
`space` filter server-side (no `space` field in the agent-facing input schema),
so a space agent cannot address another space's rows by construction; root is
the unscoped identity (cross-space navigation). **Governor threads are NOT
the load-bearing isolation layer** — a gate that is itself removable learned
content (the agent's own governors are learnable/removable by design) is
self-referential as access control, and no per-space governor set can see the
global space. Structure isolates (SQL-level scoping); threads govern on top
(sole-writer enforcement, surface shaping, plugin-asset gating, rate limits) —
block-at-the-event-layer, observable in the deadlock trace's candidate set,
promoted through `frontier-verify` like every learned thread (no special
casing — a pure-blocker that blocks a floor-requested event deadlocks the turn
and fails its own gate). WAL mode; contention is rare under cold-per-turn.
Weighed per-space db files (per-space blast radius, duplicated scans + a root
index-of-indexes) — worth little when the thing isolated is regenerable.

**Discovery is the navigation layer — read-model over the authority.** The
contract: **files+git are the write-path and the authority; the db is a
materialized view, regenerable, never authoritative.** New kinds join
`skill`/`mcp-tool`: `thread` and `html`, plus plugin-shipped components
(skills from installed plugins' `skills/`, their MCP servers) with a
`source: plugin` metadata marker — one search surface covers skills, threads,
html, MCP tools, and plugins. The tier loop: `discovery-search` (tier 1:
description text) → go deep on the file (tier 2: `skill-read`, shell read,
`plugin-client`) → the row's `commitSha` into `git-history` with `paths`
scoped to the artifact (tier 3: provenance — when learned, by which turn,
alongside what). Discovery answers *what/where*, files answer *what it is*,
git answers *how it got here*. **One writer: the reconcile scan** — a kernel
thread running post-turn/at-provisioning, walking `~/.behavioral/<space>/`,
`.agents/skills/`, and installed plugins, deriving rows from files +
`git log -1` per artifact, upserting via the discovery tools, deleting rows
whose files vanished. The agent never hand-writes rows (mid-turn search
missing a not-yet-committed artifact is correct — uncommitted means
unlearned). Root's scan indexes all spaces.

**Embedded metadata: the `b-meta` block (OKF vocabulary).** Thread and html
artifacts self-describe so the scan derives tier-1 rows without hand-entry.
Vocabulary borrowed from the [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
(§4/§5): `type`, `title`, `description` (the search text), `tags`,
`generated: {by, at}` (which turn/model authored), `verified: [{by, at}]`
(the **autoresearch gate writes its keep decision here** — the trust tiers
unverified → machine-confirmed → human-reviewed are exactly the promotion
ladder), `status: draft|stable|deprecated` (candidate → promoted → retired),
`stale_after`, `sources` (provenance when a page distills research). OKF is a
reference, not a dependency — we take the value families, not the bundle
format. One schema, two carriers by medium:
- **html:** `<script type="application/json" b-meta>...</script>` in `<head>`
  — inert by HTML spec, `b-meta` joins the `b-*` prefix vocabulary
  (`b-trigger`/`b-target`/`b-form`/`b-scale`/`b-meta`); `html-validate-and-escape`
  gains a locate-parse-validate rule for it; beats `<meta>` (flat key/value),
  sidecar files (breaks artifact atomicity/diff cohesion), comments (not
  queryable).
- **threads:** `export const meta: BMeta = {...}` — TS-native, type-checked
  against the same shared JSON schema, no comment-block parsing; the scan
  imports it in a worker to index. (YAML/JSON at the top of a `.ts` file is a
  syntax error — carrier split by medium, one schema.)

**No log files — git is the history.** OKF's `log.md` (§9) exists for bundles
that leave their git history behind when distributed; our corpus is
space-local and git-attached, and git is the designated learning log — a
parallel hand-maintained log.html would be drift-prone duplication of it. If
an export/share need appears, generate a log view from git at export time
(derived, never maintained). Distinct and kept: `~/.behavioral/<space>/logs/`
jsonl turn traces are runtime exhaust for the autoresearch teacher, not
history.

Consequences for prior entries: Phase 5.5's "self-improving loop is plugin
mutation, observed and gated" becomes "mutates the space's learned surface
(files + commits in the `~/.behavioral` repo), observed by git, gated by
verify+replay"; Q8/E prereq (1) "fill the default plugin's `sh.behavioral`
extension" is dropped (nothing to fill — models come from config.json, and the
manifest carries no extension block); `plugin-client` output drops
models/spaces/gating, keeping the portable surface — it is the interchange
reader, which is what its conformance was for. Open (deferred): promotion of a
proven learned behavior into a distributable plugin is a later packaging step,
not the growth mechanism.

### 2026-09-13 — Bun.WebView swap pulled forward to the next task

- The pilot pulled the Bun.WebView harness swap out of the WS-removal task
  and made it the immediate next task. Rationale: the @playwright/cli env is
  broken (daemon crash under Node 26), so an env fix is throwaway work
  against a harness already scheduled for replacement; the swap restores
  runtime verification exactly where the workstream needs it next (the
  landed seam + every subsequent carrier task touches controller.ts); and
  the swap was never technically dependent on WS removal — harness (how
  tests drive the browser) is orthogonal to carrier (what the controller
  speaks). This supersedes the "swap belongs to the WS-removal task" timing
  in the 2026-09-13 e2e-harness entry below and in the resolved e2e-driver
  OQ. The WS-removal task shrinks to carrier + fixture-transport work.
- Task shape: spike-gated. Step 1 is a time-boxed port of ONE spec path
  (navigate → click → evaluate, console capture, WS connects from
  WKWebView against the Bun.serve fixture). If the spike hits an
  experimental-API blocker, STOP and report — the fallback (fixing the
  Playwright env) is the pilot's decision, not forced. On success: port
  both spec files mechanically — `evalJs('() => expr')` becomes
  `view.evaluate('expr')` (Bun.WebView wraps scripts as `await (<script>)`,
  so arrow wrappers evaluate to functions → serialize to undefined — strip
  them); keep evaluate-based `el.click()` calls as-is for byte-for-byte
  test semantics (native `view.click(selector)` adoption is optional
  polish); audit for `type()` key-event assumptions (type() is InsertText,
  no keydown/keyup — use press()); one evaluate/click in flight at a time.
  On full green: drop the `@playwright/cli` devDep in a separate
  chore(deps) commit. Scope guard: no transport/carrier/WS changes, serve
  fixtures unchanged, controller.ts untouched unless a runtime failure
  reveals a seam bug (then a distinct minimal `fix(controller)` commit,
  reported as a finding).

### 2026-09-13 — Bun.WebView harness landed on the chrome backend

- Spike passed all four mechanics against the existing serve fixture
  (navigate/load, WKWebView→fixture WS connect, evaluate round-trip,
  console capture). Two WebKit platform findings then forced the backend
  decision, both verified with minimal standalone repros: (a) WKWebView
  maps a server-initiated close of 1012 (and 1013) to close code 1005
  (wasClean) — the controller's retry set {1006, 1012, 1013} never
  observes the close, so the retry test cannot pass on webkit; (b) WKWebView
  fires pageshow during a deferred module's top-level await (it does not
  wait for module-TLA completion the way Chromium does), so the
  controller's page listeners — registered after the connect module's
  TLA — miss the first document's pageshow; the snapshot-on-pageshow test
  cannot pass on webkit either. Both findings stay documented inline in
  controller.spec.ts as the auditable reason for the backend choice.
- Decision: both specs' open() helpers force `backend: { type: 'chrome',
  url: false }` — always spawn a fresh headless Chrome, never attach to a
  running browser. Rationale: Linux CI can only run the chrome backend
  (webkit is macOS-only), so chrome-everywhere makes dev and CI semantics
  identical, and both webkit-blocked tests pass on Chromium.
- Landed as d2d025ca (test(controller): port browser harness to
  Bun.WebView): evalJs('() => expr') → view.evaluate('expr') with arrow
  wrappers stripped; evaluate-clicks kept byte-for-byte; per-test
  `await using` views (ephemeral storage); page console surfaced. Two
  wait-level fixes beyond the mechanical port: a swap-burst poll
  (navigate resolves on load, which can precede the WS connect) and an
  additive `connections` observable on the serve fixture — a fresh
  module-fixture connection proves the delegated listener is bound
  before a click, with the count snapshotted BEFORE the view is created
  (under chrome the WS handshake can complete before the load event
  resolves, so a post-open snapshot already includes the page's
  connection and the wait never fires — this was the one flake found,
  root-caused and fixed before landing).
- Same push: e7905525 chore(deps): remove @playwright/cli (package.json +
  bun.lock + ci.yml — every use gone) and ed33109b chore(ci) (comment-only
  cleanup). CI needs no browser provisioning: ubuntu-latest runner images
  ship Google Chrome preinstalled (verified via actions/runner-images),
  which Bun finds via PATH. Verified fallback if that ever changes:
  `bunx playwright install chromium --only-shell --with-deps` — Bun's
  chrome backend also drives playwright's chrome-headless-shell from the
  ms-playwright cache (tested directly).
- Gates: tsc clean; all four controller specs 29/29, stable across
  repeated full-suite runs.

### 2026-09-13 — Transport seam landed (TDD, main tree)

- Landed as 5 commits on dev on top of 94e8ebd8: docs(plan) 88ae85de,
  chore(deps) 4c787dad, docs(worktree removal) 5a2c36fd, red
  test(controller) 1b32de04, green feat(controller) 9f306044. Footprint
  verified against 94e8ebd8..HEAD: exactly the 9 expected files —
  AGENTS.md, package.json, bun.lock, plan.md, controller.ts,
  controller.types.ts, + new ws-transport.ts, transport-seam.spec.ts,
  transport-serve.ts. No constants/kernel/tools/CLI changes.
- **Shape:** `Transport` contract in controller.types.ts —
  `send(ClientMessage)`, `onMessage(ServerMessage)`, `onStatus(open|close|
  error TransportEvent)` returning `Disconnect`;
  `ControllerConstructorArgs.transport?: Transport`. `WebSocketTransport`
  (ws-transport.ts) owns the socket, send-queue (flush-on-open), and
  randomized-backoff reconnect — moved out of the controller; frames parsed
  to ServerMessage in the carrier (parse failures → WebSocketMessageError,
  carrier failures → WebSocketError, both surfaced via onStatus);
  reconnect-teardown registered via injected `registerDisconnect` so pagehide
  semantics are unchanged. Four touchpoints: lazy carrier resolution
  (injected or built-in), `#send` delegates, `#handleIncoming` is the old
  `#webSocketListener` body minus JSON.parse, onStatus → `#reportError`.
- **Ingress note (corrects the handoff prompt's touchpoint-(c) wording):**
  ServerMessage ingress was NEVER gated by validateBPEvent pre-seam — the
  old listener did JSON.parse + blind `as ServerMessage` cast + switch.
  `#handleIncoming` is faithful to that (byte-for-byte default wins over
  prompt prose); a validateBPEvent admission layer is future Phase 6 work,
  marked with a MINIMAL comment in controller.ts. validateBPEvent on the
  egress `ui_event` trigger path is untouched and unrelated.
- **Verification gap (open):** red phase failed for the right reason at
  tsc level; runtime red/green of the browser specs is unobservable in this
  env (@playwright/cli daemon crash under Node 26). Gates: tsc clean;
  delegated-listener.spec.ts 5/5 (the runnable check). Seam runtime behavior
  rests on types + that check + inspection until the env issue is fixed or
  the Bun.WebView swap (WS-removal task) replaces the harness.
  **RESOLVED 2026-09-13:** the swap landed (d2d025ca) — transport-seam.spec.ts
  3/3 and controller.spec.ts 19/19 runtime green under Bun.WebView; no seam
  bug found (this is the seam's first runtime validation).

### 2026-09-13 — e2e harness: WebDriver rejected; Bun.WebView for DOM specs,
socket-bridge for real-IPC

- The pilot rejects WebDriver (tauri-driver) for the e2e leg. Research
  grounded against two sources: `Bun.WebView` docs (bun.sh) and
  srsholmes/tauri-playwright (GitHub, read 2026-09-13).
- **Layer mapping (the two test layers take different tools):**
  (1) DOM-level controller specs (layer 1, today `bunx @playwright/cli
  --browser=chromium` + serve fixture) → candidate replacement is
  **`Bun.WebView`**: on macOS its webkit backend IS WKWebView — the engine
  the Tauri app ships in — so post-WS-removal it satisfies controller.spec.ts
  "tested in the environment it ships in" more faithfully than Chromium; it
  runs inside bun:test (no spawned Playwright session → sidesteps the known
  browser-launch timeout). (2) real-IPC integration (layer 2) → a
  **tauri-playwright-style socket bridge**, NOT CDP and NOT Bun.WebView:
  WKWebView has no CDP (why plain Playwright can't attach on macOS), and
  Bun.WebView creates its own webview — it can never host the Tauri core
  (invoke/Channel/emit), so it cannot serve layer 2 at all.
- **tauri-playwright mechanics (grounded):** Rust plugin
  (`tauri-plugin-playwright`, optional behind an `e2e-testing` cargo feature)
  embeds a Unix-socket server in the app; npm package gives a
  Playwright-compatible tauriPage/locator/expect API; commands run via
  `webview.eval()`, results return through real Tauri IPC (`pw_result` invoke
  + same-origin HTTP poll). Proven on macOS real WKWebView (their CI), MIT,
  changesets-published (npm + crates), active through 2026-06. Its `browser`
  mode (mocked Tauri IPC in Chromium) is the rejected
  `@tauri-apps/api/mocks` pattern — skip it; the in-memory transport is our
  mock-free equivalent. Caveats if adopted as a package: `withGlobalTauri:
  true` requirement (verify vs the `@tauri-apps/api` plan), `playwright:default`
  capability in the stub relay's capability file, and its JS bridge polls a
  same-origin `/pw-poll` route designed for a Vite proxy — our Bun.serve static
  host must proxy that route to the plugin's HTTP callback server.
- **Bun.WebView caveats (accepted as experimental, logged):** webkit backend
  has no CDP (`cdp()` throws — specs only need navigate/click/evaluate/press,
  fine); `type()` is the InsertText paste path — NO keydown/keyup, so specs
  asserting on key events must use `press()` (spec audit needed at swap time);
  engine is platform-divergent (Chrome/Blink on Linux/Windows — "ships in"
  literal only on macOS; tests are macOS-local today); WKWebView persistent
  storage needs macOS 15.2+ (ephemeral default fine).
- **Timing constraint:** the transport-seam task keeps the existing
  Playwright harness green (byte-for-byte default WS carrier). The Bun.WebView
  swap belongs to the WS-removal task, when the harness is rewritten anyway
  and the in-memory transport slots in as a second real carrier in the same
  Bun-native harness. The socket-bridge e2e belongs to the desktop-carrier
  task that follows. Recommendation (navigator): adopt the
  @srsholmes/tauri-playwright package first, fall back to an in-repo minimal
  Unix-socket harness modeled on its server.rs only if integration friction
  bites — decision is the pilot's in that task.
- **Resolution (same day):** the pilot chose **(b) in-repo** — a minimal
  Unix-socket harness modeled on the package's server.rs. Greenfield size,
  debuggability, no third-party concerns; the package remains a reference.
  The Bun.WebView DOM-spec swap is confirmed later-phase (WS-removal task).
  See the resolved OQ entry.

### 2026-09-13 — Worktrees dropped as a repo workflow

- The pilot drops the agent-worktree convention for this repo. Task work
  (including the transport seam TDD) proceeds directly in the main working
  tree; red/green TDD commits land on `dev` (a short-lived local branch is
  optional at the pilot's discretion, merged locally — no worktree scaffolding).
- Rationale: the worktree ceremony bought isolation this single-pilot local
  repo does not need; `.worktrees/` is confirmed empty and no stale
  worktree branches exist in this repo.
- Follow-up docs commit (after the pending plan/deps commits): remove the
  **Agent worktrees** and **Worktree lifecycle** bullets from the "Git as
  Context" section of `AGENTS.md`, delete the empty `.worktrees/` dir.
  No executable behavior changes → docs commit, no test gate required.

### 2026-09-12 — Transport work pulled forward into the TS phase (scoped)

- The pilot starts the controller transport replacement NOW, not post-TS:
  replace WebSockets in `controller.ts` with the Tauri IPC carrier
  (`tauri::ipc::Channel` + `emit`/`listen`), updating tests to validate it.
  Scope bounded to `src/controller/` (+ tests/fixtures); the Tauri Rust shell
  and the rest of the desktop layer remain post-TS.
- Coupling verified against the import graph: nothing imports `controller.ts`
  outside `src/controller/`; the only external consumers of controller surface
  are `src/tools/html.ts` + `html.schemas.ts` (constants `B_*`/`SCALE` +
  `swapBoundary` — untouched by the swap); zero references to the message
  unions or `CONTROLLER_*` message types outside `src/controller/`;
  controller→behavioral dependency is type-only (`BPEvent`, `Trigger`,
  `Disconnect`). The message protocol and constants are the frozen ABI.
- Open: what "validate Tauri IPC" means before a Rust core exists —
  **RESOLVED (2026-09-12): real-IPC.** The pilot prefers a minimal Rust
  Tauri scaffold exercised end-to-end (tauri-driver/WebDriver) as a valid
  integration test. Consequences accepted: (a) Rust enters the repo NOW as a
  bounded test harness — a stub relay (one `controller_message` command, a
  Channel for streaming ServerMessages, event emit), NOT the real relay and
  NOT the desktop shell — scope-guard: no atproto, no process spawning, no
  shell features; it exists to validate the carrier against real
  `tauri::ipc::Channel`/`emit`/`listen` behavior, and the real relay replaces
  its guts later without changing the carrier; (b) toolchain surface grows:
  cargo workspace (suggested: `desktop/` outside `src/`), tauri CLI,
  tauri-driver in the test path — Rust gates (fmt/clippy/test) enter the
  quality gate for this surface; CI needs a macOS/webview-capable runner for
  the e2e leg; (c) test matrix: unit (in-memory transport + DOM specs),
  integration (webview loads the controller bundle with the Tauri carrier →
  real invoke/Channel roundtrip against the stub relay). This partially
  supersedes "desktop parked behind TS-first": a bounded slice of the desktop
  Rust is now live TS-phase work; the rest (shell, real relay, atproto
  client) stays post-TS.
- Refinement (same day): **Bun + package.json stay the sole command drivers** —
  rustc/cargo/tauri invocations hang off package.json scripts / Bun shell
  scripts (per repo Bun-first convention), keeping the project's Rust surface
  minimal and the driver story single. **`desktop/` folder agreed** (run
  `bun tauri init` from `desktop/` so the crate lands at `desktop/src-tauri/`,
  keeping all Rust under `desktop/`). **No Vite — Bun is the bundler**
  (`bun add -D @tauri-apps/cli`, `@tauri-apps/api` in the root package.json;
  `bun build --target=browser` produces the static web assets). Grounded
  against the Tauri docs (2026-09-12): Tauri is a **static web host** —
  `frontendDist` = bun build output; `beforeBuildCommand` = `bun run` script;
  dev flow = `bun build --watch` + a small `Bun.serve` static server as
  `devUrl`, or skip dev-mode entirely for the e2e harness (tauri-driver needs
  the built binary anyway). **SSR reconciliation:** the docs' "no SSR" means
  no webapp/framework server rendering (Next/Nuxt-style) in the webview —
  it does NOT conflict with this repo's SSR, which is agent-side (html tools
  render fragments during turns, pushed via the controller protocol); the
  webview hosts a static controller bundle. Setup path per the manual-setup
  doc: `bun add -D @tauri-apps/cli` → `bun tauri init` (supports `--ci` with
  `--app-name/--frontend-dist/--dev-url/--before-dev-command/
  --before-build-command` for non-interactive setup) → stub relay commands.
  The Vite-specific watch-ignore step is skipped (no Vite).
- Setup landed (2026-09-12): `@tauri-apps/cli@^2.11.4` added as a devDep
  (package.json + bun.lock dirty, uncommitted). Commit plan as TWO commits:
  `docs(plan)` for plan.md only; `chore(deps)` for package.json + bun.lock.
  `@tauri-apps/api` is deliberately NOT installed yet — the carrier task needs
  it, the seam task needs nothing new. Seam-test harness question resolved:
  keep the real-browser Playwright harness (controller.spec.ts's documented
  philosophy: "No happy-dom, no FakeWebSocket. The controller is tested in
  the environment it ships in"). The in-memory transport in the seam spec is
  not a "FakeWebSocket" — it is a second real carrier proving the seam is
  carrier-agnostic; controller.spec.ts keeps testing the shipping WS carrier
  against a real server+browser.

### 2026-09-12 — Desktop = Tauri; controller drops WebSockets as its carrier

- The pilot confirms Tauri as the desktop pattern, accepting the overhead +
  controller modification as the price. The local-PWA pattern stays logged as
  a researched fallback, not the plan.
- **Controller drops WebSockets** — not dual-carrier. Rationale: the eventual
  atproto client would be a Tauri app anyway (the serverless Statusphere post
  is the *server-side* pattern; a client for that ecosystem is a desktop app),
  so the WS carrier has no long-run home. Consequences accepted: the controller
  transport seam refactor (construct/connect, `#send`, incoming dispatch,
  error/close → injected `Transport`) with a Tauri IPC carrier as primary; the
  WS hardwiring is removed rather than kept as default.
- **Test/fixture consequence (open):** controller specs + the serve fixture
  speak WS today — they need a carrier replacement. Candidate: an in-memory/
  mock transport in specs (simpler than real-WS testing), serve fixture
  repurposed or removed.
- **Location transparency (noted, valuable):** with the controller speaking
  only IPC to the Rust core, the Rust relay chooses the agent's location per
  turn — local cold Bun process (stdin/stdout NDJSON) or a remote hosted agent
  (HTTPS/WS from the Rust side). Same controller, same message protocol;
  the desktop-client and deployed/headless paths become one architecture
  differing only at the relay.
- Still parked behind TS-first; the one pre-payable item during TS work is the
  transport seam extraction (cheap before a second carrier exists).

### 2026-09-12 — TS-first; desktop layer and Rust conversion deferred (exploration closed)

- The pilot closes the speculative exploration: **finish the TypeScript
  agent first, without a desktop layer**; decide Rust conversion and Tauri
  integration only after. TS-first is the stated rationale (pilot fluency);
  all desktop/Rust branches below are **documented options, not commitments**.
- Exploratory conclusions carried forward for the eventual decision:
  - Tauri never required the Rust conversion — thin shell + cold Bun process is
    the baseline pattern; the Rust port is a separate, later question.
  - Cold-per-turn stands (no daemon resurrection) even in a desktop world.
  - Ingress shape (pilot-confirmed, matches existing types): controller
    messages → `trigger()`; `UiEventMessage.detail.event` is already a `BPEvent`,
    so the relay is `trigger(detail.event)` through the existing `validateBPEvent`
    gate; the kernel's trigger path already adds a request-thread to `running`
    with `ingress: true` (blockable by active threads).
  - Egress shape (tentative, pilot leans A): **A — egress-as-selection** — UI
    updates are requested `ui.*` events whose selections the relay maps 1:1 to
    controller messages (`render`/`attrs`/`navigate`/`dispatch_custom_event`/
    `scale_check`); single ABI both directions (stdin: NDJSON BPEvents,
    stdout: NDJSON trace stream). B — direct pipe from tool results — rejected
    in principle (bypasses the frontier, ungovernable UI).
  - Bun is not displaced: skills stay Bun-executable regardless of any Rust
    port; `HTMLRewriter` is already lol-html underneath, so an eventual port
    has engine parity available via the `lol_html` crate.

### 2026-09-12 — Cold turn ABI: mid-turn stdin triggers

- Resolves the Q-T2 successor branch. A running turn accepts external
  triggers mid-flight: NDJSON `BPEvent`s on stdin, relayed from webview
  `invoke` by the Tauri core, admitted through the kernel's existing
  `trigger()` gate. No new validation surface — stdin is a process trust
  boundary, and `validateBPEvent` already runs at `trigger`; UI triggers are
  external (`ingress: true`), so listener `ingressMatch` flags and thread
  `block` semantics apply to them unchanged (a UI click can be blocked by an
  active thread — the deadlock trace's candidate set is how the UI observes
  that).
- Successor sub-question: **after-stop rule** — a trigger arriving after the
  turn's stop condition (open, see Open Questions).
- Q-T3 (transport) is taken as resolved by the pilot's stated position + this
  decision: webview leg is Tauri IPC (`Channel` for trace/render streaming,
  `invoke` for trigger relay), Rust core is a per-turn spawner/relay, the agent
  stays a Bun cold process. No listening port. Q-T1 likewise resolved by
  implication: the desktop owes window + native integration (IPC, capability
  ACLs), not merely a browser tab. Both entries invite a pilot veto.

### 2026-09-12 — Desktop app: cold-per-turn, no daemon resurrection (Q-T2 → A)

- The pilot drops the daemon for the Tauri desktop app: the app does **not**
  host a long-lived agent process. Each user action spawns a cold `behavioral
  turn`-style process; traces/renders stream to the webview while it runs; the
  process exits at turn end. The "Explicitly deferred" long-running hosted
  agent (REST+WS, per-user spaces) **stays deferred** — a GUI is no longer its
  un-deferring trigger.
- Consequences: (1) Q-T3a's proxy shrinks — no long-lived duplex proxy, just
  per-turn `std::process::Command` + line-delimited JSON trace stream relayed to
  a `tauri::ipc::Channel`; (2) the app is inert between turns — the desktop UI
  is a rendered transcript plus a turn launcher, not a live control surface;
  (3) the open-next branch is **mid-turn ingress**: whether a running turn
  accepts external triggers on stdin (kernel `trigger()` is callable any time;
  preserves the controller's intra-turn interactivity) or ingress is
  prompt-only at spawn (simplest, coarsest).
- Transport (Q-T3) still open on the webview leg (IPC vs WS); the Tauri-IPC
  security rationale (no listening port, capability ACLs) stands and now has
  no daemon to attach to.

### 2026-09-12 — Ingress channels: `trigger` is external-only; internal re-entry via threads

- Amends the 2024-09-03 action-channel direction ("do async I/O, `trigger` results
  back"): the dispatch bridge no longer re-enters via `trigger`. Internal results
  (`model.result`, `tool.result`, `turn.end`, `discovery.results`, …) arrive as
  ordinary `once` threads added through `useAddThread(space)` whose single rule
  `request`s the event. `ingress: true` is then exclusive *by construction* to the
  external `trigger` surface — no second API, no private handle to guard.
- The two injection paths map onto the two existing gates: event admission
  (`trigger`) is controlled by listener `ingress` flags (+ the Phase 6 public-event
  registry at the boundary); thread admission (`useAddThread`) is controlled by the
  Phase 5 Layer 1 frontier gate. An outside actor that tries to inject requests as
  synthetic threads gets caught by thread admission, not the event vocabulary.
- Listener flags are a uniform `*Match` family of optional booleans: `ingressMatch`
  (renamed from `ingress` — parallel to `detailMatch`) and `detailMatch`
  (migrated from the `'valid'`/`'invalid'` vocabulary to booleans). Shared schema
  shape for both: `{ type: 'boolean', enum: [true, false], nullable: true }` —
  `nullable` is required by `JSONSchemaType` for optional properties; the `enum`
  rejects `null` loudly at registration (a null flag must be an `add_thread_error`,
  never a silently-dead waiter or a silently-inert block guard).
  - `ingressMatch`: absent = matches any channel (backward compatible); `true` =
    external-trigger-origin only; `false` = request-origin only. Backpressure on
    external events is an `ingressMatch: true` block listener.
  - `detailMatch`: `true` = `'valid'` (match conforming details); `false` =
    `'invalid'` (match non-conforming); **absent keeps the conforming-required
    default** — absent does NOT become unrestricted.
  - Matching lands in the single `isListeningFor` seam, so waitFor/block/interrupt/
    transform get both flags uniformly.
  - Rename scope: the listener FIELD only. The bid/candidate provenance stamps
    (`RunningBid.ingress`, `CandidateBid.ingress`, trace `selected.ingress`,
    `frontier.ts` replay branches) remain `ingress`.
- `useTrigger(space)` → `trigger(event)`: the event carries `space` (absent = root),
  no partial application on the external surface. Asymmetry is principled:
  registration is a space-scoped *capability* (partial application); event
  admission is unscoped-but-flagged *data* (listeners decide via ingress + space).
- Internal re-entry steps via a **contentless trigger kick**: the re-entering
  code adds its `once` thread (`request`ing the result event) through
  `useAddThread`, then calls `trigger({ type: <kick> })` to start the
  super-step. `useAddThread` stays inert (idle-until-trigger quiescence is
  preserved — pure-requesting programs like tic-tac-toe/water do not
  self-start at registration); the program advances only when an event enters
  via `trigger`. Contract: nothing ever listens to, waits for, or blocks the
  kick type — it carries no detail and no semantics; an external actor
  triggering it is harmless by construction. The kick becomes permanent event
  vocabulary (append-only log, replay, reference traces) — name it deliberately.
- Docs deliverable: `references/behavioral.md` action-channel paragraph (~lines
  120–139), the listener table, and the `trigger_error` row (~205) must update in the
  same commit; the `useAddThread`-doesn't-step gotcha paragraph may flip (see Open
  Questions).

### 2026-09-09 — Architecture diagram lives in README (WIP research phase)

- Pilot asked for a graphic of the harness flow (model-as-tool + behavioral-thread
  loop) to pass to Claude; decided instead to generate it locally as a Mermaid
  `flowchart` in `README.md` under "Architecture (WIP — research phase)" — the
  repo is the best home while the harness is still WIP.
- Diagram encodes the inversion: `model-respond` drawn inside the tools fleet at
  the same level as `read`/`bash`/`mcp-client`; the turn-loop thread as a
  5-rule state machine over the coordination verbs; the dispatch bridge as the
  `useTrace` action channel with dashed `queueMicrotask` re-entry; the kernel as
  provisioner + per-turn composer. Marked scaffolding pending Phase 5.5.
- Navigator note: pilot directed the README edit directly (outside the usual
  navigator write-scope of plan.md); no commit made — commit is the pilot's.

### 2026-09-09 — Autoresearch loop: shape + prerequisites

- Q8/A — **The eval loop is an autoresearch loop, not a one-off demo.** The
  reusable Daytona script IS the autoresearch loop (generate → `frontier-verify`
  in an isolated forked sandbox → promote/discard → log exhaust). The talk demo
  is one narrated run of it. Karpathy-autoresearch shape: one mutable surface
  (the thread/skill), a fixed evaluator, a keep/discard rule, loop forever.
- Q8/B — **The gate is a proof, not a scalar metric.** Karpathy's gate is a
  metric (`val_bpb`); ours is `frontier-verify` — a symbolic deadlock/livelock
  proof. "Neural proposes, symbolic disposes"; self-modification can't break
  confluence. Anti-reward-hacking is free (the evaluator is a pure function of
  thread data, not agent-editable).
- Q8/C — **A second signal is required beyond safety.** `frontier-verify`
  proves a thread can't deadlock/livelock; it does not prove the thread
  *accomplishes its task*. The loop needs a task-success metric alongside the
  safety gate, or it optimizes safety without usefulness. OPEN — the metric is
  undefined (see Open Questions).
- Q8/D — **Generators are swappable: scripted first, then a model generator.**
  *(SUPERSEDED 2026-09-17: the loop is agenthub's, and models come from
  `~/.behavioral/config.json`, not provider literals.)* (a) a scripted
  generator (deterministic, proves the loop mechanics) as scaffolding;
  (b) agenthub's model generator is a `model-respond` call against a
  config.json-declared model (`apiKeyRef`, the `provider` routing field) —
  provider choice (OpenRouter or any Responses-conformant endpoint) is the
  user's config, and Responses-spec conformance is verified per endpoint at
  build time; if an endpoint doesn't conform, a thin adapter or a
  spec-conformant provider is needed.
- Q8/E — **Prerequisites before the loop script.** *(SUPERSEDED 2026-09-17:
  the loop and its remaining prerequisites now live in the agenthub repo —
  see the extraction entry. In-repo consequences: prereq (1) is dropped
  entirely by the growth-model entry — there is no `sh.behavioral` extension
  to fill and no bundled plugin; models come from config.json. Prereq (3)'s
  kernel primitives exist — arbitrary-thread run + trace capture in
  `src/kernel/kernel.ts`, the reconcile scan landed in `4ed5df56`. Prereq
  (5) is agenthub's problem.)* Original dependency order: (1) fill the
  default plugin content — DROPPED; (2) author the real core thread —
  agenthub-side; (3) kernel primitives to run an arbitrary thread — DONE;
  (4) define the second signal — RESOLVED, Q8/F; (5) install
  `@daytonaio/sdk` + provision OpenRouter — agenthub's.
- Q8/F — **The task-success metric (Q8/C) is resolved.** Per-candidate
  keep/discard gate: `frontier-verify` (safety — no deadlock/livelock) AND
  `frontier-replay` over a reference trace reaches the target frontier
  (usefulness). Both pure functions of thread data. A Harbor task eval is the
  outer task-level signal (later). This is the autoresearch "fixed metric" —
  the loop is a hill-climb gated on proof, not a scalar score.

### 2026-09-07 — Generative-UI dev server (no TUI); space semantics

- Q5/A — **The local UI is a dev server, not a TUI, and it is part of the
  agent's space.** `plaited` (cold CLI) spins up (or reuses) a local dev
  server built on `src/controller/` + `src/tools/html.ts`. It serves SSR pages
  over WebSocket (the controller's existing push model: server-pushed
  `render`/`attrs`, DOM-bound `b-trigger`/`b-form`, `ui_event` back to the
  agent). The agent renders into it via `html-render` / `html-update-attributes`
  — the UI is a space the agent acts on, not a separate app it points at.
- Q5/B — **The dev server hosts a memory + shared human-agent context UI.** A
  human selects a space to work in and collaborates with the agent there;
  because the agent drives the UI generatively, the human can ask the agent to
  reshape the UI itself. Events transmit over WebSocket; agent-initiated
  content reaches the page via event emission captured by `useTrace` and
  pushed up to the page. (Mechanics are a later phase — this records the
  shape, not the build.)
- Q6/A — **A space is a project folder (local).** No multi-session: the space
  *is* the project. One `plaited` invocation works in one space; the space's
  context persists across invocations (Phase 4 persistence), so the project
  folder is the durable identity.
- Q6/B — **Space isolation is invariant across deployment shapes.** Spaces
  can't see or query each other — they only respond to their own events via
  `useAddThread`/`useTrigger` space-scoping. Root sees everything because it's
  unscoped. The atproto deployment shape (root space = server, spaces =
  atproto spaces, space↔space exchange triggers the agent) is a later phase
  built on the local model — noted, not committed.

### 2026-09-07 — No daemon; gated event ingress

- Q1/A — **Drop the daemon model entirely.** `plaited` is a normal cold CLI
  agent (JSON-in/JSON-out, no TUI) — the same interface the autoresearch loop
  and Harbor tasks drive. There is no warm/serve process. External actors that
  want the agent (a cron job, an atproto space event, Harbor) invoke `plaited`
  per trigger; the agent runs to turn-end and exits. If you want a recurring
  job, write a cron job (Bun) that calls the agent — don't keep the agent
  resident.
- Q1/B — **Ingress is gated by a public-event registry, not open.** External
  events must not trigger arbitrary types. A store holds a CRUD-able list of
  allowed public events — each entry `{ type, space, schema }` (the JSON Schema
  the event's detail must satisfy). An external trigger is admitted only if its
  type+space is registered and its detail validates against the registered
  schema; unauthorized or malformed events are rejected at the boundary. This
  is the trust boundary between the outside world and the behavioral space.
  (Store: reuse the discovery-sqlite pattern — a local, regenerable store the
  kernel reads at admission time.)

### 2026-09-07 — Threads are a first-class plugin component (not skill assets)

- Q3/A — **Threads are their own plugin component, not skill assets.** The
  default plugin (agent-plugins spec) carries a `threads/` folder as a peer of
  `skills/`. Threads are kernel-facing behavioral registrations, not
  model-consumed skill content, so they must not live in a skill's `assets/`
  (which the Agent Skills spec reserves for model-readable static files).
- Q3/B — **Threads are declared via the plaited client-extension namespace.**
  Per the Agent Plugins spec, `plugin.json` is a closed schema — custom
  component types go under `extensions`. The default plugin declares its
  threads under `extensions."sh.behavioral"` with a manifest that maps each
  thread file to the space it applies to (per the earlier space-scoping
  design). A top-level `threads/` directory holds the thread files
  (a plain component dir, not the namespace-named extension dir).
- Q3/C — **`src/kernel/threads.ts` is a placeholder for the kernel's own
  floor**, not the home of behavior. Behavior threads ship in plugins under
  `threads/`; the kernel loads them at provisioning. The scaffolding turn-loop
  thread currently in `threads.ts` moves into the default plugin once the
  plugin-loading path exists.

### 2026-09-09 — Spec-conformant plugin; loader becomes a conformant client

- Q3/C-REVISED — **The core framework turn-loop thread stays in
  `src/kernel/threads.ts`** (overrides the Q3/C "moves into the default
  plugin" note). The default plugin's `threads/` is for plugin-shipped
  behavior, not the kernel's own loop.
- Q7/A — **`plugin.json` is spec-conformant (Agent Plugins v1), not the
  custom loader manifest.** It carries only the closed portable fields
  (`$schema`, `name`, `version`, …, `extensions`). MCPs live in `mcp.json`;
  skills are discovered from `skills/`; neither is declared in `plugin.json`.
  The earlier `PluginManifestSchema` shape (`{mcps, skills, models, threads}`)
  is superseded — plaited is a *conformant client*, not a custom format.
- Q7/B — **Plaited-owned declarations live under the `sh.behavioral` client
  extension** (the spec's sanctioned mechanism — the spec does not prescribe
  enablement, trust policy, or client-extension behavior). Under
  `extensions."sh.behavioral"`: `threads` (thread file → space mapping), `models`
  (Open Responses endpoints — not a portable component type, so client-owned),
  and `spaces` (per-space config).
- Q7/C — **Per-space gating is declared in `sh.behavioral.spaces` and applies to
  MCPs and skills alike** (and tools), default-allow per Q4. Declaring which
  MCP tools/skills a space may use under `extensions."sh.behavioral"` is
  client-specific config — fully compliant. `mcp.json` says which servers
  *exist*; `sh.behavioral.spaces` says which a space *may use*.
- Q7/D — **`plugin-loader` is reworked into a conformant client**: validate the
  spec `plugin.json` + `mcp.json`, discover `skills/` from the fixed location,
  read the `sh.behavioral` extension for `threads`/`models`/`spaces`. Enforce
  conformance (reject fatal manifest violations) rather than merely tolerate
  the shape — the conformant-client claim should be real.

### 2026-09-09 — The `sh.behavioral` extension schema (root + space mirror)

> **Namespace:** `sh.behavioral` — the reverse-domain of `behavioral.sh`, which
> the project controls. Renamed from `com.plaited` (2026-09-09). Spec §8: the
> extension namespace MUST be a reverse-domain identifier and SHOULD be a
> domain the client controls — both hold.

- Q7/E — **`extensions."sh.behavioral"` shape.** Root carries `models`, `mcps`,
  `skills`, `threads`, and `spaces`. `mcps`/`skills`/`threads` are
  `{ include?: string[], exclude?: string[] }` gating objects; `models` is an
  array of endpoint declarations `{ provider, modelId, endpointUrl, apiKeyRef?,
  locality? }`; `spaces.<name>` mirrors the same shape and overrides root for
  the keys it sets (unset keys inherit root's default-allow posture).
- Q7/F — **Threads are discovered from a top-level `threads/` dir** (a plain
  component dir, not the namespace-named `sh.behavioral/` extension dir — the
  spec fixes only `skills/` and `mcp.json`). `threads.include`/`exclude` are
  paths into `threads/`; absent means everything in `threads/` is in scope.
- Q7/G — **Gating rule: allowlist-first-then-exclude.** `include` (when set)
  narrows to its members; `exclude` then subtracts. Applies uniformly to
  mcps, skills, threads. Absent both → allow-all (Q4 posture).
- Q7/H — **Models are declared at root, gated per space.** Root declares the
  available model fleet; a space's `models` selects the subset it may route
  to — a space cannot declare a brand-new endpoint (prevents arbitrary
  model/credential usage from a space).

### 2026-09-07 — Skill gating: default-allow, list-narrows (matches MCP semantics)

- Q4/A — **Skills are gated host-side at provisioning with the same
  allow/blocklist pattern as tools/MCPs** (`skills` / `excludeSkills` per
  space config), **defaulting to allow-all**. If neither list is set, every
  skill a plugin provides is enabled. `skills` set → allowlist (only these).
  `excludeSkills` set → blocklist (all but these). Both set → allowlist first,
  then blocklist subtracts. The absent-means-on posture keeps a space config
  minimal and auditable: lists appear only when restricting.
- Q4/B — **Gating is host policy, not plugin self-description.** The plugin
  declares what it provides; the host (kernel/provisioning thread, per the
  operator's space config) decides what each space enables. Authoritative
  allow/deny lives host-side, applied per space. This extends the existing
  packs model (plan.md "Packs + useBehavioral + skills": `$root`/space packs
  carry `tools`/`excludeTools` + `skills`/`excludeSkills`) — Q4 confirms it
  rather than inventing a new mechanism, and fixes the posture to
  default-allow.

### 2026-09-07 — Default plugin ships one skill: `behavioral`

- Q2/A — **The default plugin consolidates to a single skill, renamed
  `behavioral`.** `skills/plaited-framework/` becomes `skills/behavioral/`
  (SKILL.md + its references: behavioral, frontier-analysis, controller,
  eval, autoresearch, design-spec). It is the one skill the
  default plugin carries — the guide to working in/on the plaited behavioral
  harness.
- Q2/B — **The other skills leave the repo.** `git-context`, `markdown`,
  `typescript-lsp` skills are gone from `skills/` (their role is now Harbor
  challenge content in `tasks/`). `mcp-client` skill is gone (its code became
  `src/tools/mcp-client.ts`). `design` is dropped (generic doc-authoring, not
  plaited-specific).
- Q2/C — **Default plugin layout** (agent-plugins spec): `plugin.json` +
  `skills/behavioral/` + `threads/` (Q3) + `mcp.json`. Threads are declared
  under `extensions."sh.behavioral"` mapping thread file → space.

### 2026-09-07 — MCP/skill discovery: search-mediated progressive disclosure

Unified architecture for surfacing remote MCP tools and local skills to the
agent. Both domains follow the agentskills.io three-tier progressive-
disclosure pattern (catalog → full instructions → bundled resources), but
**search-on-demand** replaces the spec's recommended static catalog-in-system-
prompt. The model searches a SQLite store by description, picks a candidate,
then loads full info through the relevant client tool. This scales to large /
dynamic pools without rebuilding a static catalog per session, at the cost of
one search round-trip before activation — and the orchestration moves into
kernel behavioral threads, which is the plan's intended shape (tools are dumb
primitives, threads orchestrate).

The spec deviation (search-on-demand vs static catalog) is **deliberate**, not
an oversight to "fix" later by adding a catalog "for simplicity."

**Three stateless built-in `src/tools/` units, all take their target as input**
(no tool owns shared discovery data; no tool calls another tool):

- **`mcp-client`** — Phase 3 conversion of the existing CLI to `useTool`. Seven
  modes survive (`call-tool`/`list-tools`/`list-prompts`/`get-prompt`/
  `list-resources`/`read-resource`/`discover`). Input `{mode, url, tool, args,
  auth, ...}`. Returns remote MCP data only — never writes a store.
- **`skill-client`** (new) — reimplemented from the agentskills.io spec +
  `src/cli/markdown.ts` as **reference only** (no import, no export-helpers
  refactor; own frontmatter parsing). Modes: `discover` (scan
  `.agents/skills/` project + user level, parse frontmatter → records),
  `read-skill` (load SKILL.md body), `list-resources` (enumerate bundled files).
- **`discovery`** (new) — `{mode, dbPath, ...}`. Full CRUD + search over
  `.plaited/discovery.sqlite` (`bun:sqlite`), unified `kind: 'mcp-tool' | 'skill'`
  rows. **The only tool that touches the store file.** Population, refresh, and
  search are kernel-thread policy via this tool — not adapter provisioning.

**Adapter role narrows to the pi-extension pattern** (connection pool + OAuth +
tardown), matching `youdotcom-oss/minimax-m3-deepsearchqa-skill-eval`'s
`extension.ts`: a live `Client` per server-url lazily connected and reused across
calls, `close()`d on teardown. The adapter owns **no discovery data**.

**MCP SDK clarification:** the 2024-09-03 "Drop MCP SDK" decision was about the
**server** side (`new McpServer`, `use-mcp-server.ts`, dropped in favor of
AJV/`useTool`). The **client** SDK stays — `Client`,
`StreamableHTTPClientTransport`, `OAuthClientProvider` from
`@modelcontextprotocol/client`. This is consistent with "the agent uses MCP to
talk to remote servers" and does not contradict the AJV/`useTool` local-tool
story.

**OAuth:** `BunKeychainOAuthProvider` (per the sketch) — refresh tokens and
client info to `Bun.secrets` (OS keychain) instead of the current
`~/.plaited/mcp/tokens/<host>.json` file persistence. **Upgrade to the v2
`OAuthClientProvider` shape** (issuer-keyed `clientInformation(ctx)`,
`state()`/`saveDiscoveryState`/`discoveryState()`, `validateResourceURL`) — the
current `createOAuthProvider` implements the old interface and lacks RFC 9207
`iss` validation and issuer-binding. One provider per server-url, reused across
process restarts (keychain persists; the connection doesn't, but reconnect
reads tokens back).

**Surfacing:** neither single-tool nor multi-tool — search-mediated, on-demand.
The Phase 2/7 "built-in tools only, packs never contribute tools" invariant
stays intact: remote MCP tools are never registered as first-class tools.

**`use-plugin-adaptert.ts` → `use-plugin-adapter.ts`** rename (file is empty).

**Discovery store is NOT git-backed** — local SQLite, just what the tool allows.
Distinct from Phase 4's git-backed trace-log persistence. The store is
regenerable (re-scan filesystem, re-discover servers); committing it bloats the
repo and risks staleness.

### 2024-09-03 — Build sequence: tools → lock runtime → small kernel

- **Sequence:** (1) finish `src/tools/` (MCP `useMCPServer` tools), (2) lock
  the runtime, (3) build a small kernel that completes the agent harness.
- **The behavioral core IS the loop.** The super-step
  (`computeFrontier → selectNextEvent → publish`) is the agent turn cycle — no
  separate `runLoop`. The kernel is thin: set up the program, register the fixed
  tool set, wire `useTrace` as the action channel, feed `user.prompt` in.
- **`useTrace` async callback = the action channel** (replaces `useAddHandler`).
  The engine does NOT await listeners (`behavioral.ts:28`, `void Promise.resolve(...)`
  — non-awaiting by design). The action listener does its async work outside the
  super-step and re-enters the result via `trigger`. The program synchronizes on
  the *event*, not on the listener completing — a thread with `waitFor: ['T']`
  yields; the listener fires, does I/O, `trigger`s `T` back; the next super-step
  selects it. The behavioral core stays synchronous/deterministic; async I/O is
  off to the side.
- **Kernel shape:** MCP tool approach (tools are `useMCPServer` registrations),
  controlled by behavioral threads, uses the `transform` idiom.
- **Model-as-tool.** `request({ type: 'respond' })` → action listener calls
  `useResponse` → triggers each stream event verbatim into the space. The model
  is one tool in the fixed set, not special.
- **`transform` idiom = the declarative synchronous reshape** (query → target,
  no I/O). Pure-data counterpart to the action listener: `transform` for
  reshaping, action listeners for I/O side effects. Both re-enter via the event
  stream.
- **Fixed tool set + threads + triggers = extension surface.** Tools are
  built-in/fixed; behavior is threads; ingress is triggers. No new tools, no
  handlers.
- **`onSelection` is test-only.** The `useTrace` + selection-filter helper in
  `src/main/tests/helpers.ts` is NOT the engine API and NOT the design direction
  for `src/agent/`. How `useTrace` is consumed agent-side is undecided; do not
  bake it into docs or the kernel.
- **Doc/skill handler-mention updates deferred.** Stale `useAddHandler`/
  `useFeedback`/`feedback_error` references should NOT be rewritten to describe
  a `useTrace`-replacement story yet — that story is undecided. Pure *removal* of
  provably-dead references is safe; replacing with an un-landed design is
  speculative.
- **Resolved: no engine error mechanism needed.** Split listener failures into
  two classes: (1) tool/I/O failures (bash non-zero, model error, remote MCP
  down) are *expected runtime outcomes* that return as **data** (`isError`,
  terminal error event) — the kernel's action listener catches these and
  `trigger`s a `T.error` event the program can `waitFor`/`block` on (kernel
  convention, ~5 lines, not an engine feature); (2) genuine listener bugs
  (uncaught throw) are rare because the kernel owns the listeners, they're
  typed, and they're tested — the engine's `console.error` swallow
  (`behavioral.ts:32`) is acceptable for this tail (surface to log, fix with a
  test). The user-extensible surfaces sidestep uncaught-throw risk: remote MCPs
  return `isError` data, skills are prose, threads are gated by `verifyFrontiers`.
  So `feedback_error` has no successor at the engine layer; the error path is a
  kernel convention.

### 2024-09-03 — Drop MCP SDK; runtime internal-only; frontier-analysis → src/tools/

- **Q2 — `src/main.ts` deleted permanently.** The runtime is internal to the
  harness, not a published library. The package has no public entry point;
  `behavioral()` is importable only by internal paths (controller, tools, the
  future kernel). Matches "the agent is a `plaited` CLI command, the runtime is
  internal." Not provisional — committed.
- **Q1 — Drop the MCP SDK (`@modelcontextprotocol/*`) in favor of an AJV /
  `defineTool`-style registrar.** The SDK is currently ceremony with no live
  consumer — `use-mcp-server.ts` is a 3-line pass-through, and `new McpServer`
  appears only in a test's in-memory transport; nothing in `bin/` or `src/agent/`
  serves a server. The plan's Phase 2 already specified the target shape
  (`defineTool` taking a `ToolArgs` data object with JSON Schema, validated by
  AJV); the `useMCPServer` drift moved away from it. Dropping the SDK returns to
  the plan. The tool *data* (name, inputSchema, outputSchema, description, run)
  survives the swap; only the `server.registerTool` wrapper changes. MCP wire
  protocol is deferred to a Phase 7 adapter if remote tool execution needs it —
  tool definitions won't change, only the serving layer. This resolves the
  "tool wiring drift" open question.
- **Q3 — Move `src/main/frontier-analysis.ts` into `src/tools/`.** The runtime
  does NOT import it (verified: `behavioral.ts`/`behavioral.utils.ts`/
  `behavioral.types.ts`/`behavioral.constants.ts` have zero refs). The dep runs
  the other way: `frontier-analysis.ts` imports FROM the runtime. Its only
  non-test consumer is the `verify_frontiers` tool. So moving it next to its
  consumer reflects the true dep direction, not an inversion. The gate (now
  removed) was the only thing that ever pulled it into the engine.

### 2024-09-03 — Gate moves out of the engine into the kernel

- **Decision: the registration gate does NOT live in the engine.** Revert the
  `useAddThread` gate added earlier this session (`behavioral.ts:272-293`):
  `verifyFrontiers` is removed from `useAddThread`; the engine goes back to
  `validateThread → generateRulesFunctions → useThread → running.add`, with
  `add_thread_error` only on schema-invalid / actual exceptions.
- **Rationale:** (1) the plan already said this — Phase 5.5 Layer 1: "Lives in
  `src/agent/`, not the engine — the engine stays domain-agnostic and must not
  pay exploration cost per `useAddThread`." The in-engine gate was drift. (2)
  Moving the gate to the kernel enables **configurable `maxDepth` + retry on
  `truncated`** (the whole point of moving it) instead of a hardcoded `maxDepth:
  10` magic number. (3) The engine calling an MCP *tool* would invert the
  dependency (engine → `src/tools/`); the kernel calls the `verifyFrontiers`
  **function** in-process before `useAddThread` — no protocol round-trip.
- **Coverage:** `src/main/tests/add-thread-gate.spec.ts` is now dead — it tests
  engine gating that no longer exists. Delete it; coverage moves to a kernel
  test when the kernel gate lands.
- **`verify_frontiers` tool stays.** It is the external surface for the
  autoresearch loop; the kernel calls the function directly.

### 2024-09-03 — Frontier gate + verify_frontiers tool

- **One tool, verdict-only.** `verify_frontiers` exposes `verifyFrontiers`
  over the process edge returning `{ status, findings, livelocks, report }`.
  No `computeThreadReward`/`threadGateReward` scalar wrapper — it's RL cargo the
  no-fine-tuning premise jettisons (a scalar exists to feed a gradient; with no
  gradient the agent maps `status → keep/discard` in its own loop), it bakes a
  `truncated` policy the tool deliberately leaves to the caller, and it's a
  pass-through rename of one expression (Runtime Wiring Style violation).
- **Runtime gate policy: positive-proof only.** `useAddThread` admits only on
  `verdict.status === 'verified'`; both `failed` and `truncated` are rejected
  via `!== 'verified'`. No budget-escalation retry at the runtime layer — a
  kernel registration path must not loop on `maxDepth` escalation. The tool,
  by contrast, returns `report.truncated` so an agent autoresearch caller can
  retry `truncated` variants with a higher `maxDepth` (caller policy, not gate
  policy). Two layers, coherent: runtime = strict guardrail, tool = flexible
  surface.
- **Reuse the `add_thread_error` trace kind, enrich the payload.** No new trace
  kind for gate rejection — `add_thread_error` already has `error: unknown[]`,
  which carries `{ code, findings, livelocks, report }`. Schema stays; the
  discriminator moves inside the `error` array.
- **`progress` = event types, not thread labels.** `findLivelocks` matches
  `progress` against `edge.selection.type`. The tool's `progress` describe text
  reads "Event types that count as progress" (code is source of truth).
- **Trust boundary via `validateThread`, not zod.** The tool's zod input makes
  `rules` optional so the MCP framework doesn't reject before the handler runs;
  the AJV `validateThread` (full `IdiomSchema`) is the authoritative boundary
  validator, returning `{ isError, errors }` as structured output.
- **`ok: z.boolean()` + optional verdict fields.** One `outputSchema` covers
  success (`ok:true` + verdict) and error (`ok:false` + `isError`/`message`)
  paths; success vs error is discriminated by `isError`/`ok`, not by schema
  shape (matches `binary.ts`; a `z.discriminatedUnion` was considered but
  rejected for consistency with the existing tool pattern).
- **`once: true` is the verified-fixture idiom.** A looping `request`/`waitFor`
  thread without `once` livelocks under `progress: [label]` (label ≠ the
  requested event, so re-requesting makes no labeled progress). `once: true`
  is also the `deadlock.spec.ts` pattern. Test fixtures for verified threads
  must carry `once: true` or use a non-cyclic rule.
- **`messages` is not exposed by the tool.** The exploration trace prefix is an
  internal `Trace[]` shape an agent caller can't supply over JSON; the tool
  always calls `verifyFrontiers` with `messages: []`.
- **`truncated` is reachable at the self-check tier (resolved empirically).**
  `progress: [label]` only converts *cyclic* would-be-truncations into
  livelock-`failed`; an acyclic-but-deep chain (15 sync points, `once: true`)
  truncates at `maxDepth: 10` with zero findings/livelocks. The gate's
  `!== 'verified'` has two reachable branches — `failed` and `truncated` — both
  covered by `add-thread-gate.spec.ts`. The `truncated`-rejection branch is
  genuine defense-in-depth, not dead code.

### 2024-09-02 — Handler lifecycle

- `disconnect` removed from `Handler<T>` params. Side-effect channel must not
  mutate the listener registry mid-dispatch. Caller-held `Disconnect` is the
  sole removal path (`plan.md` Phase -1).

### 2024-09-02 — defineTool + kernel + spec-valid items

- `useTool` → `defineTool`. Factory is an internal utility in `src/agent/`,
  takes JSON Schema (not Zod), wires only the handler. `ToolDescriptor` type
  lives alongside it.
- `BLOCK_INVALID_TOOL_CALL_THREAD` guard thread removed then **restored**.
  Dispatch-time validation in `kernel.ts` is the sole *schema* gate; the guard
  is defense-in-depth at the tool's own trust boundary (full-envelope block on
  `{ call_id, arguments: inputSchema }` with `detailMatch: 'invalid'`).
- `function_call_output` is now spec-valid: fresh `id` via `ueid()`, `status`
  `'completed'|'failed'`, `call_id` correlation. Per the Open Responses spec
  "Required item fields."
- Tool event detail is a private harness contract `{ call_id, arguments,
  item_id }`, not a spec item shape. `kernel.ts` owns spec-item construction.
- `threads.ts` → `kernel.ts`, `registerAgentThreads` → `registerKernel`.
  The file is the agent kernel, not just "a file of threads."

### 2024-09-02 — Packs + useBehavioral + skills

- Tools are built-in only. Packs never contribute tools — they contribute
  threads + handlers via `useBehavioral`.
- The `packs` object in `plugin.json` maps scopes (`$root` + spaces) to
  behavior-file paths + built-in tool allow/exclude lists + skills
  allow/exclude lists.
- `useBehavioral` is a pure identity wrapper (consumer-side). The harness
  provisioning handler curries scoped hooks and AST-checks agent-generated
  behavior files. Foundation for the self-improving loop (Phase 5.5).
- `provisionDefaults` to dissolve into the kernel's provisioning handler
  (event-driven, not imperative boot). Built-in tools become imports the
  handler iterates for `$root`. **Pending: not yet implemented.**

## Open Questions

- **SUPERSEDED 2026-09-19 (pilot's pushback): validation moves out of the
  controller entirely — no AJV/schemas in the webview or PWA.** The
  controller is a validation-free dumb relay; all validation lives in
  threads (the runtime already ships AJV via detailSchema matching, so
  marginal cost is zero on iOS/PWA). One validation home — no controller/
  engine disagreement fork. Yesterday's DOMParser-in-controller idea dies.
  Mechanics (navigator-recommended shape, awaiting pilot's authoring):
  (a) attrs gate thread = complementary detailSchemas — Rule A (accept):
  propertyNames '^(?!on)' + scheme patterns on URL attrs + style-value
  patterns (expression(/url(javascript:/@import) — the LEAN security subset
  restructured out of ElementAttributeListSchema, not the per-tag monster;
  re-emits the transport-routed type (attrs_render); Rule B (reject):
  allOf[base, not goodAttrs] — matches exactly what A rejects, posts
  attrs_rejected with reason; producers waitFor either outcome.
  (b) HOST ROUTE TABLE LAW: hosts route ONLY gate-emitted event types;
  intent types (attrs_update) are unrouted by construction — bypass is
  structurally impossible. Same mechanism as the workers map.
  (c) Classifier (Jev/System One pattern) at ADMISSION, not render:
  put-time classification of templates/pages/stylesheets feeding the BMeta
  lifecycle (draft = lean-rules-only; stable = classifier-passed); one
  classification amortized across all future renders. Type-2 reasoner =
  the correction loop (classifier rejects with reasons → reasoner rewrites
  → re-admit), not the gate. Model-routing bonus: classification result as
  thread-bidding input to choose the reasoner tier for the next
  response_request — same worker, same wire, no new family.
  WARNINGS: probabilistic gates never own security invariants
  (deterministic floor + probabilistic ceiling division — make explicit,
  prevent future 'simplification'); classifier execution path needed in
  iOS/PWA (remote API vs local small model; offline = drafts can't
  promote, lean rules hold — decide before the store-template flow is
  built).

- **iOS (Tauri/WKWebView) host validation split (pilot's proposal,
  evaluated 2026-09-19).** No Bun host on iOS — useWorkers consumer,
  controller, and DOM share one webview context; HTMLRewriter unavailable,
  so tools/html.ts cannot run there. Resolution: gate-at-the-sink already
  chosen as doctrine, and on iOS the sink-owner IS the controller.
  Recommended split: (a) attrs — inline validateAttribute in the
  controller #attrs handler (pure JS + ajv, portable as-is); (b) render —
  DOMParser inert parse → walk+validate the DOM → insert-or-report;
  strictly safer than desktop's validate-then-setHTMLUnsafe; requires
  extracting validateAndEscapeHtmlRaw's rules from its HTMLRewriter walker
  into a walker-agnostic visitor module — ONE rulebook, two thin walkers
  (HTMLRewriter for Bun hosts, DOM traversal for controller), lockstep via
  the chain-*.html fixtures run through both; (c) CSS stays in the gate —
  css-tree is pure JS, runs in WKWebView; (d) html-scale — pilot's
  render-attached scale validation: controller checks fragment scale
  assumptions against target effectiveScale on render, structured error
  back carrying effectiveScale, agent re-renders; keep scale_check for
  deliberate queries; iOS misses cost a postMessage. The html thread
  stays composition-only (ui_event in, template get, htmlEscape fill,
  render request, error-driven re-render) — byte-identical on both hosts.
  WARNINGS logged: webview-side gates are INTEGRITY not isolation — the
  real iOS security boundary is the Tauri IPC command allowlist (inline-
  handler escapes reach the IPC bridge); and the tools shell worker
  cannot run on iOS at all (tool_call = bash subprocess; no bash in
  WKWebView sandbox) — store validate-before-put and all agent shell
  capability have no iOS execution path today. Biggest open mobile item.

- **Resolved 2026-09-19 (pilot): both families deleted.** git: superseded by
  capable models composing porcelain through the shell worker. typescript:
  scheduled to expire with 7.1's new-and-different API anyway, nothing is
  prod-ready before November, and a TS LSP satellite can be rebuilt later
  against the stable API or `tsc --lsp --stdio` when a consumer exists —
  agents reach either via skills/threads instructing usage, not fleet tools.
  Fleet 27 -> 21.

  **TS7 research (2026-09-19, cited):** the repo pins typescript 7.0.2, so
  typescript.ts already rides the 7.0 `typescript/unstable/*` surface —
  which Microsoft publicly replaces with "a new (and different) API" in
  7.1 (official iteration plan: Beta Oct 6, RC Nov 10, Stable Nov 24,
  2026). The API-tax is therefore a scheduled break, not a risk. Mitigating
  fact: TS7 ships a first-party LSP server (`tsc --lsp --stdio`,
  hover/definition/references/completion/rename; tsserver.js is gone and
  typescript-language-server is superseded). Clean replacement shape: a
  stateful LSP satellite family (long-lived session, standard LSP, async
  → cancel) rather than the one-shot fleet tool. Updated recommendation:
  hold typescript.ts until 7.1, then either port the 4 handlers to the
  stable API or re-cut as the LSP satellite — decided by whether a
  consumer exists by then.
- **html thread design (from the controller/HTMX comparison, 2026-09-19).**
  Controller verdict: htmx's vocabulary (b-trigger/b-target, identical
  swap modes, fragments, dumb client) on LiveView's topology (persistent
  socket, server-held state, push). The html thread is the server-side
  counterpart: waitFor on b-trigger event types (the "route handler"),
  request scale_check → wait result → request render, snapshots as
  rehydration ingress, success/error ids as once-thread correlations. Not
  htmx: no URL routing, no per-interaction request/response mapping.
  Drift flags surfaced: controller.constants.ts header says "hyperscript
  runtime" (stale term — it's an event-binding runtime); ServerMessage
  ingress is unvalidated (MINIMAL: parse-only admission; the validateBPEvent
  gate's home is the HOST SEAM — the useWorkers consumer's useTrigger —
  not the thread, corrected 2026-09-19). **Host seam = trust boundary
  (pilot's proposal, 2026-09-19):** setHTMLUnsafe in #performSwap already
  presumes an upstream gate; the traceListener/useTrigger choke point is
  the only mandatory-by-construction gate. Policy recommended by navigator:
  validate STRUCTURE at ingress (validateBPEvent at useTrigger), ESCAPE
  MARKUP at egress (validateAndEscapeHtmlRaw on every render html before
  transport — setHTMLUnsafe is the only interpreting sink; attrs/dispatch/
  navigate are non-interpreting and need no html escaping). Hosts import
  tool internals directly; agents shell out via tool_call. NO symmetric
  escape-in/unescape-out: escape-at-sink doctrine — data stays canonical
  (raw) inside engine/store/threads, escaped exactly once at the sink;
  nothing is ever unescaped. Violations flow back via existing id acks.
  Open: pilot's "unescaping both ways" — awaiting their intent.

  **escape.ts placement (2026-09-19, after pilot's questions):**
  htmlEscape/htmlUnescape have zero runtime consumers today. Answers:
  (1) NOT in controller.ts — wrong process (browser is untrusted), wrong
  tool (whole-payload escaping destroys markup; the gate is
  validateAndEscapeHtmlRaw), double-escape hazard; setHTMLUnsafe already
  names the caller-validated contract; htmlUnescape browser-side would
  re-arm payloads. Controller stays a dumb relay. (2) Incoming user input
  is NOT html-escaped anywhere — canonical raw form into the engine; the
  ingress gate is STRUCTURAL: the host wraps the trigger useWorkers hands
  it (validateBPEvent before trigger(event)) — single admission point for
  ui_events/snapshots/errors. (3) htmlEscape earns its keep at
  interpolation points in deterministic code only — template-fill helpers
  embedding data into markup (store template → fill slot → host render
  gate as backstop); the model-composed path never needs it (text nodes
  are inert; the render gate handles dangerous attributes).
  **CORRECTION to the prior sink analysis:** attrs is NOT fully
  non-interpreting — setAttribute('onclick',...) arms handlers; style and
  href values are interpreted. Host egress bridge therefore has TWO
  gates: render → validateAndEscapeHtmlRaw; attrs → validateAttribute
  per key/value pair (already exported by html.schemas.ts; the
  html-validate-attribute-value fleet tool wraps it).
  **Gate bundle size (measured 2026-09-19):** validateAndEscapeHtmlRaw via
  its tool wrapper = 331 KB minified / 91 KB gzipped (target=bun).
  Composition: ajv 130 KB (systemic, uncuttable), css-tree 118 KB (the one
  discretionary chunk — style-block CSS validation only), repo code ~85 KB.
  Marginal cost to the real host is zero: the useWorkers consumer (Bun
  process running behavioral) already ships html.ts via cli/tools.ts.
  Browser build is 431 KB but moot — the gate calls the Bun-only
  HTMLRewriter global, so it cannot run browser-side, structurally
  enforcing host-side placement. Build flag: validateAndEscapeHtmlRaw is
  module-private (html.ts:195) — needs a leaf export for the host gate;
  importing html.ts today module-executes all nine defineTool ajv
  compiles at boot (cheap, but a leaf export skips it).
  **Store as the html home (pilot's realization, 2026-09-19):** BMeta
  already models html as a learned artifact (draft/stable/deprecated); the
  html tools are stateless (caller holds the document); the old catalog
  had `html` as a kind. So: store collections (`html-templates` fragments,
  `html-pages` documents, values {html, meta, kind} with meta top-level
  for query). Flows: render-from-template (store get → surgery → render
  push, zero model calls), learn-a-page (validate → meta-stamp → put,
  draft→stable promotion), snapshot persistence (serializedHTML →
  space-scoped store put → rehydration). Spaces: templates root (shared),
  pages/snapshots per-session. Decision to make: git vs store authority —
  app-shipped templates stay git (store = cache/index at most);
  runtime-learned pages are store-native (non-authority durable data).
  Open sub-question: does draft→stable promotion mean export-to-git?
  Elegant, unproven — don't build until a template earns it. Discipline:
  validate-before-put (store op schemas stay generic; html semantics are
  the thread's job at put-time; render-time validation is
  defense-in-depth, not the boundary).
- **Thread-authoring surface (gates the turn-loop proof).** Raw events vs
  thin factories in `src/threads/`; id-minting convention (`ueid`, prefix);
  where model input comes from. Settle by writing the re-cut raw and extracting
  what repeats (the frontier-grammar lesson: build, then derive the rule).
- **Store: sqlite schema evolution policy.** Worker-internal by design; the
  open question is only the forward-compat gate when a future binary bumps
  `schema_version` (v1 assumes forward-compat).
- **Sequencing: frontier-verify vs jq worker bridge.** Two follow-ons from the
  2026-09-18 in-engine transform decision, order pending pilot: (1)
  `frontier.ts` verify/replay must model transform execution (import
  `evaluateTransform`, synthesize the engine's own re-entry threads) — the
  growth-model gate's truth depends on it; recommendation: first. (2) The
  pathological-query hang is fixable via a synchronous Atomics bridge —
  **verified 2026-09-18: Bun main-thread `Atomics.wait` works and worker
  `notify` wakes it (~36ms round-trip)** — spawn worker + SAB
  (status/result), block on wait, `terminate()` on timeout → new reason
  `jq_timeout`; engine stays sync (blocking syscall, not an async yield);
  signature/wiring unchanged. Recommendation: second. Multi-output queries
  stay first-wins (v1); observable `multiOutput` flag is the cheap later
  upgrade.
  **Webview constraint (Tauri mobile):** browsers forbid main-thread
  `Atomics.wait` (and SAB needs crossOriginIsolation), so the sync bridge does
  not carry into the webview — there the engine runs inside a Web Worker with
  the UI thread async over it, and a hung engine worker is killed by the host
  (`terminate()`, turn-level) or by a nested-worker bridge inside the engine
  worker (workers may `Atomics.wait`). Port seam: `Bun.deepEquals` in
  `behavioral.utils` + `frontier.ts` must swap to the pure `deepEqual` in
  `src/utils.ts`.
- **Phase-text fold pending pilot approval (kick removal + PD-thread deletion).**
  With in-engine transforms using useAddThread + the trailing `step()`, the kick
  is now needed only for kernel-bridge re-entry (model/tool I/O); if that
  switches to `step()` too, `KICK_EVENT_TYPE` dies and Phase 1 + 2024-09-03
  action-channel text needs the fold. Phase 3.5 Slice F ("the behavioral thread
  is the remaining deferred work") is moot — the PD thread + spec are deleted
  and the subject lives in agenthub. Fold wording into those phases now?
- **Phase-text fold pending pilot approval (the ingress refactor has landed).**
  Phase 1 ("results re-trigger respond", stream-adapter handler "triggers each
  as a b-event as-is"), Phase 3.5 Slice F, Phase 5 (permission flow triggers),
  and the 2024-09-03 action-channel open-question text all describe internal
  re-entry via `trigger` — fold to the once-thread + kick wording (see
  Decision Log 2026-09-12). All other ingress open questions are resolved in
  the Decision Log entry.

- **The autoresearch loop's task-success metric (Q8/C) — RESOLVED (2026-09-09).**
  The per-candidate keep/discard gate is **`frontier-verify` (safety) AND
  `frontier-replay` over a reference trace reaching the target frontier
  (usefulness)** — both pure functions of thread data (deterministic, no model
  in the gate), making the loop a true hill-climb. A Harbor task eval is the
  outer task-level check (later, not blocking the per-candidate gate). See
  Decision Log Q8/F.

- **Discovery tool schema + kernel progressive-disclosure thread shape.** The
  three tools' mode/input schemas (`mcp-client` 7 modes, `skill-client` 3 modes,
  `discovery` CRUD+search) and the behavioral thread that drives the
  search→pick→load loop still need concrete specification before
  implementation. Order: schemas first (they're the tool contracts), then the
  thread. **Schemas RESOLVED (2026-09-07, Phase 3.5 Slices A–E):** all three
  tools landed as `useTool` units with hand-written AJV `oneOf` discriminated
  unions on `mode` (cast through `unknown` as `JSONSchemaType` — read.ts/
  frontier.ts precedent; no Zod). The behavioral thread is the remaining
  deferred work (Phase 3.5 Slice F, recorded below).
- **`mcp-client`/`markdown` CLI→`useTool` conversion + adapter pool** is the
  Phase 3 conversion deliverable (resolved above); the discovery store +
  `skill-client` + `discovery` tool is net-new — new phase (**Phase 3.5**,
  resolved 2026-09-07; Slices A–E delivered, Slice F deferred).
- **Tool wiring drift — RESOLVED (2024-09-03).** MCP SDK dropped. Tool
  convention is `useTool` (`src/tools/use-tool.ts`): a factory taking
  `{ name, description, inputSchema, outputSchema, run }` where each tool writes
  a concrete `type Input` / `type Output` and annotates
  `inputSchema: JSONSchemaType<Input>` / `outputSchema: JSONSchemaType<Output>`
  — the `behavioral.types.ts` pattern extended to tools. The generic `TInput`
  threads the already-checked type into `run`'s param (no `as` cast at the
  trust boundary). `run` also receives a `validate` object (compiled AJV
  validators for input/output) for handlers that want runtime re-validation;
  currently unused by `ls.ts`. Error path: optional `message?`/`isError?`
  fields on `Output` (same object, not a union — matches `binary.ts`/
  `verify-frontiers.ts`; `JSONSchemaType<Output>` over a union breaks ajv's
  inference, optionals don't). `ls.ts` is the reference conversion; `find.ts`
  (has a `glob`/`pattern` duplicate-schema drift bug the new shape kills) is
  the next conversion target. Phase 5.5 Layer 2 text specified `defineTool`;
  the landed name is `useTool` but the shape matches — minor phase-text fold
  pending.
- **Where does the `ToolDescriptor` dispatch registry live when provisioning
  moves inside the kernel?** Likely the `registerKernel` closure, populated by
  the provisioning handler, read by the `respond` handler — same as today, just
  populated differently. Needs confirmation.
- **How does the provisioning handler get triggered?** `space.created`?
  `plugin.loaded`? Both? What's the ingress event, and who emits it?
- **Does the provisioning handler also handle the `tools`/`excludeTools`
  filtering, or does that happen before the tool list reaches the handler?**
- **How does the small kernel consume `useTrace`?** Direction set (2024-09-03):
  `useTrace` async callbacks ARE the action channel — a listener filtered on a
  selected event type does the side effect and `trigger`s results back; the
  program `waitFor`s the result event, not the listener. **Open sub-questions:**
  (a) how the fixed MCP tool set (`useMCPServer` registrations) is invoked from
  the action listener — does the kernel map selection→MCP-call→trigger, or are
  tools invoked more directly; (b) does the model-stream tool trigger each
  stream event as it arrives (preserving the spec-events-verbatim invariant) or
  batch.
- **Renderer/HTML tool: this pass or Phase 7 pack?** A stateless HTML transform
  tool (caller passes HTML each call) is a clean `src/tools/` shape if the
  Renderer class collapses to pure functions. But the plan routes rendering
  through the Phase 7 pack seam. `html-rewriter.utils.ts` validators stay
  library imports either way (pass-through wrapper = Runtime-Wiring-Style
  violation).
- **Does the `Renderer`/`html-rewriter.utils.ts` move belong in this tool pass,
  or stay a Phase 7 pack-wrapped surface?** A stateless HTML transform tool
  (caller passes the HTML string each call) is a clean `src/tools/` shape if
  the Renderer class is collapsed to pure functions. But the plan routes
  rendering through the Phase 7 pack seam, not built-in `src/tools/`. Decide
  before Phase -2 relocation: collapse the class + add a built-in tool, or move
  to `src/ui/` as a library and wrap in a pack later. `html-rewriter.utils.ts`
  validators stay library imports in either case (pass-through wrapper =
  Runtime-Wiring-Style violation).

- **Desktop/Rust decision map (2026-09-12 — DECIDED, implementation parked
  behind TS-first).** The shape decisions are recorded in the Decision Log
  (2026-09-12: "TS-first", "Cold turn ABI", "Desktop = Tauri; controller
  drops WebSockets"). This map holds the decided shape plus the remaining
  open sub-items and parked conditionals:
  - **Decided shape:** Tauri desktop app (the eventual atproto client); webview
    runs the TS controller; Rust core = shell + per-turn spawner/relay (local
    cold Bun process via stdin/stdout NDJSON) +, someday, atproto client logic
    (OAuth/PDS/Jetstream — Rust side, atrium-rs); no daemon-as-agent-state; no
    listening port on the desktop path. The same controller + message protocol
    serve a future remote hosted agent by swapping the relay target —
    location transparency via IPC-only controller.
  - **Local-PWA pattern — researched fallback (parked):** if Tauri is ever
    abandoned: `behavioral serve` serves the UI at `http://localhost` (installable
    per MDN; localhost is a secure context); same-origin localhost→localhost is
    exempt from Chrome 142 Local Network Access gating, so the WS transport
    would work unpatched; the cost is process lifecycle (installed app can't
    start its server — Jupyter-style UX or launchd) and losing the closed-ingress
    story.
  - **Transport (webview leg) — DECIDED:** controller **drops WebSockets
    entirely** (not dual-carrier; the WS carrier has no long-run home once the
    atproto client is Tauri). Controller change shape (grounded against
    controller.ts — hardwired today at `#socket: WebSocket`,
    `#connectWebSocket()` from `self.location.href`, `#send()` +
    `#messageQueue` flush-on-open, randomized-backoff reconnect): extract a
    minimal transport seam (construct/connect, `#send`, incoming dispatch,
    error/close) into an injected `Transport` in `ControllerConstructorArgs`;
    Tauri carrier primary (`#send` → `invoke('controller_message')`, incoming
    → `listen`/`Channel`, reconnect logic deleted); WS hardwiring removed.
    **Open sub-items:** (1) test/fixture carrier replacement — controller specs
    + serve fixture speak WS today; recommended: in-memory loopback transport
    in specs (simpler + more deterministic than real-WS testing); (2) relay
    policy for page-lifecycle snapshots (pagereveal/pageshow/pagehide/pageswap)
    that fire when no turn is running — drop vs queue-as-next-turn-opener
    (navigator recommends queue-as-opener, consistent with the Q-T4
    dissolution's no-silent-drops rule).
  - **Ingress — settled:** controller messages → `trigger()` (existing
    `validateBPEvent` gate; `ingress: true` request-threads; blockable;
    transform/once-thread re-entry unchanged). Q-T4 (after-stop rule)
    dissolved — the relay arbitrates process lifetime; mid-lifetime triggers
    legitimately re-open super-steps until the stop condition re-evaluates.
  - **Egress — pilot-confirmed pattern A (egress-as-selection):** UI updates
    are requested `ui.*` events whose selections the relay maps 1:1 to
    controller messages (`render`/`attrs`/`navigate`/`dispatch_custom_event`/
    `scale_check`); direct-pipe B rejected in principle. Tool-result →
    `ui.render` request bridging already exists as the dispatch bridge's
    once-thread re-entry (`tool.result`).
  - **Rust conversion (if ever taken up):** data-threads port mechanically
    (the pasted plaited-era code-thread spec does not — no stable Rust
    generators, breaks the model-authors-threads loop); determinism requires
    `IndexMap`/`Vec` + a frozen trace/thread JSON ABI (equal-priority
    tie-breaking is `pending` insertion order + stable sort); AJV→`jsonschema`
    parity is its own test surface; skills/html/Bun stay JS-tier regardless.
  - **Deployed headless, multi-client (2026-09-12, new driver — parked).** The
    pilot raises performance "as a participant in serverless atproto"
    (Cloudflare Workers). Findings from the Serverless Statusphere post: (a) the
    author chose Rust for **library compatibility** (TS atproto libs' `error`
    redirect mode vs the edge runtime), not performance, and recommends TS as
    the natural path; (b) Rust-on-Workers is WASM — single-threaded per isolate,
    no subprocess, no native sockets, same isolate overhead — so native-Rust
    perf intuition doesn't transfer; (c) the turn loop is model-bound (seconds)
    vs kernel super-steps (microseconds) — language is not the scaling lever at
    any plausible client count; (d) the deferred hosted-agent item maps 1:1 onto
    **Durable Object per space** (single-threaded coordinated state, WS
    hibernation ≈ quiescence) and cold-per-turn maps onto isolate-per-invocation
    — the daemon drop is what makes the agent serverless-compatible; (e) Workers
    rules out bash/file tools (no subprocess, no real FS) — deployment shape is
    a **tool-surface question before a language question**; (f) the one
    CPU-bound piece is the autoresearch gate (`frontier-replay`/`verify` — pure,
    deterministic functions of trace JSON) — the strangler target if measured
    compute ever matters, portable without conversion.
  - **Un-deferring triggers:** a GUI does not un-defer the ACP adapter or the
    long-running hosted agent; both stay in "Explicitly deferred" unless the
    pilot explicitly reverses.

  Parked Rust-port branches (activate only if a conversion is later taken up;
  Q-R4's resolution stands in any world):
  - Q-R1: which BP semantics would a Rust engine implement — the current
    `src/behavioral` contract (AJV-validated data threads, ingress channels,
    spaces, transform idiom, trace union) or the pasted plaited-era spec (code
    generators, `EventMatcher` functions, `addRules`/`destroy`, `maxCycleDepth`)?
    The two contradict on priority (registration order vs numeric), thread
    authorship (code vs data), and error handling (deregister-on-throw vs
    declarative-only). Data-threads port mechanically; code-threads don't.
  - Q-R2: determinism contract — candidate collection order is `pending` Set
    insertion order and `sort` is stable, so equal-priority tie-breaking is
    insertion-ordered; a Rust port needs `IndexMap`/`Vec` and a frozen trace/
    thread JSON contract set as the TS↔Rust ABI.
  - Q-R3: skills runtime — skills are Bun-executable TS scripts authored by
    the agent; a Rust harness either keeps Bun as a subprocess runtime or the
    authoring loop breaks.
  - Q-R4 (resolved in principle): `html.ts` rewriter layer already runs on
    lol-html (Bun's `HTMLRewriter` binding) → `lol_html` crate at engine parity;
    custom remainder is `validateAndEscapeHtmlRaw`, `applySwap`/`swapBoundary`,
    scale-check, css-tree validation (no Rust equivalent). Q-R4b: html tools
    in the Rust core (hand-ported validators) vs the Bun sidecar (zero port).
  - Q-R5: migration strategy — big-bang vs strangler (contracts-first, Rust
    `behavioral-core` with trace parity tests, then kernel/dispatch, then CLI,
    tools fleet last).
- **e2e driver for the real-IPC leg — RESOLVED (2026-09-13): build in-repo.**
  A minimal Unix-socket harness modeled on tauri-playwright's server.rs, NOT
  the third-party package. Pilot's reasons: greenfield project this size —
  extra code/maintenance is insignificant; in-repo means debugging without
  third-party concerns; consistent with the minimal-deps directive. The
  package stays logged as a reference implementation (and fallback if the
  in-repo bridge stalls). Consequences: the bridge code is ours to own
  (small: socket listener + eval command loop + result Channel/invoke, per
  the grounded tauri-playwright mechanics above); no third-party capability
  requirements (`withGlobalTauri`, `playwright:default` moot); the `/pw-poll`
  same-origin pattern is a design reference, not a dependency. Bun.WebView
  swap for the DOM-spec layer: pulled forward to the NEXT task 2026-09-13
  (supersedes the earlier later-phase timing — see Decision Log "Bun.WebView
  swap pulled forward").
- **b-form file transfer in the desktop webview — OPEN (charted 2026-09-13,
  does not affect the seam).** `#bindForms` POSTs multipart FormData to
  `window.location.href` (HTTP, never through the controller transport — the
  `form_submit` ClientMessage type has no construction site in controller.ts
  and stays frozen-but-unwired). Post-to-self works only where an HTTP origin
  serves the page; a Tauri webview is `tauri://localhost` static assets — no
  server to receive the POST. Resolution paths by agent location: **local
  agent** — no upload at all; the form carries a path reference and the cold
  Bun process reads the file from disk (large bytes never cross the webview
  boundary; Transport contract stays message-only); **hosted agent** — POST
  to the remote agent's HTTP ingress (the atproto blob-upload pattern,
  reference by CID). Tauri custom-protocol POST handler: parked fallback.
  Server-side ceiling today: `req.formData()` buffers the whole body —
  streaming multipart -> `Bun.file` is the upgrade path if genuinely-large
  uploads are needed against a local HTTP host.

## Phases

**Cross-cutting conventions for every phase:**

- Repo rules in `AGENTS.md` apply (Bun APIs, conventional commits, `test` not `it`,
  no `any`, Zod `.parse()` at trust boundaries, minimal-implementation directive).
- TDD: write the test first; one runnable check minimum per non-trivial logic.
- The behavioral engine's public API is `behavioral()` →
  `{ useAddThread, useTrigger, useAddHandler, useTrace, sendTrace, useEject }` —
  partially applied by **space** (formerly `topic`; see Phase -1). Threads are plain
  data: `{ label, rules: Idioms[], once?: true }`.
- Listeners match on `type` + optional `detailSchema` (JSON Schema, Ajv2020-compiled)
  + `detailMatch: 'valid'|'invalid'`. Handlers match on `type` only (space-scoped via
  partial application).
- The engine lives in `src/runtime/` after Phase -2; all harness code lands in
  `src/agent/`; the render/protocol layer (`src/ui/`) is out of the agent's import
  surface and becomes a pack-wrapped tool later.
- Tools are **built-in only** (wired via `defineTool` in `src/tools/`, Phase 2).
  Packs never contribute tools — they contribute threads + handlers via the
  `useBehavioral` consumer interface (Phase 7). The engine sketch that
  lived at `src/main/behavioral.ts` lines ~400-423 was abandoned (reverted).

---

## Phase -2 — Repo restructure: `src/runtime/`, `src/agent/`, `src/ui/`

**Goal:** the source tree matches the architecture before any agent code lands.
Today `src/main/` flattens the behavioral engine, frontier analysis, renderer,
swap-boundary, and css/html/message schemas into one surface (`src/main.ts`
re-exports all of it). An agent authoring threads needs only the coordination
kernel — the UI machinery is a future tool, not a library import.

**Deliverables:**

- `git mv` restructure:
  - `src/runtime/` ← `behavioral.*` (engine, schemas, types, constants, utils) +
    `frontier-analysis.ts`. The gate needs frontier analysis and it shares types
    with the engine (`replayToFrontier` imports `PendingBid` etc.) — one unit, not
    a separate top-level dir.
  - `src/agent/` ← new home for the harness (Phases 0–6 land here).
  - `src/ui/` ← `renderer.ts`, `swap-boundary.ts`, `html-rewriter.utils.ts`,
    `css.*`, `html.*`, `message.*` — the render/protocol layer. Stays importable
    (`src/controller.ts` consumes the message protocol at SSR time); becomes a
    becomes a pack-wrapped tool later (Phase 7) without another move.
  (`src/tools/define-tool.ts` is the built-in tool wiring utility; the UI layer
  is not a pack-contributed tool — packs contribute threads + handlers only.)
  - `src/cli/` mostly dissolves: `git-context`, `markdown`, `mcp-client`,
    `typescript-lsp` become `defineTool` units (Phase 3) living in `src/tools/`.
    What survives is the entry (`bin/plaited.ts`) and the `makeCli` machinery that
    Phase 6's input parsing / `--schema` surface still uses — relocate that residue
    to `src/agent/` or a minimal `src/cli.ts`; the directory goes away.
- `src/main.ts` shrinks to re-exporting `src/runtime/` only — the public surface
  for thread-authors and pack-authors.
- `package.json` exports: `"."` → `src/main.ts` (runtime), `"./ui"` →
  `src/ui.ts` boundary, `"./controller"` and `"./utils"` unchanged.
- File-naming per AGENTS.md: module-prefixed files keep their prefixes under
  `runtime/` (`behavioral.schemas.ts` etc.); the directory provides context.

**Done when:** `bun --bun tsc --noEmit` clean; full `bun test` suite passes with only
import-path changes; `src/main.ts` exports nothing from `ui/`; no file contents
change beyond import paths.

---

## Phase -1 — Engine: `topic` → `space` rename, declared spaces, `useEject`

**Goal:** spaces (the spatiotemporal paper's spatial axis; vocabulary aligned with
atproto spaces) become first-class: a space groups threads + handlers + tools, binds
are validated, and orchestration code can eject a whole space. Motivation:
`research/Spatiotemporal-Composability-for-AI-Agent-Extensions.md` and the branching
work in Phase 4.

**Design (decided):**

- **A space is just a string identifier.** The engine knows nothing about atproto,
  DIDs, authorities, or tenancy — all of that is expressible as handlers/threads
  bound to a space (e.g. an atproto pack registering a `space.authority` handler).
  The engine's contract stops at: declare, validate, scope, eject.
- Rename `topic` → `space` throughout: `UseAddThread`/`UseAddHandler`/`UseTrigger`
  (and later `useBehavioral`) partial-application params, `RunningBid`/`PendingBid`/
  `CandidateBid`/listener `topic` fields, trace snapshot fields, `generateRulesFunctions`.
- **Declared spaces.** `behavioral()` gains `useCreateSpace` (returns
  `(id: string) => void`; naming consistent with the other hooks). Every
  partially-applied hook — `useAddThread(space)`, `useAddHandler(space)`,
  `useTrigger(space)`, and later `useBehavioral(space)` — validates the space exists at
  bind time and **throws** on an undeclared space. Root (no space argument) stays
  valid — that's the unscoped channel.
- **New trace kind `space_error`** (`TRACE_MESSAGE_KINDS`): a scoped hook bound to an
  undeclared space publishes `{ kind, timestamp, space, operation, error }` on the
  trace publisher *before* throwing (the throw is for the caller; the trace is for
  the system — gate-visible when a generated thread binds against a nonexistent
  space). The trace is emitted by the hook itself, not caught from the throw.
- `useEject(space)` — new member of the frozen API object. Imperative, unblockable,
  orchestration-level only (called from handlers or harness code downstream of a
  triggered ingress event — the *decision* to eject stays gateable at that ingress;
  the eject mechanism itself is a hard floor that generated threads cannot veto).
  - Sweep `pending` and `running`: for bids with matching space,
    `generator.return?.()` + delete (reuses the exact `interrupt` teardown path in
    `resumePendingThreadsForSelectedEvent`).
  - Handlers: `useAddHandler(space)` already returns a per-registration `Disconnect`;
    additionally each registration is recorded in an engine-side per-space registry,
    and `useEject` runs all of them (caller-held disconnects remain valid for
    individual removal — two removal paths, one subscription each).
  - **Eject deletes the declaration.** Post-eject, the space id is undeclared: binds
    against it throw. Re-creating an ejected id via `useCreateSpace` is allowed —
    fresh generation, no zombie state survives the sweep.
  - Observability: publish a new `space_ejected` trace kind, payload
    `{ space, threads: string[] (labels), handlers: number, timestamp }` (+ `step`
    if swept mid-super-step). No synthetic event enters the selection pipeline —
    the event log stays clean.
  - `useAddThread` keeps returning void; the space string is the handle.
  - `behavioral()` stays parameterless (no options bag).
- **Observability asymmetry is intentional:** root `useTrace` sits on the publisher
  and sees every space's traces; a space's consumers only see what their own
  handlers/triggers touch. Space isolation is stamping discipline + the registration
  gate, not a hard VM boundary — hard boundaries come from execution placement
  (Phase 7), not from the engine.
- Algorithm untouched: `computeFrontier`/`selectNextEvent` read the surviving pending
  set fresh each super-step; the sweep happens between steps, exactly where interrupt
  already mutates them.
- Deliberate non-goal: graceful teardown *patterns* (waitFor trapdoor, block as
  withdrawal guard, reverse-dependency shutdown) remain thread-authored conventions
  (proposal §1, §5), not engine machinery. `useEject` is the floor beneath them.

**Done when:** tests prove — binding any scoped hook to an undeclared space throws
*and* publishes a `space_error` trace; eject removes a space's pending + running
threads and its handlers (events of that space no longer dispatch), deletes the
declaration (post-eject binds throw, re-creation works), and publishes a
`space_ejected` trace; other spaces unaffected; frontier computation post-eject is
identical to a program that never had the space; rename compiles with zero behavior
change in the existing suite.

---

## Phase 0 — Open Responses stream contract

**Goal:** define the model boundary as an Open Responses-shaped request/stream, with a
user-provided adapter seam. pi-ai is at most one future adapter, not a dependency.

**Deliverables:**

- `src/agent/open-responses.schemas.ts` — Zod schemas for the minimal request shape
  (`model`, `input` items incl. `function_call`/`function_call_output` with `call_id`,
  `tools`, `truncation: 'auto'|'disabled'`, `instructions`) and the minimal stream
  event union (`OpenResponsesStreamEvent`) incl. terminal-event `usage`
  (`input_tokens`/`output_tokens`/`total_tokens`) and the spec-native `compaction`
  item type (`/v1/responses/compact` returns `{ type: 'compaction',
  encrypted_content }` — sent back as base input; adapters synthesize it for
  providers without a compact endpoint).
- `src/agent/use-response.ts` — `type UseResponse = (req) =>
  AsyncIterable<OpenResponsesStreamEvent> |
  Promise<AsyncIterable<OpenResponsesStreamEvent>>` and
  `type Adapter = { provider, respond: UseResponse }`, plus the `useResponse`
  factory (validate provider non-empty, freeze). Repo pattern: camelCase function,
  PascalCase-of-name type (`useTrigger`/`UseTrigger`). Contract documented: never
  throw, encode failure as a terminal error event. The daemon routes by `provider`
  name; adapters wire through `useResponse`.
- `src/agent/` adapter seam: adapters are plain modules (no `adapters/` nesting —
  with IoC there's no registry to organize). Contract: adapter modules export a
  factory wiring `{ provider, respond: UseResponse }` through `useResponse` —
  the daemon routes model traffic by `provider` name without a lookup map. Scenario
  data for test doubles stays in tests; when `--seed` needs named scenarios the
  daemon reads them from the plugin/`.agents` surface.

**Done when:** tests drive a scripted adapter (a `UseResponse` bound via
`useResponse`) through deltas → terminal error → abort;
`bun --bun tsc --noEmit` clean.

---

## Phase 1 — The agent loop as a b-program

**Goal:** replace pi's `runLoop` with b-threads. Coordination (steering, abort, stop
conditions) is expressed as threads, not callbacks.

**Deliverables:**

- `src/agent/threads.ts` — a file of threads: the turn loop thread (see shape
  below), the stream-adapter handler, the stop-condition thread, and the compaction
  thread.
- **Spec events verbatim — no `llm.*` translation layer.** The stream-adapter
  handler iterates the adapter's `UseResponse` (yielding typed
  `OpenResponsesStreamEvent`s) and triggers each as a b-event as-is:
  `trigger({ type: event.type, detail: <event fields minus type> })`. Phase 0's
  typed events make an invented `llm.*` vocabulary redundant; traces then show
  spec-aligned event types end to end (Phase 4's `toItems` projection reads the
  same types the loop matched on).
- Loop thread reacts declaratively via `detailSchema` matching:
  - tool calls arrive as `response.output_item.done` with `detailSchema` matching
    `item.type: 'function_call'` — no separate toolCall event;
  - terminal wait is the three spec terminal types:
    `waitFor: ['response.completed', 'response.failed', 'response.incomplete']`.
- Cancellation is an `interrupt` on the loop thread's rules, not a separate
  thread: the loop carries `interrupt: [{ type: 'cancel' }]` at each step, so
  triggering `cancel` in the space tears the turn down via the interrupt path.
- Stop-condition as a thread requesting `turn.end`, not a callback.
- **Tool dispatch is handler-side (discovered in Phase 1 implementation).** Threads
  are static data and cannot request dynamically-named events (`<tool name>` varies
  per response). The `respond` handler collects `function_call` items during stream
  iteration and dispatches tool events after the stream completes; the loop thread
  re-awaits `respond` (its first rule waits on `user.prompt` OR `respond`) after
  tool results append via a generic `tool.result` event (engine handlers match
  exact-type only; `<tool name>_result` still fires for trace visibility).
- Loop thread shape (looping, no `once`), each rule carrying the cancel interrupt:
  `{ waitFor: [user.prompt, respond], interrupt: [cancel] }` → request respond →
  `{ waitFor: [terminal types], interrupt: [cancel] }` → (handler dispatches tools;
  results re-trigger respond) → loop.
  The ingress event is `user.prompt`, triggered into the space by the CLI (Phase 6
  input `{ space, prompt }`).
- Stop condition thread **loops** (no `once`): every `response.completed` requests
  `turn.end` — a once-thread dies after turn one and the harness loses the
  turn-done signal for subsequent turns.
- Harness coordination events (`user.prompt`, `respond`, `tool.result`,
  `context.threshold`, `compaction.start/done`, `turn.end`) are legitimate
  vocabulary distinct from spec stream event types; stream events appear verbatim
  as spec types.
- Context management as a b-thread: after each turn's terminal event, a compaction
  thread reads the terminal event's `usage.input_tokens` and compares against the
  model's context limit, declared on the adapter (`Adapter` gains an optional
  `contextWindow: number` — the spec doesn't carry it; adapters know their
  providers). Below threshold it does nothing; at/above threshold it blocks the
  loop's next stream request until a compaction completes (provider compact
  endpoint or adapter-synthesized summary producing a `compaction` item, which
  becomes base input). Use `truncation: 'disabled'` so overflow is a hard,
  catchable error — never silent degradation. The compaction gate is a plain
  block/waitFor pattern; no callback.
- **Phase 0 follow-up (schema gap):** `CompactionItem` is output-only —
  `InputItemSchema` cannot carry a compaction item as base input, so the Phase 1
  compaction handler wrapped `encrypted_content` in a user message (MINIMAL'd).
  Add `compaction` to `InputItemSchema` and feed the real item back as base input.

**Done when:** tests prove — happy path (prompt → stream → tool call → result →
next stream), cancel mid-turn via interrupt, terminal error stops the turn,
threshold crossing blocks the next stream until compaction completes. All
coordination appears as events in traces (assert via `useTrace`); event types in
traces are spec event types, not an invented vocabulary.

---

## Phase 2 — `defineTool` factory (built-in tools)

**Goal:** tools are makeCli-style units wired as handler + descriptor, validated at
dispatch time. Reference: `research/behavioral-agent-harness-proposal.md` §4 (this
section supersedes the abandoned engine sketch) and Phase 1's discovered reality
(threads are static data — dynamic dispatch lives in handlers). Tools are
**built-in only** — packs never contribute tools (Phase 7).

**Deliverables:**

- `src/tools/define-tool.ts` — internal utility analogous to `useBehavioral`,
  taking a pure `ToolArgs` data object (no engine imports, testable standalone) and
  returning a `({ addHandler, addThread, trigger }) => ToolDescriptor` registrar.
  `defineTool`:
  - shape-validates `inputSchema` and `outputSchema` (JSON Schema documents) with
    `JsonSchemaObjectSchema` (the engine's exported single source of truth for "is
    this a JSON Schema document?");
  - validates the tool `name` at registration (non-empty, no `_result` suffix, no
    `tool.result` collision);
  - compiles `outputSchema` via Ajv to validate the tool's return value;
  - registers the handler on event type `name`: reads `{ call_id, arguments,
    item_id }` from the event detail (a private harness contract, not a spec item
    shape), calls `run(arguments)`, validates the output against `outputSchema`,
    and triggers `tool.result` with `{ call_id, output, item_id }`. `threads.ts`
    owns building the spec-valid `function_call_output` (id + status) from that.
  - returns a frozen `ToolDescriptor { name, inputSchema, outputSchema,
    description? }` for the dispatch-time registry.
- **No guard thread.** A block-idiom guard thread here could never fire: dispatch-
  time validation in `threads.ts` only triggers the tool event with already-
  validated arguments, so the block listener was dead code. Dispatch-time
  validation is the sole schema gate. Semantic block-idiom guards are Phase 5.
- **Spec-valid `function_call_output`.** `threads.ts` captures the `function_call`
  item's `id` as `item_id`, threads it through the tool event, and builds a
  spec-valid `function_call_output` in the `tool.result` handler — fresh `id` via
  `ueid()`, `status: 'completed'|'failed'`, `call_id` correlation. Per the Open
  Responses spec ("Required item fields"), every item MUST carry `id` + `type` +
  `status`; the output item is a NEW item (its `id` ≠ the call's `id`; `call_id`
  is what correlates). This makes the items store a spec-valid, round-trippable
  trajectory — `previous_response_id` resume and `replayToFrontier` restore
  (Phase 4) both depend on addressable items.

**Done when:** tests prove valid call → `tool.result` (echoes `call_id`); malformed
call → `tool_call_blocked` + error `tool.result`; two parallel same-tool calls
correlate by `call_id`; a tool schema that is not a valid JSON Schema document is
rejected at registration; the `function_call_output` in the next request carries
`id` + `status` + `call_id`.

---

## Phase 2.5 — Default tool pack (pi-equivalent core tools)

**Goal:** the agent's hands. Reimplement pi's default built-in tools — `read`, `bash`,
`edit`, `write`, `grep`, `find`, `ls` — as `defineTool` units, carrying JSON Schema,
no guard threads, and space-deployability natively (no callback-shaped pi tools).

**Deliverables:**

- `src/tools/` — one file per tool (`read.ts`, `bash.ts`, `edit.ts`, `write.ts`,
  `grep.ts`, `find.ts`, `ls.ts`), each exporting a frozen `ToolArgs` object
  (`{ name, inputSchema, outputSchema, run, description }`) — plain data, no hooks,
  testable without the engine. Schemas are JSON Schema documents (validated by
  `JsonSchemaObjectSchema` at registration); `run` cores are pure async functions,
  errors returned as data (`isError`/structured errors — never thrown). Bun APIs:
  `bash` via `Bun.spawn`
  (`shell -c` interpreter bridge, native `timeout`/`killSignal`) with
  tail-truncated (last 2000 lines / 50KB, UTF-8-safe) control-char-sanitized
  output — the tool `description` carries that contract to the model;
  file tools via `Bun.file`/`Bun.write`; `find`/`ls` via `Bun.Glob`; `grep` prefers
  `rg` (`Bun.which` + `Bun.spawn`) with a JS line-scanner fallback (`MINIMAL:`).
- **`edit` constructs its unified patch — no `diff` dependency, no streaming.** The
  edit location is known (`old_text` → `new_text` at matched line ranges), so the
  patch is built from the edit range with context lines — ~dozens of lines,
  deterministic, no Myers/LCS. Port pi's line-ending helpers
  (`detectLineEnding`/`normalizeToLF`/`restoreLineEndings` pattern from
  `packages/agent/src/harness/tools/edit-diff.ts`); fuzzy-match normalization is a
  `MINIMAL:` defer. Enforce match discipline: `old_text` must match exactly once
  unless `replace_all`.
- **The bun-runtime skill governs API choices** (`~/.agents/skills/bun-runtime/`):
  verify Bun APIs via its Mode 1 lookup (`plaited mcp-client` →
  `https://bun.com/docs/mcp`, `search_bun`) instead of asserting from memory;
  no `node:fs` (Node `node:path` is fine); no Python/heredocs.
- pi's harness tools (`packages/agent/src/harness/tools/`) are **behavioral
  examples only** — fetch via `gh` for semantics (match discipline, truncation,
  result shapes), never for code (TypeBox, `diff` dep).
- `src/agent/provision-defaults.ts` — the harness-side provisioner: imports the tool
  data from `src/tools/` and wires each via `defineTool`;
  `provisionDefaults(rootHooks)` registers all seven at root. Provisioning is
  harness code (the agent decides what activates where); the tool data stays pure.
- Space-deployable variants: the same `ToolArgs` data provisions into any space
  via space-scoped hooks; a policy pack can substitute a restricted variant
  (read-only set, remote-executing `bash`).
- These are the critical path to a useful agent — the CLI conversions (Phase 3) are
  additive on top.

**Done when:** each tool passes schema validation at registration (Phase 2); tests
drive each through a b-program (trigger call → `tool.result`); dispatch-time
validation blocks a malformed `bash` call and emits `tool_call_blocked`; provisioning
the same tool at root and in a space works independently (space-scoped result
events).

---

## Phase 2.75 — Binary tool & multi-modal input

**Goal:** the agent reads binary files, detects image/audio/video MIME types via
magic bytes, encodes as base64 — so it can feed multi-modal content into model
requests. The Open Responses input schema carries `input_text`, `image`, `audio`,
and `video` content part types, matching the spec's multi-modal
`MessageItemParam.content`.

**Deliverables:**

- `src/tools/binary.ts` — frozen `ToolArgs` object following the Phase 2.5 tool
  pattern: reads a file via `Bun.file(path).bytes()`, detects MIME type from
  **offset-aware magic bytes** (RIFF/ftyp containers match the format tag at
  offset 8, per pi's `image.ts`), encodes as base64, returns
  `{ mimeType, base64, bytesRead, width?, height?, imageFormat? }`. Detection
  covers JPEG, PNG, GIF, WebP, BMP (image — BMP needs a structural check, plain
  text can start with "BM"); MP3, WAV, OGG, FLAC, AAC (audio); MP4, WebM, AVI,
  QuickTime (video) — WAV/AVI/WebP share the RIFF container, discriminated at
  offset 8. Error results (isError + message, never thrown) for missing files,
  directories, and over-ceiling files.
  **No maxBytes truncation input** — binary truncation produces a corrupt,
  uninterpretable blob; instead a hard ceiling (conservative default, a few MB
  binary) errors over the ceiling — **the limit comes from the active adapter's
  declared capabilities, not a pack constant** (Phase 7: adapters declare what
  they accept and their limits; error messages name the limit and the declaring
  adapter). Edge models (Gemma 4 E2B-class, small context windows) and server
  models get correctly sized guidance from the same pack.
  (verified API — reads width/height/format without decoding pixels; pass bytes,
  never path strings — arbitrary-file-read primitive). Graceful absence on
  exotic/undecodable formats.
- Input content parts in `src/agent/open-responses.schemas.ts`: `input_text`,
  `image` (`data:` URI), `audio` (`data:` URI + format), `video` (`data:` URI +
  format) as a discriminated union distinct from output-side content parts.
  `MessageItemParamSchema.content` accepts `InputContentPart[]`.
  The handler converting `tool.result` into the next `respond` request
  switches on MIME prefix to build the correct content part type (`image`,
  `audio`, `video`) — this is a ~5-line MIME-to-format mapping, no ffprobe
  needed because magic-byte detection already identified the format.
- Wire in `provision-defaults.ts` via `defineTool`.
- Tests: MIME detection unit tests (incl. the RIFF-container disambiguation),
  `Bun.Image.metadata()` dimension extraction on image formats (absent gracefully
  on exotic/undecodable files), file-not-found error path, hard-ceiling rejection,
  input content part schema validation.

**MINIMAL:** no audio duration or video codec extraction. Image dimensions via
`Bun.Image.metadata()` (bytes input, never path) are included for image MIME
types; absent gracefully on exotic/undecodable formats — no gate flag.

**Done when:** `bun --bun tsc --noEmit` clean; `bun test` passes for binary tool
and input-content-part schema tests; `provisionDefaults` wires `binary` at root;
an integration-style test reads a PNG fixture, feeds the data-URI as an `image`
content part in a `respond` request, and the adapter sees the base64 image in the
input.

---

## Phase 3 — Convert `src/cli` units to `defineTool` tools; dissolve `src/cli/`

**Goal:** `git-context`, `markdown`, `mcp-client`, `typescript-lsp` become agent tools
alongside the defaults. The CLI surface they came from goes away — bare `plaited` is
the agent (Phase 6); the only surviving CLI machinery is the entry + `makeCli`.

**Deliverables:**

- Per unit: extract the `run(input)` body into a pure async core
  `(input) => output`, wrap as a `ToolArgs` object, and add as a tool file in
  `src/tools/` (`git-context.ts`, `markdown.ts`, `mcp-client.ts`,
  `typescript-lsp.ts`); `provision-defaults.ts` wires them via `defineTool`. `makeCli`
  keeps parse → core → validate → print for direct CLI use where still needed.
- Move the surviving CLI residue (`makeCli`, request parsing, schema printing) out
  of `src/cli/` — it exists to serve `plaited`'s input/`--schema` surface, not a
  multi-command tool surface.
- Envelope: tool input/output details carry `call_id` top-level (stamped by the loop).

**Done when:** the four tools pass Phase 2.5-style b-program tests (trigger call →
`tool.result`, malformed blocked); they provision at root and into a space;
`src/cli/` is gone; the four tools' prior behaviors are reachable through the agent
(not as standalone subcommands).

---

## Phase 3.5 — MCP/skill discovery: search-mediated progressive disclosure (tools)

**Goal:** three stateless built-in `src/tools/` units + a shared adapter
connection pool, so the kernel can orchestrate a search→pick→load
progressive-disclosure loop over remote MCP tools and local skills. Implements
the 2026-09-07 Decision Log entry. The tools are dumb primitives; the smarts
live in a kernel behavioral thread (Slice F, deferred — recorded below).

**Scope split:** the tool primitives (Slices A–E) are delivered; provisioning
+ the orchestration thread (Slice F) is a **separate, separately-tackled** body
of work, not folded into this phase's deliverables.

**Deliverables (delivered):**

- **Slice A+B — `mcp-client` useTool + adapter pool.** Converted
  `src/tools/mcp-client.ts` from `makeCli` to the `useTool` shape
  (`{ name, description, inputSchema, outputSchema, run }`, concrete
  `Input`/`Output`). All seven modes survive (`call-tool`/`list-tools`/
  `list-prompts`/`get-prompt`/`list-resources`/`read-resource`/`discover`) as a
  7-branch `oneOf` on `mode` (hand-written AJV, cast through `unknown` as
  `JSONSchemaType`). `src/cli/mcp-client.ts` untouched (read-only reference).
  Connections route through `src/kernel/use-plugin-adapter.ts` (renamed from
  the empty `use-plugin-adaptert.ts`): `Map<serverUrl, { client,
  connectPromise, discovery }>` lazily connected, evicted on connect failure,
  closed on teardown — the pi-extension `getSharedClient`+
  `session_shutdown`→`closeSharedClient` pattern. The adapter owns no discovery
  data.
- **Slice C — v2 keychain OAuth provider.** `BunKeychainOAuthProvider`
  (`src/kernel/oauth/`) implements the v2 `OAuthClientProvider` shape from
  `@modelcontextprotocol/client`: issuer-keyed `clientInformation(ctx)`/
  `tokens(ctx)`/`saveTokens(tokens,ctx)`/`saveClientInformation(ci,ctx)`,
  `state()`/`saveDiscoveryState`/`discoveryState`, `validateResourceURL`
  (RFC 8707 origin binding → `IssuerMismatchError`), `invalidateCredentials(scope)`,
  `prepareTokenRequest`/`addClientAuthentication`. Refresh tokens + client info
  persist to the OS keychain via `Bun.secrets` (`BunKeychain`; `InMemoryKeychain`
  is the test double — the only mocked boundary). The hand-rolled
  `buildOAuthRequest`/`exchangeOAuthTokens`/file persistence under
  `~/.plaited/mcp/tokens/` are deleted; the v2 SDK's `auth()` orchestrator does
  RFC 9728 discovery + the token exchange. One provider per server-url, reused
  across process restarts. The adapter pool migrated to the v2
  `@modelcontextprotocol/client` `Client` + `StreamableHTTPClientTransport`.
- **Slice D — `skill-client` useTool (new).** Three modes (`discover`/`read-skill`/
  `list-resources`) mapping to the agentskills.io tiers (metadata → full
  instructions → bundled-resource preview). Own frontmatter parsing (no import
  from `src/cli/markdown.ts`); lenient validation per spec (warn-but-load on
  name/dir mismatch + length; skip+warn on unparseable YAML + missing/empty
  description); project-level overrides user-level on name collision.
  `src/cli/markdown.ts` untouched (read-only reference).
- **Slice E — `discovery` useTool (new).** Five modes (CRUD + `search`) over
  `.plaited/discovery.sqlite` (`bun:sqlite`), unified `kind: 'mcp-tool' |
  'skill'` rows (`id`, `name`, `description`, `handle`, `metadata_json`,
  `updated_at`). The only tool that touches the store. `dbPath` is
  **provisioner-injected** via `createDiscoveryTool({ dbPath })` — deliberately
  absent from the model-facing schema, so a model-supplied `dbPath` is rejected
  at the boundary (`additionalProperties: false`). Not git-backed — local
  SQLite, regenerable.

**Deferred — Slice F (separate body of work):**

- Provision the three primitives via `src/kernel/provision-defaults.ts` so they
  are reachable through the agent. Resolve `.plaited/discovery.sqlite`
  (discovery `dbPath`) and the MCP OAuth keychain against the project root.
- The kernel progressive-disclosure behavioral thread driving the loop:
  `mcp-client discover` / `skill-client discover` → `discovery create/update`
  (persist); `discovery search(query)` → candidates (tier 1); model picks →
  `mcp-client call-tool` or `skill-client read-skill` (tier 2); continue.
  Expressed as `waitFor`/`request`/`trigger` over the fixed built-in tool set
  (plaited-runtime skill patterns). Tools stay dumb.
- Until Slice F lands the three primitives are built, tested, and importable but
  **dormant** — not wired into any provisioner or the agent loop.

**Invariants holding:** the Phase 2/7 "built-in tools only" invariant is intact —
the three primitives are (will be) provisioned, but discovered remote MCP tools
are **never** registered as first-class tools. State this positively so a
reviewer doesn't "fix" it wrong. No static skill catalog in the system prompt
(the deliberate deviation from agentskills.io Step 3 — marked `MINIMAL`). The
store is not git-backed (distinct from Phase 4's git-backed trace logs).

**Done when (Slices A–E):** `bun --bun tsc --noEmit` clean on the changed
surface; `rg "from '.*cli/mcp-client|from '.*cli/markdown" src/tools/
src/kernel/` empty; targeted tests per slice green (55 total: mcp-client 12,
keychain 9, skill-client 15, discovery 19). Slice F has its own done-when under
its separate tackling.

---

## Phase 4 — Space context & persistence

**Goal:** a space is the unit — no "session" abstraction. A space's context is its
event history (traces) plus the threads/tools provisioned in it; persistence is
artifact-based, not a session subsystem.

**Deliverables:**

- `src/agent/space-trace.ts` — per-space trace capture: subscribe via root
  `useTrace`, partition by the space field already present on candidate/selection
  snapshots, append JSONL per space (plus a whole-program log for the running agent).
  The log records thread/tool *registrations* as well as selections — restore
  (below) needs the provisioned set, not just the event stream.
- Projections from a space's trace log:
  - `toItems(log)` → Open Responses item list (function_call /
    function_call_output by `call_id`) — what the model boundary consumes.
  - `toHtml(log)` → human-readable rendering of the space's history.
- Git-backed artifact storage: durable space state (authored thread definitions,
  generated code, trace logs) commits to git — the artifact store, not a bespoke
  database.
- **Restore** a space via `replayToFrontier` over its stored trace prefix, then
  re-provision its threads from their stored definitions, then continue live.
  (Use "restore"/"replay" — not "rehydrate", which carries DOM-rendering
  connotations from the UI layer.)
- Branching = child spaces (a branch is a space partition); abandoning a branch is
  one `useEject(branchSpace)` call (Phase -1). No sub-agent abstraction —
  delegation is child spaces + a root bridge handler forwarding a single result
  event (controlled membrane, gate-visible, ejectable).

**Done when:** tests prove — run a space → persist trace log → fresh program
restores an identical frontier via `replayToFrontier` and identical Open Responses
items via `toItems`; a branch space leaves the original line intact; ejecting a
branch deletes only its artifacts.

---

## Phase 5 — Policy as threads: the default guard pack

**Goal:** no built-in allow-once/allow-always machinery. Guards are threads terminated
by `interrupt` on approval events.

**Deliverables:**

- Guard threads per guarded call: `{ block: [callListener],
  interrupt: [approvalFor(call_id)] }` — policy blocking designed with the
  call_id-correlation problem solved (Phase 2's dispatch-time validation covers
  malformed inputs; this layer covers semantic policy).
- Permission flow: blocked guarded call → `permission.ask` event → handler emits a
  JSON `permission_required` output → the human's answer arrives as a follow-up
  `plaited` command carrying `permissionAnswer` (serve mode: next command to the
  running process; `--no-serve`: next invocation's input) → `permission.resolved`
  trigger → guard interrupted → the pended call becomes selectable. Deny path
  requests the tool's error result so the model sees the refusal.
- Standing policy threads are composable additions (e.g. auto-allow reads under src/).
- Registration gate: the harness wraps `useAddThread` with a `verifyFrontiers` call
  on new thread rules *before* admission, per
  `research/differential-frontier-gate-stable-reward.md` (`verified` admits,
  `failed` rejected with `add_thread_error` trace, `truncated` per policy).
  Full layering in Phase 5.5 Layer 1.

**Done when:** tests prove — guarded call blocked until approval; approval interrupts
the guard and the call executes; deny produces an error `_result`; a malformed or
deadlocking generated guard is rejected by the gate.

---

## Phase 5.5 — Eval loop (autoresearch): gate, tool, observer, skill surface

**Goal:** the self-improving loop from
`research/talk-self-improving-agents-from-behavioral-exhaust.md` — an agent reads its
own exhaust and iterates. Three *separate* gate/observer mechanisms (kept distinct to
avoid meta-regress) plus the third mutable surface (skill text):

**Layer 1 — Registration gate (harness-side; owns the definition).** The harness wraps
`useAddThread` and calls `verifyFrontiers` on the new thread's rules *before*
admission. `verified` admits; `failed` rejects with `add_thread_error`;
`truncated` per policy. Lives in `src/agent/` (not the engine — the engine stays
domain-agnostic and must not pay exploration cost per `useAddThread`). This is the
gate spec'd in `research/differential-frontier-gate-stable-reward.md`. Phase 5
references this layer; this is the single definition.

**Layer 2 — `verify-frontier` tool (agent-callable self-check).** A `defineTool` unit
exposing `verifyFrontiers` inside the b-program:

```
input:  { threads: Thread[] }        (Zod schema; pure candidate data)
output: { status: 'verified'|'failed'|'truncated', findings, livelocks }
```

The agent authors a candidate `Thread[]`, requests `verify-frontier`, waits for
`verify-frontier_result` (correlated by `call_id`), and keeps/discards the candidate
by verdict. **No regress:** the gate operates on the candidate *data* (its own
`pending` set per `exploreFrontiers`), never the live program's frontier — so the
agent verifying a candidate never recurses into verifying itself. The verdict symbol
(`verified`/`failed`/`truncated`) is the in-context training signal (symbol-tuning):
prior `(thread-shape → verdict)` pairs feed the next generation.

**Layer 3 — `useTrace` observer callback (controller-side).** When the orchestrator
(agent A) sets up worker instances (1-n), it passes a `useTrace` listener per worker
program. `useTrace` subscribes to the trace publisher — *outside* the event/action
loop — so it observes without participating: traces never become selected events and
cannot re-enter a worker's frontier. This is the controller's oversight channel
(worker deadlocks, errors, progress), distinct from the worker's own gate (Layer 2).

**Layer 4 — Skill surface (third mutable surface).** Threads and tools gate
symbolically (worker-side, Layer 2); skill text is prose and needs an LLM judge —
so it judges *controller-side*, matching the neuro-symbolic split (worker proposes,
controller disposes):

- `skill` tool (`defineTool` unit, built on the Phase 3 `markdown` core):
  `read-skill` / `write-skill` / `validate-skill` (frontmatter + link validation).
  The agent edits its own skill text through these.
- Judge callback: a controller-side `useTrace` listener (Layer 3 wiring) that, on a
  `skill.proposed` trace, calls an Open Responses judge endpoint — the `judgeJson`
  pattern: one stateless `complete` call `{ model, system, user }` → strict JSON
  verdict (see the DeepSearchQA grader). No external eval harness — the judge is a
  UseResponse/adapter call like any other. The controller then triggers `skill.scored`
  back into the worker's space; the worker keeps or discards the variant.

**The reward function** (`computeThreadReward`: `verified`→1, `truncated`→0,
`failed`→-1) is a pure function of the Layer 1/2 verdict — lives in `src/agent/`
with the eval loop, not the engine.

**Candidate sandbox:** one space per rollout — create, register the verified
candidate, observe in isolation, `useEject`. Reuses Phase -1/4 machinery; no new
engine work. The generator (the agent authoring variants) runs under `--seed`; the
symbolic gate is a pure function and does not consume the seed; the sandbox is a
space. Three separation-of-concerns mechanisms, never conflated.

**Done when:** the agent calls `verify-frontier` on a candidate and receives a
verdict; a `failed` candidate is discarded and a corrected one re-gated; the
controller observes a worker's deadlock via its `useTrace` callback without the
worker reacting to it; a candidate executed in its sandbox space leaves the root
program's frontier identical after eject; a proposed skill variant is judged by the
controller callback and the score event lands in the worker's space.

---

## Phase 6 — CLI entry: `plaited` (cold invocation, gated ingress, dev server)

**Goal:** `plaited` is a normal cold CLI agent — JSON-in/JSON-out, no TUI, no
daemon. There is no warm process: each invocation runs to turn-end and exits.
External actors (a cron job, an atproto space event, Harbor) invoke `plaited`
per trigger through a gated ingress. The interface is the same one the
autoresearch loop and Harbor tasks already drive. (Supersedes the 2024
serve-default daemon model — see Decision Log 2026-09-07 "No daemon".)

**Deliverables:**

- `plaited` (no subcommand) — cold-run a turn in a space. Input
  `{ space, prompt, (optional) permissionAnswer }` → restore the space's
  context from its artifacts (Phase 4) → run to turn-end → persist → print
  JSON. The space is a project folder (Q6/A); one invocation, one space.
- **Gated event ingress.** External triggers must not inject arbitrary events.
  A public-event registry (CRUD-able store, discovery-sqlite pattern) holds
  allowed events as `{ type, space, schema }`; an external trigger is admitted
  only if its type+space is registered and its detail validates against the
  schema. Unauthorized/malformed events are rejected at the boundary. The CLI
  prompt path is the one built-in ingress; everything else registers a public
  event. (Q1/B)
- **Scripted-model validation mode** — `plaited --seed <n>` runs against the
  scripted model seam (the deterministic, no-network model used by the kernel
  turn loop). Deterministic, reproducible: the same seed reproduces a turn
  bit-for-bit. Scope note: `--seed` seeds the *generator* (the model stream);
  the frontier gate (`frontier-verify`) is a pure function of thread data and
  is already deterministic — it does not consume the seed.
- **Generative-UI dev server.** `plaited` (or a `plaited ui` subcommand)
  spins up a local dev server built on `src/controller/` + `src/tools/html.ts`
  serving the memory + shared human-agent context UI over WebSocket (Q5).
  The agent renders into it via `html-render`/`html-update-attributes`; the
  human selects a space and collaborates there. The server is a space-local
  surface, not the agent host.
- Root provisioning at startup: the default plugin (Q2 — `skills/behavioral/` +
  `threads/` + `mcp.json`) + the built-in tool set at root; spaces get
  subsets/variants per their allow/blocklists (Q4).

**Done when:** `plaited '{"space":"s1","prompt":"..."}'` completes a turn cold
(no daemon) and prints JSON; `plaited --seed 42` reproduces a turn bit-for-bit
twice; an unregistered external event is rejected at the ingress boundary and a
registered one with a schema-valid detail is admitted; a guarded action returns
`permission_required` and a follow-up `plaited` command completes it; a second
space stays isolated; the dev server serves the memory UI over WebSocket and
reflects an agent-driven `html-render`.

---

## Phase 7 — Extension packs & deployment patterns (pattern surface)

**Goal:** document and enable the pack ecosystem. Aligned with pi's
containerization doc structure (a menu of deployment patterns, not a feature),
minus the experimental micro-VM row.

**Pack contract:**

- A pack is a plugin directory in Agent Plugins format: `plugin.json` manifest plus
  component directories. A pack contributes **threads + handlers** (behavioral
  units), never tools — tools are built-in only (Phase 2). The client-extension
  namespace `dev.plaited/` declares a `packs` object in `plugin.json`:
  ```json
  {
    "extensions": {
      "dev.plaited": {
        "packs": {
          "$root":   { "behaviors": ["./b/compaction.ts"], "tools": ["read","bash"], "excludeTools": ["bash"], "skills": ["tdd","typescript-lsp"], "excludeSkills": ["grilling"] },
          "research": { "behaviors": ["./b/search.ts"], "tools": ["read","grep","find"], "skills": ["you","mdn-web-docs"] }
        }
      }
    }
  }
  ```
  - `$root` is the default key — behaviors and tool/skill config at root scope
    (no space). Every other key is a space/topic name.
  - Each space entry has up to six fields:
    - `behaviors` (file paths) — `useBehavioral` exports, AST-checked before
      admission (the self-improving loop's mutable surface, Phase 5.5).
    - `tools` / `excludeTools` — built-in tool name allow/blocklist (Phase 2).
    - `skills` / `excludeSkills` — skill name allow/blocklist. Skills are
      *instructions loaded into context*, not function-call-dispatched tools, so
      "allowing" a skill means including its SKILL.md content in the agent's
      context for that space; "excluding" means don't load it. Root skills ship
      with the plugin; spaces narrow. The governance shape mirrors tools.
- **The behavior export unit is `useBehavioral(callback)`.** Each file listed in
  `behaviors` is imported; its named exports are all `useBehavioral(...)` results.
  The harness's provisioning handler (harness-side, `src/agent/`) reads the space
  key from `plugin.json`, curries `useTrigger(space)` / `useAddHandler(space)` /
  `useAddThread(space)` into scoped variants, and invokes each export with those
  scoped hooks. Because the files are agent-generated, each export is AST-checked
  before admission — this is the foundation for the self-improving loop
  (Phase 5.5): behavior files are a mutable, agent-editable surface, and writes to
  them are observable events that trigger the verify-then-register cycle.
- `useBehavioral` (consumer-side, `src/agent/use-behavioral.ts`) is a pure identity
  wrapper — its only jobs are to guarantee the export's shape and fix the param
  shape. The callback receives `{ addThread, addHandler, trigger, useTrace }`
  (pre-scoped). The callback's own scope is where co-designed handlers/threads share
  state and `Disconnect` handles — a sibling handler can remove another via the
  caller-held `Disconnect` that `addHandler` returns (Phase -1). `useTrace` is
  included so a self-improving agent can observe its own behavioral exhaust
  (`research/talk-self-improving-agents-from-behavioral-exhaust.md`).
- `useEject(space)` unwinds a pack's space entirely (threads + handlers).
- **Adapter discovery:** a plugin may declare adapters via the client extension
  field in `plugin.json`:
  ```json
  { "extensions": { "plaited": { "adapters": ["./adapters/anthropic.ts"] } } }
  ```
  Paths are relative to the plugin directory; the daemon imports each module's
  default export (the factory contract from Phase 0). Wrong shape = skip + report
  (fail-soft per the plugin spec's component-failure principle). Security note:
  activating a plugin imports its adapter code with daemon privileges — same trust
  boundary as pi extensions.
- Space semantics (authority, membership, atproto binding, tenancy) are pack-level
  concerns expressed as threads/handlers — never engine concerns.

**Deployment patterns (operator concerns, documented not enforced):**

- **Remote tool execution (default posture).** Tool execution is never co-resident
  with the agent runtime. `defineTool`'s `run` is the only execution point, so a
  built-in tool whose `run` delegates over IPC/HTTP/SSH is indistinguishable to the
  engine from a local one. Default tool packs ship remote-capable `run` cores;
  deployment chooses the target. (No specific micro-VM endorsement.)
- **Adapter capabilities are declared, and tools honor them.** An adapter (or its
  settings entry) declares what the bound model accepts and its limits — e.g.
  multi-modal content types accepted (`image`/`audio`/`video`), per-part byte/
  context budgets, context window. Tools and handlers consume that declaration:
  binary/multi-modal caps are enforced against the *active adapter's* declared
  limits (not a pack constant), and over-limit tool-call error messages name the
  limit and the adapter that declared it — so a Gemma-class edge model and a
  server model get correctly sized guidance from the same pack.
- **Whole-process container** — run `plaited agent` itself in Docker (pi's plain-Docker
  pattern). Keys and mounts are the operator's call.
- **Inference gateway** — an Open Responses stream adapter that routes model traffic
  through a credential-injecting gateway (pi's OpenShell pattern). Falls out of the
  Phase 0 adapter seam for free.

**Done when:** docs section published; one example pack (e.g. the default guard pack
from Phase 5 repackaged) demonstrates the contract end-to-end including ejection.

---

## Adoption invariants (not features)

Properties the core must preserve so future directions stay open without the core
committing to them. These are constraints on how we build the phases above, not new
work:

- **The engine never imports atproto.** Spaces remain bare string ids; authority,
  tenancy, and membership are pack-level concerns expressed as threads/handlers.
- **Trace logs stay append-only and ordered.** No rewrites or reordering — a
  self-certifying signed-commit sync shape (CAR/MST) requires it later. Phase 4's
  JSONL is already this; don't break it.
- **Packs are the only integration seam.** Network, identity, sync, and rendering
  concerns (atproto spaces, cloud mirrors, GUI lexicons) bind through the Phase 7
  pack contract. Some packs will run as sidecar processes — the contract already
  permits this since `run`/handlers are plain async functions.
- **Artifacts are complete.** Anything durable (trace logs, thread definitions) is
  sufficient to verify/replay on its own — `replayToFrontier` already demands this.
  Author identity (signing, DIDs) is attached later by a pack, not baked in.
- **The trace log is also the corpus-eval substrate.** Append-only, complete,
  query-able per space — the same artifact a batch/corpus eval (aggregate analysis
  over many runs, e.g. tool-budget / read-discipline / param-compliance queries over
  `trial.trajectory`-style data) consumes. Keep it projection-friendly; don't
  foreclose a dataset-eval service built on it later.

No deployment topology is prescribed: local-only, cloud, local-with-cloud-mirror are
all operator choices the design must remain compatible with.

---

## Explicitly deferred

- ACP adapter (any version) — revisit when a real client (GUI or Zed) is needed.
- NDJSON warm-process mode — only if per-invocation replay latency hurts.
- v2 notification lifecycle, multi-client, remote transports.
- Long-running hosted agent (REST + WebSocket, per-user spaces) — the spaces
  vocabulary exists to make this possible later; the transport and tenancy layers
  are their own project.
- atproto identity/sync/lexicon packs (agent DID + user DID, trace commits as
  signed records, cloud-mirror PDS, behavioral-rendering lexicon for a future GUI) —
  bind later via the pack seam; no core dependency. Gated on atproto spaces
  stabilizing out of alpha. **(2026-09-12: the pilot has stated the eventual
  client intent — a Tauri atproto client — so the "future GUI" trigger is now
  named; the server-side pattern reference is the Serverless Statusphere post.
  Still deferred until TS agent completion.)**
- Dataset/corpus eval service (aggregate analysis over many persisted trace logs —
  the third leg alongside the per-thread symbolic gate and the iterative
  autoresearch loop). All three consume the same trace-log artifact; the corpus
  layer is a pack/service concern, not core.
- No session abstraction, ever: the space is the unit. Session-like behaviors
  (restore, branch, history) are space operations over artifacts.

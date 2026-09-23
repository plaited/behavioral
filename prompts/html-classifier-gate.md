# Research + build prompt: the schema-context classifier for runtime-generated html

Task: research and build the **classifier layer** that judges html generated
by consumers of `useWorkers` — a local PWA or a Tauri mobile app runs the
whole runtime (engine + satellites) in one context and **generates html at
runtime**; the classifier decides whether what was generated is valid
before it reaches the controller. **Read the 2026-09-19 Decision Log
entries in `plan.md` first — the store behavior, the controller floors, the
html-tool consolidation, and the OKF-HTML north star are the authority
for this prompt.**

Ground rules: TDD red-green per slice; `bun --bun tsc --noEmit` +
targeted specs per phase; one conventional commit per phase; `AGENTS.md`
conventions throughout. Nothing in this prompt weakens the deterministic
floor — see Phase 0's invariant.

## The pattern (what the consolidation just established)

The html fleet tools are **deleted, permanently** — they rode
`HTMLRewriter` (a Bun-only global) and AJV compilation, which cannot run
in either target host (WKWebView / local PWA). In their place, three
layers with one job each:

1. **Schemas as data — `src/controller/css.schemas.ts` +
   `src/controller/html.schemas.ts`.** Pure JSON Schema objects, no ajv
   import, no validation functions (`validatePTrigger` and friends are
   gone — the code, not the vocabulary, was the old shape). These live
   in the controller directory because they are (a) the floors'
   vocabulary and (b) the classifier's context. The generator
   (`scripts/css-schemas/`) emits schema-only output and CI's drift
   check enforces byte-stability against the checked-in file —
   **schema evolution is a regenerating event, never a hand-edit.**
2. **Deterministic floors — `controller.utils.ts` + `controller.ts`.**
   Hardcoded invariants (no AJV): `isInvalidTrigger` (the b-trigger
   pair grammar — the rulebook, unified: empty = invalid everywhere,
   same semicolon grammar as the surviving schema context),
   `detectXssVectors` (inline handlers and friends on pushed fragments),
   id-correlated errors back to the agent. These own the security
   invariants. **A probabilistic gate never owns one** — if the
   classifier is the only gate, its miss rate is the XSS rate, and an
   un-reproducible one.
3. **The classifier (this prompt's deliverable) — a System One model**
   (e.g. TypeSafe AI's Jev — state in, typed probabilities out;
   choice/score/noul question types; ~200x faster / ~400x cheaper than
   LLM classification) that reads the **schema data as context** and
   classifies whether runtime-generated html is valid — the judgment
   layer above the floors. No gate threads (the `src/threads/html.ts`
   scaffolding is deleted by design); the orchestrating code lives with
   the consumer (the useWorkers host).

## Phase 0 — pin the floor invariant

The floors must hold with NO classifier reachable (offline simulation —
the responses behavior errors): a fragment with an inline handler or a
malformed b-trigger is still rejected by `controller.utils.ts`. RED
first: a test proving exactly that, offline. This prevents the future
"simplification" of removing the floors "because the classifier catches
it." Also pin the attrs-path gap decision (below) in the same phase.

## Phase 1 — schemas as classifier context (the assembly step)

- Extract the **schema data** as versioned classifier context: one
  assembly that serializes the relevant vocabularies from
  `src/controller/css.schemas.ts` + `src/controller/html.schemas.ts`
  (tag list, attribute-per-tag maps, CSS property allowlist, the `b-*`
  grammar) into the classifier's state input. Functions never existed
  in these files after the consolidation — the context boundary is
  data-only by construction.
- The context must be **derived from the source schemas** (import and
  project), not hand-copied, so schema regeneration updates the context
  with zero drift. A schema version invalidates the context version.
- RED: an assembly spec asserting the projected context contains the
  vocabulary (e.g. the b-trigger pair grammar present; `onclick` NOT a
  known attribute) derived from the live schemas.

## Phase 2 — research: classifier providers for the two target hosts

Both hosts run everything in one webview context with no bash. Research
and report (cited) before building:
- System One / classifier-class providers (Jev): API shape, cost,
  latency, structured-output guarantees, whether they speak Open
  Responses (then it's just an endpoint entry) or need a thin adapter in
  the responses behavior.
- Local small models classifiable on-device (WebGPU/WASM) for the
  offline story. **Decide:** remote-only, local-only, or
  remote-with-local-fallback. Recommended default: remote with graceful
  degradation — offline, generated html still renders if it passes the
  floors, but nothing gets a quality/classification stamp.

## Phase 3 — the classification call (TDD)

A classification is a `response_request` with the classifier-capable
endpoint, the schema context in the state, and structured questions
(noul/choice/score): `is_valid` noul, `semantic_kind` choice, quality
score. The orchestrating code lives with the consumer (the useWorkers
host) — there are no gate threads by design.
- Errors-as-data: classifier outage = no stamp + the floors still hold;
  never a silent pass, never a silent block of floor-passing html.
- RED first: offline/absent classifier behavior; then the
  scripted-endpoint happy path (the responses-behavior spec pattern — a
  fixture server, real behavior process, no mocks beyond the endpoint).

## Phase 4 — the correction loop

Type-2 reasoner as the REWRITER, not the gate: classifier rejects with
reasons → reasoner rewrites the fragment (same schema context) →
re-classify → render. Id-correlated failure events drive the retry;
bounded retries (a fragment that cannot pass is surfaced, not looped).

## Phase 5 — store admission (the second use, same machinery)

Stored html artifacts (templates/pages — the OKF-HTML `okf_fragments`
direction) get classified ONCE at admission; the result feeds the
artifact's embedded metadata (`data-okf-status`: draft = floors only;
stable = classifier-passed). One classification amortized across all
future renders. Same classifier, same context, different call site.

## Open decisions that gate Phase 3 (put to the pilot, with research)

1. **The attrs-path floor gap (immediate, pre-classifier):** deleting the
   thread gate left attrs updates without a deterministic on*/scheme
   check — the controller's `#attrs` validates `b-trigger` only, and
   `detectXssVectors` runs on the render path. Recommended: mirror the
   lean rules into `#attrs` as hardcoded floors (on* keys, `javascript:`/
   `vbscript:`/`data:` schemes on URL-ish attrs, `expression()` in
   style) — one small addition to the floors.
2. Where the classification result lives: embedded in the artifact
   (OKF-HTML `data-okf-*`) vs a store-side ledger. Recommended: embedded.
3. Whether `stable` promotion ever implies git export. Recommended: no —
   promotion is store-state; export stays explicit.
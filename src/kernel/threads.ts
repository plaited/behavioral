/**
 * Minimal turn-loop thread — the scaffolding behavioral program that proves
 * the kernel + dispatch bridge + model tool run one turn end-to-end.
 *
 * @remarks
 * MINIMAL: scaffolding turn-loop thread — to be replaced by autoresearch-evolved
 * threads (Phase 5.5). Proves kernel + dispatch + model tool run a turn
 * end-to-end. Do not build steering/abort/compaction/policy here — later phases.
 *
 * The thread is a static, looping rule sequence (no `once`); the dynamic
 * decisions (does the response carry a function_call? has the iteration cap
 * tripped?) live in the kernel-side dispatch bridge wired through `useTrace`
 * (the action channel, per plan.md Decision 2024-09-03). Coordination events
 * (`user.prompt`, `model.respond`, `model.result`, `tool.dispatch`,
 * `tool.result`, `respond`, `turn.end`) are harness vocabulary distinct from
 * Open Responses stream event types; the buffered `modelRespond` tool returns
 * assembled items rather than a spec stream, so spec-event verbatim streaming
 * (Phase 1) is out of scope for this slice.
 *
 * Loop shape (one iteration):
 *   1. waitFor [{ user.prompt }, { respond }] — ingress on the first pass,
 *      re-entry signal on subsequent passes (after a tool round).
 *   2. request { model.respond } — ask the model; the bridge calls
 *      `modelRespond` with the accumulated items and triggers `model.result`.
 *   3. waitFor [{ model.result }] — the bridge extracts the function_calls.
 *   4. request { tool.dispatch } — the bridge dispatches every pending
 *      function_call and triggers `tool.result`, or (no function_calls)
 *      triggers `turn.end` to stop the turn.
 *   5. waitFor [{ tool.result }, { turn.end }] — re-enter the loop.
 *
 * Every rule carries `interrupt: [{ turn.end }]` so the stop signal tears the
 * loop down cleanly from any step. The bridge bounds the loop with a
 * max-iteration guard (it triggers `turn.end` with `incomplete` status instead
 * of calling `modelRespond` once the cap trips) — no infinite loop.
 *
 * @packageDocumentation
 */

import type { JsonObject, Thread } from '../behavioral/behavioral.types.ts'

/**
 * Build the once-thread an internal re-entry uses to request the event it
 * produced (a bridge result, a transform target, or similar).
 *
 * @remarks
 * Re-entry is ordinary thread admission: the caller registers this thread via
 * `useAddThread(space)` (which stamps its `space`), then fires the contentless
 * `KICK_EVENT_TYPE` to start the super-step. The requested event is therefore a
 * request-origin candidate (`ingress` absent), which is what lets listeners
 * restrict themselves to internal events with `ingressMatch: false`.
 *
 * @public
 */
export const createReentryThread = ({ type, detail }: { type: string; detail?: JsonObject }): Thread => ({
  label: `reentry:${type}`,
  once: true,
  rules: [{ request: { type, ...(detail === undefined ? {} : { detail }) } }],
})

/**
 * The turn-loop thread — registered once per `runTurn`. Space-stamped by
 * `useAddThread(space)` so it only matches events triggered in its own space.
 *
 * @public
 */
export const TURN_LOOP_THREAD: Thread = {
  label: 'turn-loop',
  rules: [
    {
      waitFor: [
        { type: 'user.prompt', ingressMatch: true },
        { type: 'respond', ingressMatch: false },
      ],
      interrupt: [{ type: 'turn.end' }],
    },
    {
      request: { type: 'model.respond' },
      interrupt: [{ type: 'turn.end' }],
    },
    {
      waitFor: [{ type: 'model.result', ingressMatch: false }],
      interrupt: [{ type: 'turn.end' }],
    },
    {
      request: { type: 'tool.dispatch' },
      interrupt: [{ type: 'turn.end' }],
    },
    {
      waitFor: [{ type: 'tool.result', ingressMatch: false }, { type: 'turn.end' }],
      interrupt: [{ type: 'turn.end' }],
    },
  ],
}

// ---------------------------------------------------------------------------
// Progressive-disclosure thread (autoresearch core subject — Q8)
// ---------------------------------------------------------------------------

/**
 * The progressive-disclosure thread — the orchestration program that drives
 * the search→pick→load loop over the discovery tools. This is the autoresearch
 * loop's subject: the thread the loop generates candidates against and
 * improves (Q8). The keep/discard gate is frontier-verify (safety) +
 * frontier-replay to a target frontier (usefulness), so this thread has a
 * well-defined target frontier (idle — all rules consumed after loading) and a
 * reference trace the gate replays against (see
 * `src/kernel/tests/progressive-disclosure.spec.ts`).
 *
 * @remarks
 * Per the 2026-09-07 "search-mediated progressive disclosure" decision, the
 * loop is:
 * 1. Search (tier 1) — `discovery.search` → candidate records (metadata only).
 * 2. Pick — the model picks a candidate (`model.respond` round).
 * 3. Load (tier 2) — `skill.read` or `mcp.call-tool` on the pick → full content.
 * 4. Terminate.
 *
 * The thread drives the loop via **harness events the dispatch bridge maps to
 * tools** (not model-driven): the thread requests `discovery.search`,
 * `skill.read`, etc., and the kernel/bridge dispatches those to the
 * corresponding tools (discovery, skill-client, mcp-client). The model only
 * does the picking (step 2), which is a `model.respond` round. Tools stay dumb;
 * the thread orchestrates.
 *
 * Event vocabulary:
 * - `discovery.search` (request) → bridge calls discovery tool → fires
 *   `discovery.results` (trigger).
 * - `model.respond` (request) → bridge calls model → fires `model.result`
 *   (trigger). The model's pick is in the result detail.
 * - `skill.read` (request) → bridge calls skill-client → fires `tool.loaded`
 *   (trigger).
 * - `turn.end` (request) → terminates the loop.
 *
 * The `waitFor` rules listen for the bridge's trigger events. Every `waitFor`
 * carries `interrupt: [{ turn.end }]` so the stop signal tears the thread down
 * from any step (matching the turn-loop's idiom).
 *
 * `once: true` — the thread runs one search→pick→load cycle and completes.
 * The autoresearch loop may evolve this into a looping variant (continue =
 * loop back to search after loading); the `once` form is the minimal
 * verifiable subject for the gate.
 *
 * Frontier progression (inspectable for frontier-replay):
 * - After `user.prompt` → thread requests `discovery.search` (searching).
 * - After `discovery.results` → thread requests `model.respond` (picking).
 * - After `model.result` → thread requests `skill.read` (loading).
 * - After `tool.loaded` → thread requests `turn.end` (loaded → terminating).
 * - After `turn.end` → thread completes → idle frontier (target).
 *
 * @public
 */
export const PROGRESSIVE_DISCLOSURE_THREAD: Thread = {
  label: 'progressive-disclosure',
  once: true,
  rules: [
    // 1. Ingress — wait for a user prompt to start the search cycle.
    { waitFor: [{ type: 'user.prompt', ingressMatch: true }] },
    // 2. Search (tier 1) — request metadata search; bridge calls discovery tool.
    { request: { type: 'discovery.search' } },
    // 3. Wait for search results — bridge fires discovery.results after I/O.
    { waitFor: [{ type: 'discovery.results', ingressMatch: false }], interrupt: [{ type: 'turn.end' }] },
    // 4. Pick — request a model round; the model picks a candidate from results.
    { request: { type: 'model.respond' } },
    // 5. Wait for the model result — bridge fires model.result with the pick.
    { waitFor: [{ type: 'model.result', ingressMatch: false }], interrupt: [{ type: 'turn.end' }] },
    // 6. Load (tier 2) — request skill read; bridge calls skill-client/mcp-client.
    { request: { type: 'skill.read' } },
    // 7. Wait for loaded content — bridge fires tool.loaded after I/O.
    { waitFor: [{ type: 'tool.loaded', ingressMatch: false }], interrupt: [{ type: 'turn.end' }] },
    // 8. Terminate — request turn.end to stop the cycle.
    { request: { type: 'turn.end' } },
  ],
}

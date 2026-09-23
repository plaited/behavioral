# Frontier Analysis

Reference for an agent assisting an engineer in wiring up the Behavioral
behavioral-program verification tools. These tools answer two questions
across **every reachable state** of a behavioral program, not just sampled
runs: *can it deadlock?* and *can it spin forever without making progress?*

## Public surface

Frontier analysis is a behavior, embedded **in-process** by the composition: `src/workers/frontier.worker.ts`,
speaking the behavioral event wire — `frontier_request { id, op: replay |
explore | verify, input }` in, one `frontier_request_result { id, result }`
out. Mount it via the `useBehavioral` map (`frontier: new Worker(...)`); threads
request it like any satellite. Ops are short-lived (no cancel event). The
worker's event schemas live in `src/workers/workers.types.ts`.

Threads are JSON objects: `{ label: string, rules: Idioms[], once?: true }`.
Each idiom is one sync point with `request` (propose an event), `waitFor`
(block until an event), `block` (forbid an event), and/or `interrupt`
(terminate the thread on an event). `detailSchema` on listeners is JSON
Schema, compiled at registration.

## The op surface

The three ops carry the former tools' contracts: `replay` (re-run to a
frontier), `explore` (enumerate reachable frontiers), `verify` (deadlock/
livelock checks). Input/output shapes validate at the behavior's boundary;
the wire payloads are loose JsonObject with their strict schema home in the
frontier behavior.

## The `progress` spec

The `progress` distinction matters when diagnosing results:

- **Omit `progress`** → livelock is **not checked**; only deadlocks. Use this
  when you only care about deadlock-freedom.
- **`progress: []`** (empty array) → **nothing** counts as progress, so
  every reachable cycle is a livelock. Rarely what you want; useful as a
  "find every cycle" probe.
- **`progress: ['eventType', ...]`** → a cycle is a livelock iff none of its
  in-cycle edges select one of the listed types. Edges that **leave** the
  cycle don't count — an escape is not progress made inside the cycle.

Status precedence: a deadlock or livelock finding yields `'failed'` even if
exploration was also truncated. A pure truncation (no findings, `maxDepth`
hit) yields `'truncated'`. Only a clean, fully-explored, finding-free run
yields `'verified'`. **Never treat `'truncated'` as a pass** — it means the
verifier gave up before proving anything.

## A common wiring mistake to avoid

Calling `frontier-verify` (or `frontier-explore`) **without `maxDepth`** on a
program with unbounded state (e.g. a thread that requests an event with a
counter `detail` that grows each loop) will not terminate — the state graph
never closes. `maxDepth` is **required** on both tools for this reason. For
finite-state programs (all `once: true`, or loops with bounded `detail`) the
graph closes via state-key dedup and the tool terminates before `maxDepth`.
For anything else, set `maxDepth` and treat `truncated` as "needs a bound or
an abstraction," not a failure of the tool.

## See also

- [behavioral](./behavioral.md) — the runtime whose `Trace` union these tools
  filter on, and the `Thread` shape they take.
- [frontier](../../behavioral-tools/references/frontier.md) — the tool surface:
  I/O contracts, dispatch examples, gotchas.
- [eval](./eval.md) — capturing a run's `Thread[]` + messages for later
  frontier analysis.

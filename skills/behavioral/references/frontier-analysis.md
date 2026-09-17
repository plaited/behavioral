# Frontier Analysis

Reference for an agent assisting an engineer in wiring up the Behavioral
behavioral-program verification tools. These tools answer two questions
across **every reachable state** of a behavioral program, not just sampled
runs: *can it deadlock?* and *can it spin forever without making progress?*

## Public surface

Frontier analysis is three `useTool` units that live in-repo at
`src/tools/frontier.ts`. The public surface is **CLI-only** — the fleet
dispatcher (`behavioral tools '{"tool":"frontier-…","input":{…}}'`) wraps
every tool, and `behavioral tools --schema input|output --tool <name>`
exposes the authoritative contracts. There is no `@behavioral/sh/tools`
package export.

The raw algorithm functions (`replayToFrontierRaw`, `exploreFrontiersRaw`,
`verifyFrontiersRaw`) and the graph internals (`frontierStateKey`,
`findStronglyConnectedComponents`, `findLivelocks`, `StateNode`) are
**module-private** — the three tools are the only public surface.

Threads are JSON objects: `{ label: string, rules: Idioms[], once?: true }`.
Each idiom is one sync point with `request` (propose an event), `waitFor`
(block until an event), `block` (forbid an event), and/or `interrupt`
(terminate the thread on an event). `detailSchema` on listeners is JSON
Schema, compiled at registration.

## The tool surface

The per-tool I/O contracts (inputs, outputs, examples, dispatch flags) live
in the **behavioral-tools** skill — see its
[frontier](../../behavioral-tools/references/frontier.md) reference. That is the
single source for tool shapes; discover the authoritative field lists with
`behavioral tools --schema input|output --tool <name>`.

The division of concern: this reference owns *what frontier analysis is and
how to reason with it* (below); the tools skill owns *how to call it*.

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

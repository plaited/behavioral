# Auto-research

Reference for an agent assisting an engineer in wiring a Karpathy-style
**autoresearch** hill-climb loop over a behavioral-program agent. The trace
here is not an eval artifact — it's the **feedback signal** the agent reads to
propose the next mutation. Capture one small experiment, analyze the trace,
keep or discard, repeat on a fixed budget.

This is the iterative-improvement use of the trace primitives. For the
eval-shaped use (capture a run, close it, grade it, compare across runs), see
[Eval](./eval.md) — same primitives, different purpose.

## The loop

Karpathy's autoresearch is a closed-loop hill-climb. Strip the LLM-specific
parts and the recipe is:

1. Read the current state.
2. Make one change (the LLM is the *mutation function* — it proposes the next
   change from the trace of the last run).
3. Commit.
4. Run the experiment on a **fixed budget** (~5-10 min).
5. Measure **one metric**.
6. If improved → keep the commit, advance the branch. If worse → `git reset`.
7. Loop forever.

Where behavioral fits: the **"run experiment"** step captures a trace via
`useTrace` (the agent run, with its behavioral coordination layer observed);
the **"measure"** and **"decide"** steps consume that trace. behavioral supplies
the capture and (optionally) the divergence analysis; the **loop, the one
metric, the fixed budget, and the keep/discard rule are the consumer's** —
behavioral does not ship the loop.

## Public surface

The capture primitive is `useTrace`, returned by `behavioral()` (in-repo at
`src/behavioral/behavioral.ts` — not a public package export; there is no
root `@behavioral/sh` export). The engine returns three hooks:
`{ useAddThread, trigger, useTrace }`. The `Trace` union is closed — there
is no generic parameter and no `sendTrace`; agent-lifecycle events are
captured via the agent SDK's own subscription, correlated with engine traces
by timestamp.

```ts
import { behavioral } from '../../behavioral/behavioral.ts'
import type { Trace } from '../../behavioral/behavioral.types.ts'
```

For analyzing the reachable branches of a mutated program (optional — see
below), also use the [frontier-analysis](./frontier-analysis.md) tools.

## When to use which

| Need | Use |
|------|-----|
| Capture each experiment's run as a trace | `behavioral()` + `useTrace` (listener receives the closed `Trace` union). Agent-lifecycle events captured via the agent SDK's own subscription. Same capture wiring as eval. |
| Measure the run via a deterministic metric | Consumer code reading the captured trace (token count, tool-call count, BP-health counts, a domain metric). behavioral supplies no metric. |
| Analyze the mutated program's reachable branches between iterations | `frontier-explore` / `frontier-verify` over the program's `Thread[]`. Optional — only if the mutation changes the behavioral program and you want to know what it can now reach. |
| Decide keep/discard | Consumer code: compare this iteration's metric to the last kept one. The selection function is the hill-climb. |

The capture row is identical to eval's — the *primitives* don't know whether
you're capturing for grading or for iteration. What differs is what you do
with the trace *after* capture: eval closes it and grades; autoresearch
analyzes it and mutates.

## The capture wiring (per iteration)

Each iteration captures its own trace. The boundary is **one experiment** —
from run-start to budget-elapsed or terminal result. The sink is whatever the
`useTrace` callback does; for autoresearch, usually a per-iteration file or
an append to a running log the analyzer reads.

```ts
import { behavioral } from '../../behavioral/behavioral.ts'

// Per-iteration: construct, capture, run, measure, decide.
async function runOneExperiment(
  threads: Array<{ label: string; rules: any[] }>,
  triggers: Array<{ type: string }>,
  budgetMs: number,
): Promise<{ events: Array<{ kind: string; timestamp: number }>; metric: number }> {
  const program = behavioral()
  const { useTrace, useAddThread, trigger } = program

  const events = []
  useTrace((msg) => { events.push(msg) })  // callback is the sink

  for (const t of threads) useAddThread()(t)
  for (const trig of triggers) trigger(trig)
  // ...capture agent-lifecycle events via the agent SDK's own subscription,
  //    written to the same `events` sink, correlated by timestamp...

  // Fixed budget — the experiment ends when the budget elapses OR the run
  // terminates, whichever is first.
  await runWithBudget(budgetMs, () => /* drive the agent */)

  // Measure: consumer-defined metric over the captured trace.
  const metric = measure(events)
  return { events, metric }
}
```

The loop, the keep/discard rule, and the `measure` function are the
consumer's — behavioral supplies the capture, not the hill-climb.

## Intake (use `grill-me`)

The autoresearch shape is fixed (mutate → run → measure → keep/discard →
loop), but the *contents* differ by goal. Surface these with the engineer
before wiring:

- **One file the agent can mutate.** Karpathy's loop has exactly one file
  the agent edits between iterations. What is it for this goal? (A skill
  prompt, a thread rule set, a model config, an agent's system prompt.)
- **One metric.** What single number does `measure` produce? (Pass rate on a
  fast shard, token cost, BP-deadlock count, a domain score.) Autoresearch
  with multiple metrics isn't a hill-climb — it's a Pareto problem; keep it
  to one or pick a scalarization.
- **Fixed budget.** How long is one experiment? Karpathy used ~5 min.
  Too short and the metric is noisy; too long and the loop is slow.
- **Keep/discard rule.** Strict improvement only, or improvement within noise
  tolerance? Strict climbs stall on local optima faster; tolerant climbs
  wander. Karpathy's default is strict (keep iff improved).
- **What the agent reads to propose the next mutation.** The trace of the
  last kept run? The diff between last kept and last discarded? A running
  log of kept experiments (`log.jsonl` in the dlg `.auto/` pattern)? This is
  the feedback channel — decide it at intake.
- **Divergence analysis between iterations?** If the mutation changes the
  behavioral program (thread rules, not just the agent's prompt), the
  reachable branches may change. Optionally run `frontier-explore` on the
  mutated `Thread[]` to surface new deadlocks or livelocks the mutation
  introduced. Skip if the mutation doesn't touch the behavioral layer.

## A common failure mode: local optima

The hill-climb stalls when the agent finds a small improvement whose every
neighbor is worse — a local optimum far from global. Karpathy's mitigations:
restart from different starting seeds, add randomization to the mutation
step, or run multiple loops in parallel from different starts. This isn't a
behavioral concern — behavioral supplies the capture, not the search — but surface
it at intake so the engineer builds a stall-detector (e.g. N iterations with
no kept improvement → restart) rather than letting the loop spin forever.

## The boundary with eval

Autoresearch *can* use an eval-grade measurement as the one metric (pass rate
on a fast shard, scored by a grader as in [eval](./eval.md)). But the loop is
the point, not the comparison. If you find yourself capturing full trials,
grading them post-hoc, and comparing two runs — that's eval, not autoresearch.
Autoresearch captures *one small experiment per iteration* on a fixed budget
and decides keep/discard immediately; the trace is feedback, not an artifact.

## Going deeper

The capture primitive (`useTrace`) lives in-repo at
`src/behavioral/behavioral.ts`, with the `Trace` union in
`src/behavioral/behavioral.types.ts`. Read those files directly — the engine
is not a public package export (there is no root `@behavioral/sh` export),
so there is no specifier to resolve. The kernel's dispatch bridge
(`src/kernel/kernel.ts`) is the canonical `useTrace` action-channel
implementation.

For divergence analysis between iterations, see
[frontier-analysis](./frontier-analysis.md).

## See also

- [Eval](./eval.md) — the eval-shaped use of the same capture primitives (trace as artifact, not feedback).
- [frontier-analysis](./frontier-analysis.md) — reachable-branch analysis for the optional between-iterations divergence check.
- [behavioral](./behavioral.md) — wiring the behavioral program the agent runs.

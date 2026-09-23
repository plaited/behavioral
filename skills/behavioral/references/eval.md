# Eval

Reference for an agent assisting an engineer in wiring up behavioral's
behavioral-program **eval capture** primitives. These tools answer: *how do I
capture an agent run (with or without a behavioral coordination layer) into a
trace I can later grade, and — for behavioral agents — how do I analyze the
branching structure of that run?*

This is the eval-shaped use of the trace primitives. (The iterative
hill-climb use of the same primitives — capture, analyze, mutate, repeat —
lives in the agenthub project.)

## Public surface

The capture primitive is `useTrace`, returned by `behavioral()` (in-repo at
`src/behavioral/behavioral.ts` — not a public package export; there is no
root `@behavioral/sh` export). The engine returns three hooks:
`{ useAddThread, trigger, useTrace }`.

```ts
import { behavioral } from '../../behavioral/behavioral.ts'
import type { Trace, UseTrace } from '../../behavioral/behavioral.types.ts'
```

`useTrace` subscribes a listener receiving the engine's **closed** `Trace`
union (`selection`, `frontier`, `pending_bids`, `deadlock`, `trigger_error`,
`add_thread_error`, `interrupt`, `transform` — narrow by `kind`). There is
no generic type parameter on `behavioral()` and no `sendTrace` hook — the
`Trace` union is closed; you cannot inject custom trace kinds into the
engine's stream. Agent-lifecycle events (tool calls, messages) are captured
by the consumer's own side-channel (the agent SDK's subscription),
correlated with engine traces by timestamp.

For divergence analysis over a captured run, also use the
[frontier-analysis](./frontier-analysis.md) tools (`frontier-explore`,
`frontier-verify`, `frontier-replay`) over the captured `Thread[]` + messages.

## When to use which

| Need | Use |
|------|-----|
| Observe a behavioral program's own execution (logging/debugging) | `behavioral()` + `useTrace`. Listener receives the closed `Trace` union. |
| Capture a behavioral agent's run *plus* agent-lifecycle events for grading | `behavioral()` + `useTrace` (engine traces) **and** the agent SDK's own subscription (agent events), correlated by timestamp. The engine's `Trace` union is closed — there is no `sendTrace` to inject agent events into it. |
| Grade a linear run over an outcome | Post-hoc grader over the captured trace. behavioral supplies **no grading code** — the consumer's grader reads the trace and emits a result. |
| Analyze reachable branches of a behavioral agent's run (divergence) | `frontier-explore` / `frontier-verify` over captured `Thread[]` + messages. See [frontier-analysis](./frontier-analysis.md). |

The first row is the base case: behavioral as a logging/observation utility
for its own execution. The second extends it with agent events. The third and
fourth are what you do with the captured trace *after* the run — behavioral's
role ends at capture (and, for divergence, at analysis).

## The capture wiring

The capture layer is always a `useTrace` listener. What the listener does
with each event is the consumer's choice — the callback is the sink. behavioral
does not prescribe JSONL, a database, a socket, or any particular store. The
callback writes wherever the consumer wants. The engine's `Trace` union is
closed (no `sendTrace`), so agent-lifecycle events are captured via the agent
SDK's own subscription and written to the same sink, correlated with engine
traces by timestamp.

```ts
import { behavioral } from '../../behavioral/behavioral.ts'

// 1. Construct the program. No generic parameter — the Trace union is closed.
const program = behavioral()
const { useTrace, useAddThread, trigger } = program

// 2. Subscribe a capture listener. It receives the engine's Trace variants
//    in publication order.
const events = []
useTrace((msg) => {
  events.push(msg)
  // ...or write to a file, socket, DB, stdout — the callback is the sink.
})

// 3. From the agent SDK's lifecycle callbacks (pi session.subscribe, Claude
//    Code hooks, etc.), write agent events to the SAME sink directly — they
//    do NOT flow through the engine's trace stream (there is no sendTrace).
//    Correlate by timestamp.
//
//   session.subscribe((e) => {
//     if (e.type === 'tool_execution_end') {
//       events.push({ kind: 'tool_call', timestamp: Date.now(), tool: e.toolName, args: e.input })
//     }
//   })
```

The behavioral program itself (threads, triggers) is wired with `useAddThread`
/ `trigger` as usual — see [behavioral](./behavioral.md). The capture layer
is orthogonal: it observes the program's execution via `useTrace` and bridges
the agent SDK's lifecycle into the same sink via the SDK's own subscription.

## What constitutes a trace? (intake)

The old `agent-eval-harness` answered this for you with a fixed shape. With
the harness dissolved, the agent + engineer decide. These are the questions to
surface (use `grill-me` to work through them with the engineer) — the answers
shape the capture wiring and differ by eval:

- **Boundary** — what counts as one trace? One agent session? One task attempt?
  One inference turn? One branched exploration? For eval, usually *one trial*
  (one task attempt, from start to a terminal result).
- **Lifecycle** — what event closes the trace and triggers flush? A
  `completed`/`failed`/`timed_out` result? A turn budget? A wall-clock budget?
  The flush trigger is where the capture callback hands the accumulated events
  to whatever comes next (a grader, a file write, a socket send).
- **Sink** — where does the `useTrace` callback write? File, socket, DB, in-memory,
  stdout. behavioral doesn't know or care; the callback handles it.
- **Retention** — for eval, are all trials kept, or only failures, or a sample?
  The keep/discard rule is the consumer's.
- **Analysis target** — post-hoc outcome grading (grade what the agent produced),
  divergence analysis (`frontier-analysis` over the behavioral layer's branches),
  or both? This determines whether you need `Thread[]` capture (see below).

## The `Thread[]` capture concern (behavioral agents only)

`useTrace` gives you the **messages** (the trace stream). frontier-analysis
needs the **threads** that produced those messages — `frontier-explore` and
`frontier-verify` take a `Thread[]` plus a `messages` trace. If the agent runs
a behavioral program and you want divergence grading later, persist the
`Thread[]` definition at capture time, alongside the trace:

```ts
const threads: Thread[] = [
  { label: 'coordinator', rules: [...], once: true },
  // ...the threads the agent's behavioral layer runs
]
// At flush: write `threads` and `events` together — one trial's full capture.
```

A consumer who wires `useTrace` and later wants `frontier-analysis` without
having captured `Thread[]` is stuck — the messages alone aren't enough to
reconstruct reachable branches. Surface this at intake time, not after the
run. For a plain agent (no behavioral layer), there are no threads and
`frontier-analysis` doesn't apply — only trace grading does.

## Grading is beyond this package

behavioral supplies the capture primitives (`useTrace`) and, for
behavioral agents, the divergence-analysis tools (`frontier-analysis`).
It supplies **no grading code**. Graders are consumer-authored and run
wherever the consumer chose to sink the trace:

- **Deterministic** — read the trace, apply rules (gold-answer match, BP-health
  metrics over `kind` counts, token/cost aggregation). The consumer's code, in
  the consumer's chosen language/store.
- **LLM-rubric** — a subprocess grader that reads the trace and asks a judge
  model. The consumer authors the grader; behavioral does not ship a grader
  contract or IO helpers.
- **Hybrid** — deterministic pre-filter + LLM-rubric on the survivors.

Anthropic's framing applies to the outcome-grading subset: *grade what the
agent produced, not the path it took.* Trajectory signals (tool-call count,
BP deadlocks, latency) are metrics, not pass/fail graders. The divergence
case is the exception — there, the *branches* are the thing being graded, and
`frontier-analysis` is the tool.

## A common wiring mistake to avoid

Wiring `useTrace`, running the agent, then discovering you wanted divergence
grading and have no `Thread[]`. The messages alone can't reconstruct
reachable branches. Decide at intake whether the eval needs divergence
analysis; if it does, capture `Thread[]` alongside the trace. If it doesn't
(plain agent, outcome-only grading), skip `Thread[]` capture and skip
`frontier-analysis` — they don't apply without a behavioral layer.

## Going deeper

The capture primitive (`useTrace`) lives in-repo at
`src/behavioral/behavioral.ts`, with the `Trace` union and hook types in
`src/behavioral/behavioral.types.ts`. Read those files directly — the engine
is not a public package export (there is no root `@behavioral/sh` export),
so there is no specifier to resolve. The kernel's dispatch bridge
(`src/kernel/kernel.ts`) is the canonical `useTrace` action-channel
implementation.

## See also

- [frontier-analysis](./frontier-analysis.md) — divergence analysis over a captured `Thread[]` + messages.
- [behavioral](./behavioral.md) — wiring the behavioral program itself (`useAddThread`, `trigger`, `useTrace`).

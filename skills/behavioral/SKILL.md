---
name: behavioral
description: >
  Behavioral-programming runtime and UI layer — b-threads, triggers,
  listeners, the controller/custom-element protocol, SSR via stateless html
  tools, frontier analysis, behavioral eval capture, and the design-system
  spec. Use when creating, reading, updating, or deleting code where
  @behavioral/sh is a declared dependency or where the work is in the
  behavioral repo itself.
license: ISC
compatibility: Requires bun and the behavioral CLI
allowed-tools: Bash Read
---

# Behavioral Framework

Reference for an agent assisting an engineer working on the behavioral
behavioral-programming runtime and its UI layer. This skill routes you to
the right operator surface for the task. The detailed reference material
lives in `references/`; load it on demand per the route table below.

## When to use this skill

Use this skill when the task involves the behavioral **runtime** or **UI layer**
and you're working in a project where `@behavioral/sh` is a declared dependency or
in the behavioral repo itself. Specifically:

- Wiring **behavioral programs** — b-threads, triggers, `useTrace`
  listeners, the super-step model, deadlock/livelock analysis.
- Building **custom elements** via the controller protocol, or
  **server-side rendering** via the stateless html tools.
- Capturing or grading **agent runs** (eval) — trace primitives and
  divergence analysis.
- Designing the **design-system spec** — a DESIGN.md derivative re-grounded
  on Structural IA, CSS custom properties, and `@scope`/`:host()`/`::part()`
  modes.

The `behavioral` CLI is the entry (`bin/behavioral.ts`). The tools-fleet
dispatcher is retired with the ICL conversion; run `behavioral --help` for
the current command surface.

## Route table

Read the reference that matches the task. Each is self-contained; load it
only when the task calls for it.

| When the task involves… | Read |
|-------------------------|------|
| Behavioral programs — b-threads, `useAddThread`/`trigger`/`useTrace`, the super-step model, the action-channel pattern | [`references/behavioral.md`](./references/behavioral.md) |
| Deadlock/livelock verification — frontier analysis over the closed state graph | [`references/frontier-analysis.md`](./references/frontier-analysis.md) |
| UI layer — the browser Controller protocol (`render`/`attrs`/`scale_check`, `ui_event`/`snapshot`/`error`/`success`/`scale_check_result`/`form_submit`) and the stateless SSR html tools | [`references/controller.md`](./references/controller.md) |
| Capturing/grading an agent run — eval trace primitives, divergence analysis | [`references/eval.md`](./references/eval.md) |
| Design-system spec — DESIGN.md derivative, Structural IA, custom properties, `@scope`/`:host()`/`::part()`, scale + affordances/feedback (in-progress consensus surface) | [`references/design-spec.md`](./references/design-spec.md) |

**Companion skills:** remote MCP operations are the **mcp behavior**
(`mcp_request` wire — see `behavioral-tools/references/mcp-client.md`); the
skill/plugin domain conventions (store tenants, scan recipes, `links_request`,
ICL composition) are the **skill-conventions** skill. This skill owns the
concepts; those skills own the operator contracts.

## Repo conventions

Follow `AGENTS.md` for repo conventions (Bun APIs, conventional commits,
file naming, no-index, minimal-implementation, testing). This skill routes
you to the right behavioral operator surface; `AGENTS.md` owns the workflow
rules.

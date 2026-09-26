---
name: behavioral
description: >
  Behavioral-programming runtime and UI layer — b-threads, triggers,
  listeners, the super-step model, the faculties event wire, the controller
  `ui_*` protocol, frontier analysis, and behavioral eval capture. Use when
  creating, reading, updating, or deleting code where @behavioral/sh is a
  declared dependency or where the work is in the behavioral repo itself.
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

- Wiring **behavioral programs** — b-threads, triggers,
  `useTrace` listeners, the super-step model, deadlock/livelock analysis.
- Building **custom elements** wired by the controller `ui_*` protocol
  (browser Controller).
- Capturing or grading **agent runs** (eval) — trace primitives and
  divergence analysis.

The `behavioral` CLI is the entry (`bin/behavioral.ts`). The tools-fleet
dispatcher is retired with the ICL conversion; run `behavioral --help` for
the current command surface.

## Route table

Read the reference that matches the task. Each is self-contained; load it
only when the task calls for it.

| When the task involves… | Read |
|-------------------------|------|
| Behavioral programs — b-threads, `addThread`/`trigger`/`useTrace`/`step`, the super-step model, the action-channel pattern | [`references/behavioral.md`](./references/behavioral.md) |
| Deadlock/livelock verification — frontier analysis over the closed state graph | [`references/frontier-analysis.md`](./references/frontier-analysis.md) |
| UI layer — the browser Controller over the `ui_*` wire (`ui_render`/`ui_attrs`/`ui_scale_check`, `ui_event`/`ui_snapshot`/`ui_error`/`ui_success`/`ui_scale_check_result`/`ui_form_submit`) | [`references/controller.md`](./references/controller.md) |
| Capturing/grading an agent run — eval trace primitives, divergence analysis | [`references/eval.md`](./references/eval.md) |

**Companion skills:** remote MCP operations are the **remote-mcp threads
over the shell faculty's generic `rpc` op
(`src/faculties/shell/remote-mcp.threads.ts`); the
skill/plugin domain conventions (store tenants, scan recipes,
`links_request`, ICL composition) are the **skill-conventions** skill. This
skill owns the concepts; those skills own the operator contracts.

## Repo conventions

Follow `AGENTS.md` for repo conventions (Bun APIs, conventional commits,
file naming, no-index, minimal-implementation, testing). This skill routes
you to the right behavioral operator surface; `AGENTS.md` owns the workflow
rules.

# Design spec (consensus surface)

Reference for an agent assisting in the design of behavioral's design-system
specification — a derivative of [DESIGN.md] re-grounded on Rachel Jaffe's
[Structural IA] to move beyond atomic visual styling into a full structural
+ expressive system an agent can use to build interfaces. This document is
the **editable consensus surface** for an in-progress wayfinding effort, not
the finished spec. It captures decisions locked so far, the substrate facts
gathered from the codebase and MDN, and the open frontier still to grill.
Edit it freely as exploration advances; when the way is clear, the hand-off
spec is written from it.

> **Status: in progress.** Locks are marked **Locked**; unresolved
> questions live under [Open frontier](#open-frontier) and must not be
> treated as decided. Nothing here is normative yet — this is the shared
> map, not the territory.

## Destination

**Locked** — the effort's destination is a **hand-off spec**: a new
DESIGN.md-derivative format spec for the behavioral framework, handed off for
implementation and iteration. The map ends when every decision needed to
*write* that spec is made; the prose itself gets written *after* the map, by
whoever does the work. The destination fixes scope, so it was settled
first.

## Two-phase usage model

**Locked** — the spec is a **format template**, not a design system itself.
It is used in two phases by two different audiences:

| Phase | Who | Reads | Produces | Needs |
|-------|-----|-------|----------|------|
| **A — authoring** | Agent + user | The **format spec** | A **project DESIGN.md** | Reasoning guidance: what concepts to elicit, how to choose patterns/affordances/feedback, what sections to fill |
| **B — building** | Agent | The **project DESIGN.md** | **Actual UI** (HTML + behavioral threads) | Declarative inventory: exact `--*` tokens, declared `affordances:` / `feedback:` / `patterns:` maps, prose explaining intent |

The format spec therefore contains: **mechanism** (how `b-scale`, `@scope`,
DSD, custom properties work — stable, shared) + **starter vocabulary**
(default `affordances:` / `feedback:` / `patterns:` maps — shared defaults a
project overrides/extends) + **section templates** (what each body section
must contain — the project fills in) + **reasoning guidance** (woven into
section descriptions, teaching the Phase A agent how to elicit and choose).

A project DESIGN.md is the **instance**: specific tokens, selected/customized
affordances, feedback states, and patterns, filled-in prose. The format
spec's frontmatter defaults are overridable; the project's frontmatter is the
conformance contract a Phase B agent generates against.

## What lives where (the layer separation)

**Locked** — the spec separates three layers, each with a different
relationship to HTML and to the framework:

| Layer | What it declares | Appears in HTML? | Example |
|-------|-----------------|------------------|---------|
| **Structural** (`b-scale`, `patterns:`) | What a node *is* and what may nest inside it; the structural shape of a region | **Yes** — `b-scale` governs DOM nesting, so it appears in markup | `b-scale="s3"` (a block); a `Stream` pattern |
| **Functional** (`affordances:`, `feedback:`) | Named *interaction intents* and *loop response states* — the vocabulary reusable thread objects compose from | **No** — affordances and feedback are properties of *behavioral logic* (thread objects), not of HTML elements; the HTML is downstream of the thread, styled by the token bundles the vocabulary declares | `affordances: { danger, primary, secondary }`; `feedback: { error, confirmation, pending, success }` |
| **Expressive** (`--*` tokens, carrier model) | The *visual values* — CSS custom properties, resolved per scope via inheritance + `@scope` / DSD | Yes — as CSS custom properties, but the *names* come from the vocabulary, not from a mode attribute | `'--color-primary': "#1A1C1E"`; a `danger` affordance's token-bundle override |

The key move: **affordances and feedback states are vocabulary for reusable
thread objects (behavioral structure), not HTML attributes.** A "danger
affordance" is not `<button p-affordance="danger">` — it is a *thread* that
handles the danger interaction; when that thread emits a render, the HTML it
produces carries the *visual tokens* the spec declared for "danger." The
affordance is in the behavioral logic; the HTML is downstream of it. Same
for feedback: an "error state" is a thread that, on an error condition,
emits a render/attrs that styles the region with the "error" token bundle.
The thread *is* the state machine; the HTML reflects the state.

This is why no `p-mode` / `p-affordance` / `p-feedback` attribute is needed:
the existing `b-target` / `b-trigger` / `b-scale` are sufficient for the HTML
side; the functional vocabulary lives in the thread layer, which the spec
*declares* (so threads and templates share language) but the framework
*executes* (the spec doesn't say how threads are wired).

## Decisions locked

1. **behavioral-bound (normative).** The spec *requires* behavioral's HTML-first
   substrate as part of its contract — `@scope`, Declarative Shadow DOM,
   CSS custom properties, the `p-*` attribute surface. Portability to
   non-behavioral runtimes is out of scope for the *mechanism*. The
   *functional vocabulary* (affordances/feedback/patterns) is deliberately
   substrate-neutral in its *description* (see [Functional flow](#functional-flow))
   so a non-behavioral consumer with a similar trigger→logic→render loop can
   consume the same vocabulary through its own channel.

2. **Attribute prefix is `p-*`.** `b-scale` joins the existing `b-trigger` /
   `b-target` / `b-form`. Not `data-*`. **`p-mode` and `p-density` are
   dropped** — see decisions 5 and 6.

3. **Carrier model — two boundary kinds + a choice rule + a composition
   seam** (see [Carrier model](#carrier-model)).

4. **Tokens ARE CSS custom properties.** The YAML frontmatter token block is
   **kept** as the machine-readable declaration of the canonical custom
   properties, but its keys are CSS custom-property names (e.g.
   `'--color-primary': "#1A1C1E"`), not dot-notation groups. No `{ref}`
   syntax — `var()` is the reference. The payoff: generated HTML can be
   tested/evaluated against the declared `--*` names, so the frontmatter is
   the conformance contract for token names.

5. **`p-mode` dropped; replaced by functional vocabulary.** The visual-mode
   axis is replaced by **`affordances:`** (named interaction intents:
   `primary`, `secondary`, `danger`, …) and **`feedback:`** (named loop
   response states: `error`, `confirmation`, `pending`, `success`, …) in
   frontmatter. Each is a named token bundle + a prose contract (what it
   *conveys*, not what behavior must happen). They are vocabulary for
   *reusable thread objects*, not HTML attributes. See
   [Functional vocabulary](#functional-vocabulary).

6. **`p-density` dropped entirely.** Density is **not an attribute**.
   `--space-near` / `--space-away` are relationship multipliers (stable);
   `--density-base` is the magnitude, **implied by `b-scale`** (deeper =
   denser, per Structural IA scale nesting — deeper = more specific, smaller
   scope). Final spacing is
   `calc(var(--density-base) * var(--space-near))`. No override attribute —
   an S5 is always roomy, an S1 is always compact; the scale nesting *is*
   the density curve. See [Density & spacing](#density--spacing).

7. **Two axes: `b-scale` (structural) + functional vocabulary (affordances/
   feedback).** `b-scale` governs *what a node is and what may nest inside
   it* (composition, appears in HTML); affordances/feedback govern *what
   interaction a thread handles and what response it gives* (function, lives
   in thread objects, not HTML). `SCALE.rel` (rank 0, no nesting constraint)
   is the **scale-less / expression-only** home — a region with no structural
   role. See [Structural scale](#structural-scale).

8. **No file-format spec for templates.** Templates are read/written/
   generated `.html` files; composition and inflight attribute patching are
   agent behaviors. The spec is *aware* of this preferred path (it guides
   how carriers are designed) but does not normativize the file mechanics.
   Out of scope.

9. **Custom-property overrides ride on inheritance; `@scope`/shadow are for
   element-selector encapsulation.** A plain selector setting `--x` is
   already scoped to its subtree by the cascade — no `@scope` or shadow
   needed for *value* overrides. `@scope` (light DOM) and Declarative Shadow
   DOM are required only when you must encapsulate *element selectors*
   (`button { … }`) so they don't leak beyond a boundary.

10. **Structural IA vocabulary declared as frontmatter `patterns:` (Variant
    2). Overridable defaults.** The format spec ships a **default `patterns:`
    map** in its frontmatter (the Structural IA starter dictionary — Pools,
    Streams, Walls, Threads, Daisy, Strict Hierarchy, etc. — each with the
    four Structural-IA attributes: Content / Structure / Boundary / Scale).
    A project DESIGN.md **overrides/extends** `patterns:` in its own
    frontmatter. See [Structural patterns](#structural-patterns).

11. **Structural IA concepts (loops, channels, levers, base dynamics, energy)
    are reasoning guidance, not declarations.** They live in the format
    spec's body, woven into section descriptions, teaching the Phase A agent
    *how to think* toward pattern/affordance/feedback choices. They are
    **never** declared in a project's frontmatter and **never** mapped to
    framework primitives. The spec conveys *design reasoning*, not
    *execution mechanics*. `b-trigger`/`b-target` are the depth the spec
    reaches on interaction binding; below that is the framework's concern.

## Functional flow

**Locked (as reasoning guidance, substrate-neutral)** — the spec's body
teaches the shape of an interaction so the Phase A agent designs *for* the
loop without the spec prescribing wiring. The shape, in substrate-neutral
terms:

```
   user action ──► trigger ──► logic ──► render ──► user sees ──► user acts again
                                  │                       │
                          (holds an affordance,     (styled by the
                           transitions through       affordance/feedback
                           feedback states,          token bundles the
                           renders into a pattern)   spec declared)
```

- An **interaction is a loop**: trigger → logic → response, repeating.
- The **logic** is a thread that holds an **affordance** (what kind of
  interaction this is) and transitions through **feedback states** (where in
  the loop's cycle the region is).
- The **response** is a render into a **pattern**, styled by the
  affordance/feedback **token bundles** the spec declared.
- **SSR pre-renders the initial state; CSR drives the live transitions.**
  The same logic drives both — the vocabulary is the constant; the substrate
  is the variable.

A behavioral agent recognizes its own flow (behavioral threads, the html
SSR tools, Controller, BPEvents) in this shape; a non-behavioral agent with a similar
trigger→logic→render loop recognizes *its* flow. The spec names none of the
mechanism — only the shape and the vocabulary that flows through it.

### Loops, channels, levers — how the agent reasons

Structural IA's functional concepts map onto this flow as *reasoning* the
Phase A agent does, not as declarations:

| Concept | What the agent asks | Where it lives in the spec |
|---------|---------------------|---------------------------|
| **Loop** | "What is the action → response cycle for this interaction?" | Reasoning — body |
| **Channel** | "How much information flows trigger→logic and logic→render?" | Reasoning — body |
| **Lever** | "Does this decrease user effort or increase willingness to exert?" | Reasoning — body |
| **Mechanic** (lever subtype) | "Is the response sudden (gameshow door) or gradual (scratch-off)?" | Reasoning — body; realized by *how the thread sequences emits* |
| **Base dynamic** | "What is one trigger→render pair?" | Reasoning — body |
| **Energy** | "Is this interaction cheap or expensive for the user?" | Reasoning — body |

These never become frontmatter keys and never map to framework primitives.
They are the lens the agent uses to *choose* which affordances, feedback
states, and patterns to declare.

### Emergent networks — simple rules, complex UI

Structural IA's broader thesis (from the [Modnet](https://rachelaliana.medium.com/living-digital-networks-the-new-field-of-emergent-network-design-ed7a65b31d6e)
work) is that complex interfaces *emerge* from the interaction of simple rules —
"the front-end emerges as a result of increased complexity on the network,
instead of being delineated from the top down by a developer." The behavioral
program is the realization of this: b-threads with simple `request`/`waitFor`/
`block` rules create complex coordinated behavior through the super-step
model. The UI is not top-down-delineated; it *emerges* from the interaction of
the threads' rules. `verifyFrontiers` / `exploreFrontiers` then verifies the
emergent behavior doesn't deadlock — something the original modnet had no way
to check. The functional flow's "logic" is a thread *because* the thread's
simple-rule composition is what makes emergence tractable and verifiable.

### Deterministic vs neuro-symbolic — both fit

The vocabulary is deterministic and spec-declared; the *use* of it can be
deterministic or model-mediated. A purely deterministic thread emits a
known pattern with known feedback. A neuro-symbolic thread asks a model
"given this trigger, which declared pattern and feedback state?" and emits
whatever the model returns — but the model is *constrained to the declared
vocabulary*, so its output is still consistent. SSR and CSR use the same
flow, so the same thread drives both.

## Structural scale

**Locked** — behavioral's codebase already defines the structural axis:

```ts
// src/main/html.constants.ts
export const B_SCALE = 'b-scale'
export const SCALE = keyMirror('s1','s2','s3','s4','s5','s6','rel')
export const SCALE_RANK = { s1:1, s2:2, s3:3, s4:4, s5:5, s6:6, rel:0 }
```

This is Rachel Jaffe's Structural IA **Scale** hierarchy (S1 singular object
→ S2 object group → S3 block → S4 block group → S5 module → S6 module group
→ S7 platform → S8 super-structure), truncated at S6 + `rel`. The old
`template.ts` enforced a nesting constraint:

> *"Cannot nest higher structural order element (`${scale}`) inside a lower
> structural boundary container (`${pScale}`)."*

…with `rel` as scale-less (rank 0 — nests anywhere, accepts anything). The
spec adopts this scale vocabulary as a **fixed enum** (not per-project
frontmatter): S1–S6 + `rel` + ranks.

**Advisory, not enforced.** The nesting constraint is a **generation-layer
convention**, not a runtime invariant. The html tools and Controller do not
throw on scale violations. Instead, the framework exposes a pre-flight
`scale_check` operation (`html-scale-check` SSR tool + Controller `scale_check` WS message)
that returns the effective structural boundary a `render` target lives in, so
an agent can generate content that respects the boundary before rendering. The
rule: **into** modes (`afterbegin`, `beforeend`, `innerHTML`) read the target's
own `b-scale`, falling back to the nearest ancestor; **replace/beside** modes
(`beforebegin`, `afterend`, `outerHTML`) read the target's parent's nearest
`b-scale`. Across multiple matches, the most restrictive (lowest-rank) scale
wins. No `b-scale` found anywhere → `rel` (permissive). `SCALE_RANK` drives
this min-reduction, not an enforcement throw.

`b-scale` is the **only** spec attribute that appears in HTML.

`SCALE.rel` (rank 0) is the **scale-less / expression-only** home. A region
with no structural role carries `rel` — no nesting constraint. This is the
scale of a pure expression scope (what `p-mode` regions used to be, before
`p-mode` was dropped).

### Provenance: the Modnet Structural Standard (MSS)

The spec's four locked vocabulary axes — **scale** (`b-scale`), **structure**
(`patterns:`), **mechanics** (`affordances:` + `feedback:`), and **boundary**
(the `patterns:` Boundary attribute) — trace to Rachel Jaffe's [Modnet
Structural Standard (MSS)](https://rachelaliana.medium.com/modnet-design-standards-15e53176de41)
(Feb 2020), the earlier five-tag module model that preceded Structural IA.
The MSS defined five tags for interoperable modules:

| MSS tag | In this spec? | Where |
|---------|-------------|-------|
| **Scale** (S1–S8) | Yes (truncated S1–S6 + `rel`) | `b-scale` + `SCALE_RANK` |
| **Structure** (blocks, modules, Daisy, etc.) | Yes | `patterns:` frontmatter map |
| **Mechanics** (upvote, follow, karma — cross-cutting interaction dynamics) | Yes (reframed) | `affordances:` + `feedback:` — the interaction-intent and loop-response vocabulary for thread objects |
| **Boundary** (all / none / ask — what information shares) | Yes (as prose contract) | `patterns:` Boundary attribute — a prose contract, not a CSS mechanism |
| **Content type** (the use case: #produce, #art, #health) | **No — intentionally out of scope** | The content-type / record-type layer (e.g. ATProto lexicon NSIDs, or a project's own content-type identifiers). The design spec governs the UI vocabulary; it does not declare what a module *is for* — that is the content layer's concern. |

The fifth tag (content type) is deliberately out of scope for this spec: the
spec governs the *shape* of the UI (scale, structure, mechanics, boundary,
expression); the *content type* is a separate axis owned by the content layer
(lexicons, record types, or project-specific content-type identifiers). A
`Stream` pattern at `b-scale="s3"` is the same structural shape whether it
holds articles, episodes, or produce listings — the content type is what the
stream is *for*; the pattern is *how it's shaped*.

## Functional vocabulary

**Locked (mechanism); exact frontmatter shape open** — the replacement for
`p-mode`. Three coordinated parts, because the functional flow has three
places the agent speaks the vocabulary:

| Vocabulary part | What the thread uses it for | What the template uses it for | Frontmatter |
|-----------------|------------------------------|-------------------------------|-------------|
| **Patterns** | "render a *Stream* here" (request structural shape) | Generate HTML with that structure at the declared `b-scale` | `patterns:` map (locked) |
| **Feedback states** | "transition to *pending*" (the response half of a loop) | Style the region with the state's token bundle | `feedback:` map — *the p-mode replacement* |
| **Affordances** | "this region affords *danger*" (declare the interaction's functional intent) | Curate the token bundle + structural cues that convey it | `affordances:` map |

Each entry is a **named token bundle + prose contract**: the prose says what
the affordance/feedback *conveys* (e.g. "danger conveys irreversible
destruction; use the destructive token bundle"), not what behavior must
happen. The token bundles reference the `'--*': value` declarations. An
affordance may be a curated *combination* of a pattern + a feedback sequence
(e.g. "danger" = a confirm-then-act loop rendering into a confirmation
pattern), not necessarily a separate token bundle — exact granularity is
open.

### The reusable thread object — the structural unit

The vocabulary composes into **reusable thread objects**, which are the
structural unit of the functional layer. A reusable thread object is:

- A **named affordance** (e.g. `danger`) — the functional intent
- A **loop structure** — the request/wait/emit sequence (the mechanic:
  sudden reveal vs gradual, confirm-then-act vs act-immediately)
- A **set of feedback states** it transitions through (e.g.
  `idle → pending → confirmation → success` or `→ error`)
- A **pattern it renders into** (e.g. a `Thread` for a comment reply, a
  `Daisy` for a primary-action-plus-secondary-loops)
- **Token bundles** for each state — pulled from the spec's `affordances:`
  and `feedback:` maps, applied in the emitted HTML

The spec declares the *vocabulary*; the reusable thread object is the
*composition* — an instance that picks from the vocabulary and orchestrates
a loop. An agent generating a thread + a template draws from the same
vocabulary, so the behavioral logic and the rendered HTML speak the same
language. **The consistency comes from the shared vocabulary, not from a
shared attribute.**

## Density & spacing

**Locked** — `--space-near` / `--space-away` are **relationship multipliers**
(relationship ratios, stable); `--density-base` is the **magnitude**,
**implied by `b-scale`** (deeper = denser). Final spacing is
`calc(var(--density-base) * var(--space-near))` (gap) and
`calc(var(--density-base) * var(--space-away))` (padding). **No `p-density`
attribute** — the scale nesting *is* the density curve. This is the
tunneling effect (deeper = denser) expressed in pure CSS custom properties +
`calc()`, no JS — and it keeps the "looking for a smaller button = asking
the surrounding density to change" property: a button's padding shrinks
automatically in a denser (lower-scale) scope.

## Carrier model

The carrier model is unchanged from the earlier lock — it governs how
templates encapsulate *element selectors*, which is independent of the
mode→affordance/feedback reframing.

### Two boundary kinds

1. **Light-DOM mode.** An inline `<style>` using `@scope { … }` encapsulates
   element selectors to a subtree. The Controller can still target
   `[b-target]` *inside* it, and custom-property inheritance passes through.
   **Use when the subtree needs Controller interactivity or inheritance
   pass-through.**

2. **Self-contained template mode** (simplify-complexity case). An HTML
   template file (no `<head>`/`<body>`, a true HTML template) whose root
   carries a **Declarative Shadow DOM**. The DSD curates its own styling via
   `:host([b-scale="…"])` inside the shadow's `<style>`; `::part()` exposes
   the opt-in outward styling hooks. The Controller **cannot see into the
   shadow** — so this is for presentational/layout subtrees that don't need
   `b-target` / `b-trigger` / Controller extensions. **Use to simplify
   complexity by moving such subtrees out of the Controller's reach.**

The shadow-DOM boundary here is a **styling/encapsulation** boundary, not a
data/permission boundary. Structural IA's Boundary (data/permissions) is a
*prose contract* that lives as one of the four pattern attributes in
`patterns:` — it is not wired to a CSS mechanism.

### Choice rule

Light-DOM `@scope` when the subtree needs the Controller or inheritance
pass-through; DSD template when the subtree is presentational/layout that
doesn't. As UI complexity grows, migrate the latter into DSD. Both boundary
kinds use `@scope` as the shared styling primitive (works in light DOM *and*
inside the shadow).

### Composition + inflight-patch seam

The agent reads template files and composes one into another; it can patch a
template's *outer* attributes inflight — change the default `b-target`,
append a `b-trigger` — during SSR (html tools) or before a Controller render.
So the **light-DOM shell** of a template instance is mutable by the
agent/Controller; the **shadow interior** is the hardened, self-styling
part. A `button.html` template "comes with its styling baked in" via DSD;
the agent drops it into a page and patches its outer attributes as needed.

### Worked example — light DOM

```html
<style>
  /* scale implies density-base; no p-density attribute */
  [b-scale="s5"] { --density-base: 0.5rem; }   /* roomy — module */
  [b-scale="s3"] { --density-base: 0.375rem; } /* default — block */
  [b-scale="s1"] { --density-base: 0.25rem; }  /* compact — object */

  /* one button. padding derives from the enclosing scale + relationship. */
  button {
    padding: calc(var(--density-base) * var(--space-near))
             calc(var(--density-base) * var(--space-away));
  }
</style>
<section b-scale="s3">
  <button>Save</button>   <!-- default density for s3 — no size prop, no variant -->
</section>
```

### Worked example — self-contained template (DSD)

```html
<!-- button.html: a true HTML template, no head/body -->
<button b-target="save">
  <template shadowrootmode="open">
    <style>
      :host([b-scale="s1"]) { --density-base: 0.25rem; }
      :host([b-scale="s3"]) { --density-base: 0.375rem; }
      button {
        padding: calc(var(--density-base) * var(--space-near))
                 calc(var(--density-base) * var(--space-away));
      }
    </style>
    <button part="control"><slot></slot></button>
  </template>
  Save
</button>
```

`:host([b-scale="…"])` makes the host's light-DOM structural attribute drive
styling inside the shadow; inherited `--density-base` from a light ancestor
pierces in unless `:host()` redefines it.

## Structural patterns

**Locked (mechanism); placement open (vocabulary)** — the spec declares a
`patterns:` frontmatter map. Each pattern has the four Structural-IA
attributes:

| Attribute | Meaning | In frontmatter |
|-----------|---------|----------------|
| **Content** | What activities/interactions take place; the *goal* for the user | Prose string |
| **Structure** | How information is organized; innate mechanics | Prose string |
| **Boundary** | What information shares in/out; permissions (prose contract, not a CSS mechanism) | Prose string |
| **Scale** | Which `b-scale` value this pattern occupies | Enum: `s1`–`s6` |

### Starter vocabulary (default, overridable)

The format spec ships a default `patterns:` map drawn from Structural IA:

- **Blocks (S3):** Pools, Streams, Feeds, Collections, Walls, Threads
- **Platform structures (S7):** Strict Hierarchy, Nested Pools, Nested
  Channels, Hypertext, Daisy, Multi-Dimensional Hierarchy

A project DESIGN.md **overrides/extends** this: it selects which patterns it
uses, fills in project-specific Content/Boundary prose, and may declare its
own domain patterns. The project's `patterns:` frontmatter is what a Phase
B agent composes from.

## Relationship to the original DESIGN.md

The original DESIGN.md is purely the **expression layer** (Alexander: visual
atoms). This derivative adds a **structure layer** (Wurman/Jaffe: functional
units) and a **functional vocabulary layer** (affordances/feedback for
behavioral threads), connected by density-from-scale. The agent designs
top-down: function → structure → expression.

| Original DESIGN.md | Effect | Status |
|---|---|---|
| **Design Tokens (frontmatter)** — grouped dot-notation, `{ref}` syntax, `components:` map | Transformed: flat `--*`→value map + `affordances:` / `feedback:` / `patterns:` maps; `var()` replaces `{ref}`; **no `components:` token block** | Transformed (kept) |
| **Overview** | Reframed for Behavioral/HTML-first + two-phase usage + functional flow | Keep |
| **Colors** | Prose; tokens live as `--color-*` in frontmatter | Keep |
| **Typography** | Keep; `font-size`/`line-height` couple to scale-implied density via `calc`/`em` | Keep |
| **Layout** | Reframe: density (from scale) × relationship-multipliers + regions, not grid + T-shirt scale | Keep (reframed) |
| **Elevation & Depth** | Prose; optional `--elevation-*` | Keep |
| **Shapes** | `--radius-*` custom properties | Keep |
| **Components** — token map with variant keys (`button-primary`, `button-primary-hover`) | **Eliminated.** No variant keys, no `components:` block. Components are `.html` templates styled with `--*` + `@scope`/`:host()`/`::part()`; their file format is an agent concern. | Eliminate |
| **Modes** | **Dropped.** Replaced by `affordances:` + `feedback:` functional vocabulary (for thread objects, not HTML attributes). | Drop / replace |
| **Structural Scale & Patterns** | *(NEW)* — `b-scale` (S1–S6 + `rel`), nesting constraint, density-from-scale, `patterns:` frontmatter map (overridable defaults) | Add |
| **Functional Vocabulary** | *(NEW)* — `affordances:` + `feedback:` maps, reusable thread objects, functional flow reasoning (substrate-neutral) | Add |
| **Do's and Don'ts** | Keep; scale + affordance/feedback-specific guidance | Keep |

Net: the spec now has three layers — **structural** (`b-scale` + patterns,
appears in HTML), **functional** (affordances + feedback, vocabulary for
thread objects, not in HTML), and **expressive** (`--*` tokens + carrier
model). `b-scale` is the only spec attribute in HTML. `p-mode` and
`p-density` are gone. The original's `components:` token map is eliminated
(the anti-pattern of variant-per-intent token proliferation that structural
patterns + functional vocabulary dissolve).

## Substrate facts (gathered from the codebase)

These were looked up rather than grilled — they are facts about how Behavioral
actually works, not decisions.

| Surface | What it does | Relevance |
|---------|--------------|-----------|
| **html tools** (SSR, `src/tools/html.ts`) | HTML-string in → `HTMLRewriter` mutations on `[b-target]` → HTML-string out. Stateless (no `#html` buffer — `html` is both input and output). Styling lives as inline `<style>` tags in the HTML. | The spec's styling vehicle is inline `<style>`; SSR pre-renders with no JS. |
| **Controller** (browser, `src/controller/controller.ts`) | WebSocket-push-driven; binds `b-trigger`/`b-form` in light DOM; applies `render`/`attrs`/`dispatch_custom_event`/`navigate`/`scale_check`. Swaps fragments via `<template>` + `setHTMLUnsafe`. User events emit `ui_event` BPEvents (`{type, detail: getAttributes(element)}`). | The Controller touches only the **light DOM**. The same `render`/`attrs` BPEvents drive both SSR (html tools) and CSR (Controller) — the vocabulary flows through both unchanged. |
| **Snapshot** | `#sendSnapshot` uses `document.documentElement.getHTML({ serializableShadowRoots: true })`. | **Declarative Shadow DOM is first-class and round-trips** through snapshots. |
| **`b-scale` / `SCALE` / `SCALE_RANK`** (`src/main/html.constants.ts`) | `B_SCALE = 'b-scale'`; `SCALE = keyMirror('s1'..'s6','rel')`; `SCALE_RANK = { s1:1 … s6:6, rel:0 }`. Old `template.ts` enforced: higher scale cannot nest inside lower; `rel` is scale-less (rank 0, nests anywhere). | The structural axis already exists in the codebase. The spec adopts it as a fixed enum + nesting constraint. `b-scale` is the only spec attribute in HTML. |
| **BPEvent shape** | One currency across the agent↔browser boundary: `render`/`attrs`/`dispatch_custom_event`/`navigate`/`scale_check` (agent→browser) and `ui_event`/`snapshot`/`error`/`success`/`scale_check_result`/`form_submit` (browser→agent). | The functional flow (trigger→logic→render) is *already* the behavioral runtime's shape. Threads orchestrating BPEvents *are* loops; *how* they orchestrate *is* the mechanic. The spec names this shape substrate-neutrally; the framework executes it. |

## Web-platform facts (gathered from MDN)

| Feature | Baseline | Relevance |
|---------|----------|-----------|
| **CSS custom properties** (`--*`) | Widely available, Apr 2017 — **`Inherited: yes`** | Inheritance **pierces the shadow-DOM boundary**: a `--x` set on a light ancestor flows into a shadow tree. The linchpin — token bundles declared for an affordance/feedback state reach the shadow interior through the same mechanism as light-DOM scopes. |
| **`@scope`** at-rule | Baseline 2025 (Dec '25: Chrome 118, Safari 17.4, Firefox 146) | **Scoping proximity** = nearest scope root wins → the native CSS implementation of nested-scope resolution. Inline form auto-scopes to the `<style>`'s parent. Bare selectors/`&` carry `:where(:scope)` (zero specificity). Isolates *selection*, not *inheritance*. |
| **`:host(<compound>)`** | Widely available, Jan 2020 | Host's light-DOM attribute drives styling *inside* the shadow, no JS: `:host([b-scale="s1"]) { --density-base: … }`. |
| **`::part(<ident>+)`** | Widely available, Jul 2020 | Opt-in *outward* styling hook: the parent DOM can style shadow elements the template chose to expose via `part="…"`. `exportparts` re-exports nested parts. |

## Open frontier

Unresolved questions still to grill. None is decided; each will become a
wayfinder ticket when sharp enough.

1. **Pattern vocabulary placement (core vs extension).** Does the starter
   `patterns:` vocabulary (Pools, Streams, Daisy, etc.) live in the core
   spec or in the coming Structural IA extension? The *mechanism*
   (`b-scale`, four-attribute declaration shape, nesting constraint) lives
   in core either way. *Held pending the next document.*

2. **Frontmatter exact shape.** Flat `--*` map vs. still-grouped-by-purpose
   with `--*` keys; how `affordances:` / `feedback:` / `patterns:` encode
   their entries (token-bundle references, prose strings, structured
   sub-keys); whether affordances are first-class or derived (a curated
   combination of pattern + feedback sequence). Affects eval ergonomics.

3. **Affordance/feedback vocabulary.** Closed canonical starter set
   (`primary`, `secondary`, `danger` / `error`, `confirmation`, `pending`,
   `success`) vs. open extension; and how the frontmatter maps relate to
   the CSS authoring (frontmatter declares the vocabulary + token bundles;
   the agent chooses the binding — class, attr, `:host()` — the spec doesn't
   prescribe).

4. **Scale → density default curve.** What `--density-base` value does each
   scale rank imply by default? Is the curve configurable in frontmatter
   (a `scale-density:` map) or fixed by the spec?

5. **Support floor / baseline policy.** `@scope` just hit Baseline Dec
   2025 — declare a floor, provide a non-`@scope` fallback, or accept the
   constraint?

6. **Conformance / linter contract.** What makes a project DESIGN.md
   conformant — use declared `--*` names exactly; forbid intent-suffixed
   names; require `p-*` not `data-*`; reject variant keys; respect
   `SCALE_RANK` nesting; density derives from scale (no `p-density`)?

*(Template-file format removed — agent concern, out of scope. Density
selector model resolved — density derives from scale, no attribute. `p-mode`
resolved — dropped, replaced by affordances/feedback vocabulary.)*

## See also

- [Controller](./controller.md) — the UI-layer reference; both the browser
  Controller and the stateless SSR html tools (HTML-string in/out, the
  inline `<style>` styling model).

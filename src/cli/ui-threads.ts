/**
 * The ui_* producer threads — the view-generation policy that turns browser
 * ingress (`ui_event`, `ui_snapshot`, `ui_form_submit`) into engine-requested
 * egress (`ui_render`, `ui_attrs`, `ui_navigate`, `ui_scale_check`).
 *
 * @remarks
 * Composition territory (no process, not a faculty) — mounted by `bProgram`
 * when the set's required faculties are on: shell (the scan recipe's
 * executor), store (the design tenant), systemTwo (generation). Absent
 * systemTwo there is no generation lane and the threads don't mount (the
 * remote-mcp precedent for conditionally-mounted core threads).
 *
 * The initial thread set is a FIRST HYPOTHESIS refined by the autoresearch
 * loop (raw capture + frontier replay, `src/cli/ui-capture.ts`) — every
 * thread derives from a structural concept or a design.md lane
 * (the 2026-09-25 design.md rulings), and anything beyond the thin vertical
 * (event → scale preflight → generation → render) is a named later iteration.
 *
 * MINIMAL notes (greppable ceilings, the upgrade path is the loop):
 * - the scan validates token-group SHAPE only — per-value CSS/dimension
 *   linting is the design.md linter's job (`npx @google/design.md lint`);
 * - the generation trigger is the b-trigger convention `render` (a ui_event
 *   whose inner BPEvent has type `render`); the wider ingress vocabulary
 *   (ui_snapshot rehydration, ui_form_submit) rides later iterations;
 * - the triggering event's DETAIL does not survive the scale-check round
 *   trip (the controller's `ui_scale_check_result` carries no source
 *   reference) — v1 composes the view from target + scale + design context.
 *
 * @packageDocumentation
 */

import type { Thread } from '../behavioral/behavioral.types.ts'
import {
  CONTROLLER_INCOMING_MESSAGE_TYPES,
  CONTROLLER_OUTGOING_MESSAGE_TYPES,
  SWAP_MODES,
} from '../controller/controller.constants.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties/faculties.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The logical scan name — the shell_request trace label. */
export const UI_DESIGN_SCAN_TOOL = 'design-scan'

/** The boot scan call's correlation id — the tenant transform matches on it. */
export const UI_DESIGN_SCAN_CALL_ID = 'ui-design-scan'

/** The store collection holding the design tenant. */
export const UI_DESIGN_COLLECTION = 'design'

/** The tenant's store key — one value, the whole scanned context. */
export const UI_DESIGN_CONTEXT_KEY = 'context'

// ── The tenant contract — schema-data: one shape, three uses (thread gate,
//    store admission, model-facing vocabulary derivation) ────────────────────

/**
 * The design tenant — the scanned `<home>/DESIGN.md` as data:
 * `tokens` (the YAML frontmatter groups, unknown groups verbatim; null when
 * absent or rejected), `sections` (the `##` prose sections by title; null
 * when absent or rejected), `warnings` (warnings-as-data, the catalog
 * posture). A null-tokens tenant is the plain-degradation lane: generation
 * proceeds without design context, never gated.
 */
export const UI_DESIGN_CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    tokens: { type: 'object', required: [], additionalProperties: true, nullable: true },
    sections: { type: 'object', required: [], additionalProperties: true, nullable: true },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['tokens', 'sections', 'warnings'],
  additionalProperties: false,
} as const

// ── The scan recipe (stored-recipe flavor: the SKILL.md fence-slicing +
//    YAML.parse contract, applied to the home DESIGN.md) ────────────────────

/**
 * The design-scan recipe — executed bun-direct by the shell worker's `run`
 * op (script on stdin).
 *
 * Reads the USER'S `<home>/DESIGN.md` (the no-lock contract: the shipped
 * asset at `skills/behavioral/assets/DESIGN.md` is an init-copied seed; the
 * runtime never reads the asset, never re-syncs it — a replaced or deleted
 * home file fully replaces/removes the design context). Missing file is not
 * an error (the skills-scan posture): the empty shape `{ tokens: null,
 * sections: null, warnings: [] }`, no tenant.
 *
 * Validation is lenient per the design.md consumer table (google-labs-code/
 * design.md, docs/spec.md): unknown frontmatter groups and body sections
 * ride verbatim; spec-named groups (`colors`/`typography`/`rounded`/
 * `spacing`) validate by shape — a malformed group drops with a warning; a
 * duplicate `##` section heading REJECTS the file (the one file-level
 * rejection the table names) — tokens and sections null, the rejection
 * riding the warnings.
 */
export const DESIGN_SCAN_SCRIPT = `
import { homedir } from 'node:os'
import { join } from 'node:path'
import { YAML } from 'bun'

const SPEC_GROUPS = new Map([
  ['colors', 'string'],
  ['typography', 'object'],
  ['rounded', 'dimension'],
  ['spacing', 'dimension'],
])

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const validTokenValue = (value, groupType) => {
  if (groupType === 'object') return isPlainObject(value)
  if (groupType === 'string') return typeof value === 'string'
  return typeof value === 'string' || typeof value === 'number'
}

const home = process.env.BEHAVIORAL_HOME ?? join(homedir(), '.behavioral')
const out = { tokens: null, sections: null, warnings: [] }

const file = Bun.file(join(home, 'DESIGN.md'))
if (await file.exists()) {
  const text = await file.text()

  // Front matter: the --- fence; the YAML slice ONLY (never the whole file).
  let frontmatter = null
  let body = text
  const fence = text.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/)
  if (fence !== null) {
    body = text.slice(fence[0].length)
    try {
      const parsed = YAML.parse(fence[1])
      if (isPlainObject(parsed)) {
        frontmatter = parsed
      } else {
        out.warnings.push('DESIGN.md frontmatter must be a YAML object; the token groups are dropped')
      }
    } catch {
      out.warnings.push('DESIGN.md frontmatter is unparseable YAML; the token groups are dropped')
    }
  }

  // Body sections: ## headings only (a # title is not a section). A
  // duplicate heading rejects the file (the consumer table's one
  // file-level rejection).
  const sections = new Map()
  let current = null
  let rejected = false
  for (const line of body.split(/\\r?\\n/)) {
    const heading = line.match(/^## (.+)$/)
    if (heading !== null) {
      const title = heading[1].trim()
      if (sections.has(title)) {
        out.warnings.push('Duplicate section heading "## ' + title + '": the file is rejected')
        rejected = true
        break
      }
      current = { title, lines: [] }
      sections.set(title, current)
      continue
    }
    if (current !== null) current.lines.push(line)
  }

  if (!rejected) {
    const sectionMap = {}
    for (const [title, section] of sections) sectionMap[title] = section.lines.join('\\n').trim()
    out.sections = Object.keys(sectionMap).length > 0 ? sectionMap : null

    if (frontmatter !== null) {
      // Spec-named groups validate by shape (a bad group drops with a
      // warning); unknown keys ride verbatim (the consumer table).
      const tokens = {}
      for (const key of Object.keys(frontmatter)) {
        const groupType = SPEC_GROUPS.get(key)
        if (groupType === undefined) {
          tokens[key] = frontmatter[key]
          continue
        }
        const value = frontmatter[key]
        if (
          !isPlainObject(value) ||
          !Object.values(value).every((token) => validTokenValue(token, groupType))
        ) {
          out.warnings.push('Token group "' + key + '" is not a flat map of valid ' + groupType + ' tokens; the group is dropped')
          continue
        }
        tokens[key] = value
      }
      out.tokens = tokens
    }
  }
}
console.log(JSON.stringify(out))
`

// ── Threads ───────────────────────────────────────────────────────────────────

/** design-scan-boot — once: the scan recipe is requested at boot; the shell worker pipes it. */
const designScanBoot: Thread = {
  label: 'ui/design-scan-boot',
  once: true,
  rules: [
    {
      request: {
        type: FACULTY_MESSAGE_KINDS.shell_request,
        detail: {
          id: UI_DESIGN_SCAN_CALL_ID,
          label: UI_DESIGN_SCAN_TOOL,
          input: { op: 'run', script: DESIGN_SCAN_SCRIPT, format: 'json' },
        },
      },
    },
  ],
}

/**
 * design-tenant — a scan result carrying a design context (or a rejected
 * file's warnings) is put into the store as the tenant. The empty shape
 * (missing DESIGN.md) puts nothing. Fail-closed: a malformed result fails
 * the detailSchema gate, never partial admission.
 */
const designTenant: Thread = {
  label: 'ui/design-tenant',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.shell_request_result,
          query:
            '. as $d | select($d.result.jsonData.tokens != null or $d.result.jsonData.sections != null or ($d.result.jsonData.warnings | length) > 0) | { id: "ui-design-tenant", op: "put", input: { collection: "design", key: "context", value: $d.result.jsonData } }',
          target: FACULTY_MESSAGE_KINDS.store_request,
          // The validate-before-put gate: strict at jsonData (the tenant
          // contract), loose around it (the envelope's schema home is the
          // shell faculty).
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', const: UI_DESIGN_SCAN_CALL_ID },
              result: {
                type: 'object',
                properties: { jsonData: UI_DESIGN_CONTEXT_SCHEMA },
                required: ['jsonData'],
                additionalProperties: true,
              },
            },
            required: ['id', 'result'],
            additionalProperties: true,
          },
        },
      ],
    },
  ],
}

// ── The scale preflight — Structural IA/E: fixed mechanism (the controller
//    resolves the DOM fact), thread-authored policy (the hold) ────────────────

/** The generation trigger's event type — the b-trigger convention (`b-trigger="click:render"`). */
export const UI_RENDER_TRIGGER_TYPE = 'render'

/**
 * The generation request's event type — thread-owned, NOT a controller
 * `ui_*` message (the egress fan-out emits `ui_*` selections to clients; the
 * pipeline's own vocabulary stays off that wire).
 */
export const UI_GENERATE_EVENT_TYPE = 'generate'

/** The preflight's scale-check request id — the result join (the controller echoes the id). */
export const UI_SCALE_CHECK_CALL_ID = 'ui-scale-check'

/** The default render target when the trigger carries none. */
export const UI_RENDER_TARGET = 'body'

/** The render swap mode the pipeline composes with. */
export const UI_RENDER_SWAP: (typeof SWAP_MODES)[keyof typeof SWAP_MODES] = SWAP_MODES.innerHTML

/** The render trigger's detail contract — any object; `target` names the render target. */
const RENDER_TRIGGER_SCHEMA = {
  type: 'object',
  properties: { target: { type: 'string', minLength: 1 } },
  required: [],
  additionalProperties: true,
} as const

/**
 * The generation request's detail — the scale-stamped trigger. The effective
 * scale and target ride `ctx` (host-supplied, never model-facing — the
 * Consumption/F lane); `echo.check` carries the scale-check lineage.
 */
export const UI_GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    ctx: {
      type: 'object',
      properties: {
        scale: { type: 'string', minLength: 1 },
        target: { type: 'string', minLength: 1 },
        echo: { type: 'object', required: [], additionalProperties: true },
      },
      required: ['scale', 'target'],
      additionalProperties: true,
    },
  },
  required: ['ctx'],
  additionalProperties: false,
} as const

/**
 * The scale preflight — the admission-gate shape over the DOM fact:
 *
 * - rule 1 — a `render` trigger derives its `ui_scale_check` request (the
 *   controller resolves the target's effective `b-scale` and replies
 *   `ui_scale_check_result`, joined by the echoed id — the controller wire
 *   carries no ctx, so the id IS the join lane);
 * - rule 2 — the hold: the `generate` request is BLOCKED until the
 *   correlated result re-enters, and the result is stamped INTO the
 *   generation request's `ctx` (block + transform in one sync point — the
 *   block is the in-flight discipline, the transform is the release).
 *
 * Without a browser attached the result never arrives: the preflight parks
 * at rule 2 with its block declared — the deadlocked-ish hold visible in the
 * frontier (pending_bids), CORRECT for the first pass (no browser, no scale
 * fact, no generation). A foreign-echo result (a different id) never matches
 * the listener — it joins nothing and the hold stands.
 */
const preflight: Thread = {
  label: 'ui/preflight',
  rules: [
    {
      transform: [
        {
          type: UI_RENDER_TRIGGER_TYPE,
          detailSchema: RENDER_TRIGGER_SCHEMA,
          query: `. as $d | { id: "${UI_SCALE_CHECK_CALL_ID}", target: ($d.target // "${UI_RENDER_TARGET}"), swap: "${UI_RENDER_SWAP}" }`,
          target: CONTROLLER_INCOMING_MESSAGE_TYPES.ui_scale_check,
        },
      ],
    },
    {
      block: [{ type: UI_GENERATE_EVENT_TYPE }],
      transform: [
        {
          type: CONTROLLER_OUTGOING_MESSAGE_TYPES.ui_scale_check_result,
          detailSchema: {
            type: 'object',
            properties: { id: { type: 'string', const: UI_SCALE_CHECK_CALL_ID } },
            required: ['id'],
            additionalProperties: true,
          },
          query: `. as $d | { ctx: { scale: $d.effectiveScale, target: $d.target, echo: { check: $d.id } } }`,
          target: UI_GENERATE_EVENT_TYPE,
        },
      ],
    },
  ],
}

/** The ui_* producer threads — the thread set `bProgram` mounts with shell + store + systemTwo. */
export const uiThreads: Thread[] = [designScanBoot, designTenant, preflight]

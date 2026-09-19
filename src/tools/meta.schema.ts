/**
 * `BMeta` — embedded metadata for learned artifacts (threads and html), the
 * OKF-vocabulary self-description the reconcile scan indexes (plan.md
 * Decision Log 2026-09-17). One schema, two carriers by medium:
 *
 * - **html:** `<script type="application/json" b-meta>...</script>` — extracted
 *   by the `html.ts` rewriter passes and validated here.
 * - **threads:** `export const meta: BMeta = {...}` — TS-native, type-checked
 *   against the same shared JSON schema; the reconcile scan validates the
 *   imported value at ingestion.
 *
 * Vocabulary borrowed from the Open Knowledge Format (§4/§5) — the value
 * families, not the bundle format. OKF is a reference, not a dependency.
 *
 * ANTI-DRIFT RULE: this module is the one Meta schema home — both carriers and
 * every tool import from here; never re-declare the vocabulary downstream.
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import { ajv } from './define-tool.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetaStatus = 'draft' | 'stable' | 'deprecated'

export type MetaStamp = {
  /** What authored/stamped it — a turn id, a model id, or a tool name. */
  by: string
  /** ISO timestamp of the stamp. */
  at: string
}

/**
 * Embedded artifact metadata. `description` is the search text the
 * discovery read-model indexes; `verified` is where the autoresearch gate
 * writes its keep decision (the promotion ladder); `status` tracks the
 * candidate → promoted → retired lifecycle.
 */
export type Meta = {
  /** Artifact kind (e.g. `thread`, `html`). */
  type: string
  /** Human-readable title. */
  title: string
  /** The search text — what the artifact is for. */
  description: string
  /** Which turn/model authored the artifact. */
  generated: MetaStamp
  /** Lifecycle: draft → stable → deprecated. */
  status: MetaStatus
  /** Free-form topic tags. */
  tags?: string[]
  /** Keep decisions — the autoresearch gate writes here (promotion ladder). */
  verified?: MetaStamp[]
  /** Date after which the artifact should be re-verified. */
  stale_after?: string
  /** Provenance when the artifact distills research. */
  sources?: string[]
}

// ---------------------------------------------------------------------------
// JSON schema + validator
// ---------------------------------------------------------------------------

export const MetaSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1, description: 'artifact kind (e.g. thread, html)' },
    title: { type: 'string', minLength: 1, description: 'human-readable title' },
    description: { type: 'string', minLength: 1, description: 'the search text' },
    generated: {
      type: 'object',
      properties: {
        by: { type: 'string', minLength: 1, description: 'turn id, model id, or tool name' },
        at: { type: 'string', minLength: 1, description: 'ISO timestamp' },
      },
      required: ['by', 'at'],
      additionalProperties: false,
      description: 'which turn/model authored the artifact',
    },
    status: { type: 'string', enum: ['draft', 'stable', 'deprecated'], description: 'lifecycle status' },
    tags: { type: 'array', items: { type: 'string' }, description: 'free-form topic tags' },
    verified: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          by: { type: 'string', minLength: 1 },
          at: { type: 'string', minLength: 1 },
        },
        required: ['by', 'at'],
        additionalProperties: false,
      },
      description: 'keep decisions from the autoresearch gate',
    },
    stale_after: { type: 'string', description: 'date after which the artifact should be re-verified' },
    sources: { type: 'array', items: { type: 'string' }, description: 'provenance references' },
  },
  required: ['type', 'title', 'description', 'generated', 'status'],
  additionalProperties: false,
} as unknown as JSONSchemaType<Meta>

/** @internal Compiled once on the shared tools ajv. */
export const validateMeta = ajv.compile(MetaSchema)

export type MetaParseResult = { ok: true; meta: Meta } | { ok: false; message: string }

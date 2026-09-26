import type { JSONSchemaType } from 'ajv'
import { ajv, type Thread, ThreadSchema } from '../../behavioral/behavioral.types.ts'
import { FACULTY_MESSAGE_KINDS } from '../faculties.constants.ts'
import { type ChoiceQuestion, choiceQuestionSchema } from './schemas.ts'

/**
 * The System One faculty's threads — the admission judgment threads (the
 * BP-native blocking judge) and the supervision threads (the runtime
 * circuit breaker — the admission pattern rotated to runtime).
 *
 * @remarks
 * **Admission judgment** — when systemOne is wired, a validated candidate
 * (the `add_thread` op's structural verdict) does not admit directly: its
 * admission is BLOCKED while a system-one Decision judges the proposed
 * thread, and the Decision determines whether the block lifts.
 *
 * Three threads, mounted by `bProgram` only when systemOne is on (the judge
 * requires the Decisions lane; the frontier — its structural layer — is the
 * in-process embed, always present):
 *
 * - **`admission-issue`** — a `thread_candidate` event (the composition's
 *   emission: a validated candidate awaiting judgment) issues the correlated
 *   `system_one_request` (`<candidate>-judge`) carrying the proposed thread
 *   as the Decision input (state: the thread; question: a choice between
 *   `admit` and `reject`).
 * - **`admission-gate`** — the blocking judge itself. It waits for a
 *   candidate, then BLOCKS every `thread_admission` while the Decision is in
 *   flight. The block lifts only when the judgment's outcome lands: an
 *   approve-shaped result, or the rejection event (so a rejection holds the
 *   line through its own processing — the candidate never goes live — without
 *   poisoning later candidates' admissions). Then the loop wraps to the next
 *   candidate (a block-only span would hold forever; the waitFor pair is
 *   what releases it, per the guard-thread pattern's inverse).
 * - **`admission-verdict`** — the judge-correlated result maps to the
 *   outcome: `thread_admission { id, admit: true }` on an approve choice,
 *   `thread_admission_rejected { id, admit: false }` on anything else —
 *   a not-ok result, a malformed answer, a non-`admit` choice. Fail-closed:
 *   the only road to admission is an explicit approve.
 *
 * The composition owns the write: `thread_admission` selections admit the
 * pending candidate (the id map stays the authorization); rejected ids drop.
 * Concurrent candidates each judge independently (id-correlated); the gate's
 * block is the type-scoped judging window, advisory when several judgments
 * overlap — per-candidate correctness lives in the correlation, never in the
 * window.
 *
 * MINIMAL: the Decision's policy (what makes a thread "appropriate") is the
 * fixed instruction below; a policy input rides a config seam when a named
 * need arrives. Hostile-thread forgery of `thread_admission` is the same
 * class as the existing frontier_request self-request posture — a known
 * frontier for a later hardening slice.
 *
 * **Supervision** — `supervisionThreads({ watch, threshold })` builds one
 * count-bounded supervisor per watched event type: the thread's rule
 * position is the counter, the trip rule blocks the type mid-cascade and
 * surfaces `supervision_tripped { type, count, threshold }`, and the hold
 * rule parks the block until a `supervision_release` for that type (the
 * wrap-back is the counter reset). See the supervision section below.
 *
 * @packageDocumentation
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Thread-owned event types: the candidate in, the judged outcome out. */
export const ADMISSION_EVENT_TYPES = {
  candidate: 'thread_candidate',
  admitted: 'thread_admission',
  rejected: 'thread_admission_rejected',
} as const

/** The judge-request correlation suffix: `<candidate>-judge` ↔ the result's echoed id. */
export const ADMISSION_JUDGE_SUFFIX = '-judge'

/** The Decision question the judgment asks (the `admission` choice). */
export const ADMISSION_QUESTION = 'admission'

// ── Trusted shapes ───────────────────────────────────────────────────────────

/** A candidate's detail: the composition-validated proposal, keyed by the pending admission id. */
export const ADMISSION_CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    thread: ThreadSchema,
  },
  required: ['id', 'thread'],
  additionalProperties: false,
} as const

/**
 * The judge-correlated result detail the verdict listeners trust — the id
 * suffix scopes the lane (other Decisions on the same faculty never match).
 */
export const ADMISSION_JUDGE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '-judge$' },
    ok: { type: 'boolean' },
  },
  required: ['id', 'ok'],
  additionalProperties: true,
} as const

/**
 * The approve-shaped result — the gate's lift condition. The block releases
 * on an explicit `admit` choice; every other outcome (reject, error,
 * malformed) holds until the rejection event releases it.
 */
export const ADMISSION_JUDGE_APPROVAL_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '-judge$' },
    ok: { type: 'boolean', const: true },
    result: {
      type: 'object',
      properties: {
        answers: {
          type: 'object',
          properties: {
            [ADMISSION_QUESTION]: {
              type: 'object',
              properties: { choice: { type: 'string', const: 'admit' } },
              required: ['choice'],
            },
          },
          required: [ADMISSION_QUESTION],
        },
      },
      required: ['answers'],
    },
  },
  required: ['id', 'ok', 'result'],
  additionalProperties: true,
} as const

// ── Shared jq fragments ──────────────────────────────────────────────────────

/**
 * The judge answer, normalized: every non-object on the answer path coalesces
 * to `{}` so a hostile/malformed payload can never crash the queries — it
 * falls through to the reject listener (fail-closed), never a jq error.
 */
const JUDGE_ANSWER =
  '(if ($d.result | type) == "object" then $d.result else {} end) as $r | ' +
  '(if ($r.answers | type) == "object" then $r.answers else {} end) as $a | ' +
  '(if ($a.admission | type) == "object" then $a.admission else {} end) as $q'

/** The judged outcome — the Decision's answer mapped to a structured admission call. */
export type AdmissionVerdict = {
  /** The candidate's pending-admission id (the composition's key). */
  id: string
  /** The Decision's call: true admits the candidate, false keeps it out. */
  admit: boolean
  /**
   * Optional free-text why. The choice answer carries no prose today, so the
   * mapping emits none — a reason rides a future answer type, never a guess.
   */
  reason?: string
}

/** The judged outcome's schema — the composition's admission gate validates against this home. */
export const ADMISSION_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    admit: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['id', 'admit'],
  additionalProperties: false,
} as unknown as JSONSchemaType<AdmissionVerdict>

/**
 * The Decision input the judgment issues: the proposed thread rides as state
 * (the schema derives from the engine's ThreadSchema — one home, no
 * mirroring), the question is the admit/reject choice over the shared
 * question schema.
 */
export type AdmissionDecisionInput = {
  state: { lane: 'admission-judgment'; thread: Thread }
  questions: { [ADMISSION_QUESTION]: ChoiceQuestion }
}

export const ADMISSION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: {
      type: 'object',
      properties: {
        lane: { type: 'string', const: 'admission-judgment' },
        thread: ThreadSchema,
      },
      required: ['lane', 'thread'],
      additionalProperties: false,
    },
    questions: {
      type: 'object',
      properties: { [ADMISSION_QUESTION]: choiceQuestionSchema },
      required: [ADMISSION_QUESTION],
      additionalProperties: false,
    },
  },
  required: ['state', 'questions'],
  additionalProperties: false,
} as unknown as JSONSchemaType<AdmissionDecisionInput>

/** The issued Decision input's boundary — the threads' jq must produce exactly this. */
export const validateAdmissionInput = ajv.compile(ADMISSION_INPUT_SCHEMA)

/** The judged outcome's boundary — the composition's admission gate consumes only conforming verdicts. */
export const validateAdmissionVerdict = ajv.compile(ADMISSION_VERDICT_SCHEMA)

// ── Threads ──────────────────────────────────────────────────────────────────

/** admission-issue — a candidate issues the correlated `system_one_request` with the thread as Decision input. */
const admissionIssue: Thread = {
  label: 'system-one/admission-issue',
  rules: [
    {
      transform: [
        {
          type: ADMISSION_EVENT_TYPES.candidate,
          query: `. as $d | select($d.thread.label != null and $d.thread.rules != null)
| { id: ($d.id + "${ADMISSION_JUDGE_SUFFIX}"), input: {
    state: { lane: "admission-judgment", thread: $d.thread },
    questions: { ${ADMISSION_QUESTION}: { type: "choice",
      instructions: "Admission judgment: decide whether this proposed behavioral thread should join the live program. It is already structurally valid; judge appropriateness — what it requests, waits for, and blocks, and whether that is safe and in scope.",
      criteria: { admit: "The thread is appropriate to admit.", reject: "The thread is not appropriate — keep it out." } } } } }`,
          target: FACULTY_MESSAGE_KINDS.system_one_request,
          detailSchema: ADMISSION_CANDIDATE_SCHEMA,
        },
      ],
    },
  ],
}

/** admission-gate — the blocking judge: admission is blocked while the Decision is in flight. */
const admissionGate: Thread = {
  label: 'system-one/admission-gate',
  rules: [
    { waitFor: [{ type: ADMISSION_EVENT_TYPES.candidate, detailSchema: ADMISSION_CANDIDATE_SCHEMA }] },
    {
      block: [{ type: ADMISSION_EVENT_TYPES.admitted }],
      waitFor: [
        { type: FACULTY_MESSAGE_KINDS.system_one_request_result, detailSchema: ADMISSION_JUDGE_APPROVAL_SCHEMA },
        { type: ADMISSION_EVENT_TYPES.rejected },
      ],
    },
  ],
}

/** admission-verdict — the judge-correlated result maps to the outcome; everything but an explicit approve rejects. */
const admissionVerdict: Thread = {
  label: 'system-one/admission-verdict',
  rules: [
    {
      transform: [
        {
          type: FACULTY_MESSAGE_KINDS.system_one_request_result,
          query: `. as $d | ${JUDGE_ANSWER}
| select(($d.id | endswith("${ADMISSION_JUDGE_SUFFIX}")) and (($d.ok // false) == true) and ($q.type == "choice") and ($q.choice == "admit"))
| { id: ($d.id | sub("${ADMISSION_JUDGE_SUFFIX}$"; "")), admit: true }`,
          target: ADMISSION_EVENT_TYPES.admitted,
          detailSchema: ADMISSION_JUDGE_RESULT_SCHEMA,
        },
        {
          type: FACULTY_MESSAGE_KINDS.system_one_request_result,
          query: `. as $d | ${JUDGE_ANSWER}
| select(($d.id | endswith("${ADMISSION_JUDGE_SUFFIX}")) and ((($d.ok // false) != true) or ($q.type != "choice") or ($q.choice != "admit")))
| { id: ($d.id | sub("${ADMISSION_JUDGE_SUFFIX}$"; "")), admit: false }`,
          target: ADMISSION_EVENT_TYPES.rejected,
          detailSchema: ADMISSION_JUDGE_RESULT_SCHEMA,
        },
      ],
    },
  ],
}

/** The admission judgment threads — mounts with systemOne (the composition wires it). */
export const admissionJudgmentThreads: Thread[] = [admissionIssue, admissionGate, admissionVerdict]

// ── Supervision — the runtime circuit breaker ─────────────────────────────

/**
 * The supervision threads — the runtime circuit breaker, the admission
 * pattern rotated: a supervisor waits on a watched event type, counts
 * selections, and at a threshold BLOCKS the type — the circuit-breaker
 * declaration. The block takes effect at the NEXT super-step, mid-cascade:
 * the cascade's own advance passes through the supervisor each selection,
 * so the breaker fires before the recursive cascade overflows the stack
 * (~8.6k deep). No process kill, no abort signal, no engine surgery.
 *
 * @remarks
 * The counter is the thread's rule position — the pure-BP shape. Each
 * watched-type supervisor is one thread:
 *
 * - `threshold` × `{waitFor: watched}` — every selection of the type resumes
 *   the generator and advances one rule; the position IS the count.
 * - the trip rule — `{block: watched, request: supervision_tripped}` — the
 *   block goes active for the next super-step (the loop's re-request is
 *   filtered, the cascade dies), and the trip surfaces as a typed selection
 *   (NOT an engine trace kind — threads surface typed events to the host,
 *   the mcp auth-surfacer pattern) carrying `{ type, count, threshold }`.
 * - the hold rule — `{block: watched, waitFor: supervision_release}` — parks
 *   the block until a release for THIS type arrives; the wrap back to the
 *   first rule after a release is the counter reset (slice 2's judge wires
 *   the release; slice 3's override ingress does too).
 *
 * The block is type-scoped BY DESIGN — it stops the event KIND, not one
 * thread: correct for a breaker. The watch list is config (v1 watches what
 * the composition tells it to — no auto-discovery); systemOne adds no
 * threads itself, so there is no proposer/judge conflict. Mounts with
 * systemOne (the composition's mount gates).
 *
 * MINIMAL: the threshold is a count, not a rate — a timer event source does
 * not exist in the engine, so count thresholds are the v1 mechanism; a rate
 * rides a future event source if a named need arrives.
 */

/** Supervision-owned event types: the trip surfaces; the release lifts a block. */
export const SUPERVISION_EVENT_TYPES = {
  tripped: 'supervision_tripped',
  release: 'supervision_release',
} as const

/** The default count threshold — under the ~8.6k cascade overflow, so the breaker fires mid-cascade. */
export const SUPERVISION_DEFAULT_THRESHOLD = 4096

/** The surfaced trip — the breaker's observation, consumed by the host/judge. */
export type SupervisionTripped = {
  /** The watched event type that tripped. */
  type: string
  /** The selections observed at trip — the threshold, by construction. */
  count: number
  /** The configured threshold. */
  threshold: number
}

/** The trip detail's one home — consumers (host egress, the judge) derive from this, never hand-mirror. */
export const SUPERVISION_TRIPPED_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 1 },
    threshold: { type: 'integer', minimum: 1 },
  },
  required: ['type', 'count', 'threshold'],
  additionalProperties: false,
} as unknown as JSONSchemaType<SupervisionTripped>

/** The trip detail's boundary — consumers validate surfaced trips against this home. */
export const validateSupervisionTripped = ajv.compile(SUPERVISION_TRIPPED_SCHEMA)

/**
 * Build the supervision threads — one supervisor per watched type. The watch
 * list is composition config (v1: what it says, no auto-discovery); the
 * threshold defaults under the cascade overflow.
 */
export const supervisionThreads = ({
  watch,
  threshold = SUPERVISION_DEFAULT_THRESHOLD,
}: {
  watch: string[]
  threshold?: number
}): Thread[] =>
  watch.map((watchedType) => ({
    label: `system-one/supervisor(${watchedType})`,
    rules: [
      // The counter: `threshold` wait-steps — each selection of the watched
      // type advances one rule; the position is the count.
      ...Array.from({ length: threshold }, () => ({ waitFor: [{ type: watchedType }] })),
      // The trip: the block goes active for the next super-step (mid-cascade),
      // and the trip surfaces as a typed selection beside it.
      {
        block: [{ type: watchedType }],
        request: {
          type: SUPERVISION_EVENT_TYPES.tripped,
          detail: { type: watchedType, count: threshold, threshold } satisfies SupervisionTripped,
        },
      },
      // The hold: the block parks until a release for THIS type arrives;
      // the wrap back to the counter after a release is the reset.
      {
        block: [{ type: watchedType }],
        waitFor: [
          {
            type: SUPERVISION_EVENT_TYPES.release,
            detailSchema: {
              type: 'object',
              properties: { type: { type: 'string', const: watchedType } },
              required: ['type'],
            },
          },
        ],
      },
    ],
  }))

/**
 * Autoresearch loop — generate → gate → promote/discard → log.
 *
 * @remarks
 * The reusable script that is the autoresearch loop (Q8/A). Karpathy-
 * autoresearch shape: one mutable surface (the thread), a fixed evaluator
 * (a proof, not a scalar metric), keep/discard, loop.
 *
 * The loop:
 * 1. Read the current thread (the mutable surface —
 *    {@link PROGRESSIVE_DISCLOSURE_THREAD}).
 * 2. Generate a candidate (full replacement Thread). Scripted first
 *    (deterministic); then model-respond via a provisioned endpoint
 *    (z-ai/glm-5.3-flash) — validated against the Thread schema before
 *    gating. A malformed model proposal → discard, not crash.
 * 3. Gate the candidate:
 *    - Safety:      frontierVerify(candidate) → verified
 *    - Usefulness:  frontierExplore(candidate, {maxDepth}) → stateGraph has
 *      a node whose frontier matches the target predicate (some valid path
 *      reaches the goal). NOT strict same-trace replay.
 * 4. keep/discard:
 *    - pass both → promote (host-side commit; the sandbox verifies, the host
 *      commits). Stop on first pass.
 *    - fail either → discard.
 * 5. Append to the JSONL results log.
 *
 * The gate is pure (no model) — frontier-verify + frontier-explore. GLM only
 * generates. Iteration cap K + stop-on-first-pass. Log every iteration
 * regardless of outcome.
 *
 * @packageDocumentation
 */

import type { BPEvent, Thread } from '../behavioral/behavioral.types.ts'
import { validateThread } from '../behavioral/behavioral.types.ts'
import type { FrontierStateNode } from '../tools/frontier.ts'
import { frontierExplore, frontierVerify } from '../tools/frontier.ts'

// ---------------------------------------------------------------------------
// Target predicate — the usefulness signal
// ---------------------------------------------------------------------------

/**
 * A target predicate: does this state graph contain a node whose frontier
 * satisfies the target condition (some valid path reaches the goal)?
 *
 * The progressive-disclosure target: the thread reaches a terminal `idle`
 * frontier (all rules consumed) that was arrived at via a `turn.end`
 * selection edge from a node where `skill.read` was enabled. This proves the
 * full search→pick→load→terminate cycle completed — the thread didn't just
 * deadlock into idle, it actively drove through every phase and terminated.
 *
 * @param stateGraph - The explored state graph from frontierExplore.
 * @returns `true` when some node satisfies the target.
 *
 * @public
 */
export const progressiveDisclosureTargetPredicate = (stateGraph: Record<string, FrontierStateNode>): boolean => {
  // Path-reachability: is there a root→terminal path whose selected edges
  // include both 'discovery.search' (search phase) and 'skill.read' (load
  // phase)? This proves the full search→pick→load→terminate cycle is
  // reachable — the thread accomplishes its task via some valid path. A
  // broken variant that skips search (no 'discovery.search' edge on any
  // path to a terminal idle) fails; a differently-routed variant that
  // swaps the order but still includes both phases passes.
  const nodes = Object.values(stateGraph)
  const root = nodes.find((n) => n.step === 0)
  if (!root) return false

  // DFS from the root's successors, accumulating selected event types along
  // the path. A terminal node (no successors, idle, step > 0) satisfies the
  // target when the path includes both required event types.
  const hasPath = (nodeKey: string, selectedTypes: Set<string>, visited: Set<string>): boolean => {
    const node = stateGraph[nodeKey]
    if (!node) return false
    if (node.successors.length === 0) {
      return (
        node.frontier.status === 'idle' &&
        node.step > 0 &&
        selectedTypes.has('discovery.search') &&
        selectedTypes.has('skill.read')
      )
    }
    for (const succ of node.successors) {
      if (visited.has(succ.to)) continue
      const newTypes = new Set(selectedTypes)
      newTypes.add(succ.selection.type)
      const newVisited = new Set(visited)
      newVisited.add(succ.to)
      if (hasPath(succ.to, newTypes, newVisited)) return true
    }
    return false
  }

  for (const succ of root.successors) {
    const types = new Set<string>([succ.selection.type])
    if (hasPath(succ.to, types, new Set([succ.to]))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Gate — the pure evaluator
// ---------------------------------------------------------------------------

/** Input for {@link gateCandidate}. */
export type GateInput = {
  /** The candidate thread to evaluate. */
  candidate: Thread
  /** External trigger events that may wake the thread past wait-fors. */
  triggers: BPEvent[]
  /** Maximum exploration depth. */
  maxDepth: number
  /** Space stamp. */
  space: string
  /** Target predicate (defaults to progressive-disclosure). */
  targetPredicate?: (stateGraph: Record<string, FrontierStateNode>) => boolean
}

/** One gate result — the verdict for a single candidate. */
export type GateResult = {
  /** 'verified' | 'failed' | 'truncated' from frontierVerify, or 'rejected' (invalid Thread). */
  verifyStatus: string
  /** Did the state graph satisfy the target predicate? */
  targetReached: boolean
  /** keep (both pass) or discard (either fails)? */
  kept: boolean
  /** The frontier-explore state graph (for the results log). */
  trace: Record<string, FrontierStateNode>
}

/**
 * Gate a candidate: safety (frontierVerify) + usefulness (frontierExplore →
 * target predicate). Pure — no model, no I/O.
 *
 * @param input - {@link GateInput}
 * @returns {@link GateResult}
 *
 * @public
 */
export const gateCandidate = async ({
  candidate,
  triggers,
  maxDepth,
  space,
  targetPredicate = progressiveDisclosureTargetPredicate,
}: GateInput): Promise<GateResult> => {
  // Validate the candidate against the Thread schema first. A malformed model
  // proposal → reject, not crash.
  if (!validateThread(candidate)) {
    return {
      verifyStatus: 'rejected',
      targetReached: false,
      kept: false,
      trace: {},
    }
  }

  // Safety gate: frontierVerify → verified (no deadlock/livelock).
  const verifyResult = await frontierVerify({
    threads: [candidate],
    triggers,
    maxDepth,
    progress: ['turn.end'],
    space,
  })

  // Usefulness gate: frontierExplore → stateGraph has a node matching the target.
  const exploreResult = await frontierExplore({
    threads: [candidate],
    triggers,
    maxDepth,
    space,
  })

  const targetReached = targetPredicate(exploreResult.stateGraph)

  return {
    verifyStatus: verifyResult.status,
    targetReached,
    kept: verifyResult.status === 'verified' && targetReached,
    trace: exploreResult.stateGraph,
  }
}

// ---------------------------------------------------------------------------
// Loop — generate → gate → promote/discard → log
// ---------------------------------------------------------------------------

/** A generator function: produce a candidate Thread from the current thread. */
export type Generator = (currentThread: Thread) => Promise<Thread>

/** A promote function: write the promoted candidate host-side. */
export type Promote = (candidate: Thread) => Promise<void>

/** A gate function: evaluate a candidate. Defaults to {@link gateCandidate}. */
export type Gate = (input: GateInput) => Promise<GateResult>

/** Configuration for {@link runAutoresearchLoop}. */
export type LoopConfig = {
  /** The current mutable-surface thread (read at the start). */
  currentThread: Thread
  /** External triggers for the gate. */
  triggers: BPEvent[]
  /** Max exploration depth for the gate. */
  maxDepth: number
  /** Space stamp. */
  space: string
  /** Iteration cap K. */
  maxIterations: number
  /** The generator (scripted or model-respond). */
  generator: Generator
  /** The promote callback (host-side commit). */
  promote: Promote
  /** Target predicate (defaults to progressive-disclosure). */
  targetPredicate?: (stateGraph: Record<string, FrontierStateNode>) => boolean
  /** Gate function (defaults to {@link gateCandidate}). Injectable for the Daytona wrapper — the gate runs in the sandbox. */
  gate?: Gate
}

/** One iteration's results-log entry. */
export type LoopEntry = {
  iteration: number
  candidate: Thread
  verifyStatus: string
  targetReached: boolean
  kept: boolean
  trace: Record<string, FrontierStateNode>
}

/** The full loop result. */
export type LoopResult = {
  iterations: LoopEntry[]
}

/**
 * Run the autoresearch loop: generate → gate → promote/discard → log.
 *
 * Up to `maxIterations` iterations, stop on first pass. Every iteration is
 * logged regardless of outcome.
 *
 * @param config - {@link LoopConfig}
 * @returns {@link LoopResult}
 *
 * @public
 */
export const runAutoresearchLoop = async ({
  currentThread,
  triggers,
  maxDepth,
  space,
  maxIterations,
  generator,
  promote,
  targetPredicate,
  gate = gateCandidate,
}: LoopConfig): Promise<LoopResult> => {
  const iterations: LoopEntry[] = []

  for (let i = 0; i < maxIterations; i++) {
    // 1. Read the current thread (the mutable surface).
    // 2. Generate a candidate (the generator sees the current thread).
    const candidate = await generator(currentThread)

    // 3. Gate the candidate.
    const gateResult = await gate({
      candidate,
      triggers,
      maxDepth,
      space,
      targetPredicate,
    })

    // 5. Append to the results log.
    iterations.push({
      iteration: i,
      candidate,
      verifyStatus: gateResult.verifyStatus,
      targetReached: gateResult.targetReached,
      kept: gateResult.kept,
      trace: gateResult.trace,
    })

    // 4. keep/discard.
    if (gateResult.kept) {
      // Promote: host-side commit.
      await promote(candidate)
      // Stop on first pass.
      break
    }
  }

  return { iterations }
}

// ---------------------------------------------------------------------------
// JSONL results log serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a loop result as JSONL — one line per iteration.
 *
 * Each line: `{ iteration, candidate, verifyStatus, targetReached, kept, trace }`.
 *
 * @param result - {@link LoopResult}
 * @returns JSONL string (newline-delimited JSON objects).
 *
 * @public
 */
export const serializeResultsLog = (result: LoopResult): string =>
  result.iterations
    .map((entry) =>
      JSON.stringify({
        iteration: entry.iteration,
        candidate: entry.candidate,
        verifyStatus: entry.verifyStatus,
        targetReached: entry.targetReached,
        kept: entry.kept,
        trace: entry.trace,
      }),
    )
    .join('\n')

// ---------------------------------------------------------------------------
// Model generator — model-respond via a provisioned endpoint
// ---------------------------------------------------------------------------

import type { ReasoningEffort } from '../workers/model.types.ts'
import type { InputItem, MessageItem, OutputItem } from '../workers/open-responses.schemas.ts'
import type { ModelRespondTool } from '../workers/use-model.ts'

/**
 * Configuration for {@link createModelGenerator}.
 */
export type ModelGeneratorConfig = {
  /** The provisioned model-respond tool (live or scripted). */
  modelRespond: ModelRespondTool
  /** Provider label (routes to the endpoint config). */
  provider: string
  /** Model ID at the provisioned endpoint. */
  modelId: string
  /** Instructions for the model. */
  instructions: string
  /** Reasoning effort level. Defaults to 'medium'. */
  reasoningEffort?: ReasoningEffort
}

/**
 * Extract text content from a model-respond output item (message item).
 *
 * @param items - The output items from modelRespond.
 * @returns The concatenated text from all message items, or null if none.
 */
const extractMessageText = (items: OutputItem[]): string | null => {
  const messages = items.filter((item): item is MessageItem => item.type === 'message')
  if (messages.length === 0) return null
  return messages
    .flatMap((msg) => msg.content)
    .filter((part): part is { type: 'output_text'; text: string } => part.type === 'output_text')
    .map((part) => part.text)
    .join('\n')
}

/**
 * Create a model-backed generator: sends the current thread to the model as
 * context, receives a candidate Thread (full replacement) as JSON, validates
 * it against the Thread schema, and returns it. A malformed response (parse
 * error or schema failure) returns a minimal safe Thread that the gate will
 * discard — never throws into the loop.
 *
 * @param config - {@link ModelGeneratorConfig}
 * @returns A {@link Generator} backed by model-respond.
 *
 * @public
 */
export const createModelGenerator = ({
  modelRespond,
  provider,
  modelId,
  instructions,
  reasoningEffort,
}: ModelGeneratorConfig): Generator => {
  const effort = reasoningEffort ?? 'medium'
  return async (currentThread: Thread): Promise<Thread> => {
    // Build the input: a user message describing the current thread and asking
    // for a full replacement Thread as JSON.
    const prompt = [
      `Current thread (JSON): ${JSON.stringify(currentThread)}`,
      'Generate an improved version as a full replacement Thread.',
      'Respond with ONLY a JSON object: { "label": string, "rules": [...], "once"?: true }',
      'Do not include markdown, explanations, or code fences — just the JSON object.',
    ].join('\n')

    const input: InputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: prompt,
      },
    ]

    const result = await modelRespond({
      provider,
      modelId,
      input,
      instructions,
      reasoningEffort: effort,
    })

    if ('isError' in result) {
      // Model error → return a minimal Thread the gate will discard.
      return { label: 'model-error', once: true, rules: [{ request: { type: 'turn.end' } }] }
    }

    const text = extractMessageText(result.items)
    if (!text) {
      return { label: 'model-empty', once: true, rules: [{ request: { type: 'turn.end' } }] }
    }

    // Parse the JSON. Strip any markdown fences if present.
    const cleaned = text
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      return { label: 'model-parse-error', once: true, rules: [{ request: { type: 'turn.end' } }] }
    }

    // Validate against the Thread schema.
    if (!validateThread(parsed)) {
      return { label: 'model-invalid-thread', once: true, rules: [{ request: { type: 'turn.end' } }] }
    }

    return parsed as Thread
  }
}

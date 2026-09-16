import { describe, expect, test } from 'bun:test'
import type { Thread } from '../../behavioral/behavioral.types.ts'
import {
  type GateInput,
  gateCandidate,
  type LoopConfig,
  progressiveDisclosureTargetPredicate,
  runAutoresearchLoop,
  serializeResultsLog,
} from '../autoresearch.ts'
import { PROGRESSIVE_DISCLOSURE_THREAD } from '../threads.ts'

/**
 * Autoresearch loop tests — the gate discrimination is the critical part.
 *
 * Gate contract (per Q8/A + Q8/F):
 * - Safety gate:   frontierVerify(candidate) → verified
 * - Usefulness gate: frontierExplore(candidate, {maxDepth}) → stateGraph has
 *   a node whose frontier matches the target predicate (some valid path
 *   reaches the goal). NOT strict same-trace replay.
 *
 * Tests:
 * 1. Baseline passes: unmodified progressive-disclosure thread → both gates pass.
 * 2. Broken variant fails: search step removed → safety may pass, usefulness fails.
 * 3. Differently-routed-but-valid passes: different path, same target → passes.
 * 4. Loop end-to-end (scripted generator): broken → corrected → promoted → logged.
 * 5. Model-generator contract: malformed model output → discarded without crash.
 */

const SPACE = 'autoresearch-test'

const GATE_TRIGGERS: GateInput['triggers'] = [
  { type: 'user.prompt', space: SPACE },
  { type: 'discovery.results', space: SPACE },
  { type: 'model.result', space: SPACE },
  { type: 'tool.loaded', space: SPACE },
  { type: 'turn.end', space: SPACE },
]

const BROKEN_THREAD: Thread = {
  label: 'progressive-disclosure-broken',
  once: true,
  rules: [
    { waitFor: [{ type: 'user.prompt' }] },
    { request: { type: 'model.respond' } },
    { waitFor: [{ type: 'model.result' }], interrupt: [{ type: 'turn.end' }] },
    { request: { type: 'skill.read' } },
    { waitFor: [{ type: 'tool.loaded' }], interrupt: [{ type: 'turn.end' }] },
    { request: { type: 'turn.end' } },
  ],
}

// Differently-routed-but-valid: swaps search and model order — model picks
// first, then searches, then loads, then terminates. Reaches the same target
// frontier via a different path. This is the key test: strict-replay would
// reject this (its trace doesn't match the reference), but the some-valid-path
// gate accepts it.
const DIFFERENTLY_ROUTED_THREAD: Thread = {
  label: 'progressive-disclosure-alt',
  once: true,
  rules: [
    { waitFor: [{ type: 'user.prompt' }] },
    { request: { type: 'model.respond' } },
    { waitFor: [{ type: 'model.result' }], interrupt: [{ type: 'turn.end' }] },
    { request: { type: 'discovery.search' } },
    { waitFor: [{ type: 'discovery.results' }], interrupt: [{ type: 'turn.end' }] },
    { request: { type: 'skill.read' } },
    { waitFor: [{ type: 'tool.loaded' }], interrupt: [{ type: 'turn.end' }] },
    { request: { type: 'turn.end' } },
  ],
}

describe('autoresearch gate — discrimination', () => {
  test('baseline passes: unmodified progressive-disclosure thread → both gates pass', async () => {
    const result = await gateCandidate({
      candidate: PROGRESSIVE_DISCLOSURE_THREAD,
      triggers: GATE_TRIGGERS,
      maxDepth: 20,
      space: SPACE,
    })
    expect(result.verifyStatus).toBe('verified')
    expect(result.targetReached).toBe(true)
    expect(result.kept).toBe(true)
  })

  test('broken variant fails: search step removed → usefulness gate fails (discard)', async () => {
    const result = await gateCandidate({
      candidate: BROKEN_THREAD,
      triggers: [
        { type: 'user.prompt', space: SPACE },
        { type: 'model.result', space: SPACE },
        { type: 'tool.loaded', space: SPACE },
        { type: 'turn.end', space: SPACE },
      ],
      maxDepth: 20,
      space: SPACE,
    })
    expect(result.verifyStatus).toBe('verified')
    expect(result.targetReached).toBe(false)
    expect(result.kept).toBe(false)
  })

  test('differently-routed-but-valid passes (the key test)', async () => {
    const result = await gateCandidate({
      candidate: DIFFERENTLY_ROUTED_THREAD,
      triggers: GATE_TRIGGERS,
      maxDepth: 30,
      space: SPACE,
    })
    expect(result.verifyStatus).toBe('verified')
    expect(result.targetReached).toBe(true)
    expect(result.kept).toBe(true)
  })
})

describe('autoresearch loop — end-to-end (scripted generator)', () => {
  test('broken → corrected → promoted → logged', async () => {
    // The scripted generator: on iteration 0, return the known correction
    // (the original progressive-disclosure thread). This simulates a model
    // that fixes the broken thread by restoring the search step.
    const scriptedGenerator = async (_current: Thread): Promise<Thread> => PROGRESSIVE_DISCLOSURE_THREAD

    // Promote callback: write the candidate to a temp file (host-side).
    const promoted: Thread[] = []
    const promote = async (candidate: Thread): Promise<void> => {
      promoted.push(candidate)
    }

    const config: LoopConfig = {
      currentThread: BROKEN_THREAD,
      triggers: GATE_TRIGGERS,
      maxDepth: 20,
      space: SPACE,
      maxIterations: 5,
      generator: scriptedGenerator,
      promote,
    }

    const result = await runAutoresearchLoop(config)

    // The loop should stop on first pass (iteration 0).
    expect(result.iterations).toHaveLength(1)
    expect(result.iterations[0]!.kept).toBe(true)
    expect(result.iterations[0]!.verifyStatus).toBe('verified')
    expect(result.iterations[0]!.targetReached).toBe(true)
    // The candidate was promoted.
    expect(promoted).toHaveLength(1)
    expect(promoted[0]!.label).toBe(PROGRESSIVE_DISCLOSURE_THREAD.label)
    // The results log is valid JSONL with required fields.
    for (const entry of result.iterations) {
      expect(entry).toHaveProperty('iteration')
      expect(entry).toHaveProperty('candidate')
      expect(entry).toHaveProperty('verifyStatus')
      expect(entry).toHaveProperty('targetReached')
      expect(entry).toHaveProperty('kept')
      expect(entry).toHaveProperty('trace')
    }
  })

  test('iteration cap honored — no pass within K → stops and logs all', async () => {
    // A generator that always produces a broken thread — never passes the gate.
    const alwaysBroken = async (_current: Thread): Promise<Thread> => BROKEN_THREAD
    const promote = async (): Promise<void> => {
      throw new Error('should not promote')
    }

    const config: LoopConfig = {
      currentThread: BROKEN_THREAD,
      triggers: [
        { type: 'user.prompt', space: SPACE },
        { type: 'model.result', space: SPACE },
        { type: 'tool.loaded', space: SPACE },
        { type: 'turn.end', space: SPACE },
      ],
      maxDepth: 20,
      space: SPACE,
      maxIterations: 3,
      generator: alwaysBroken,
      promote,
    }

    const result = await runAutoresearchLoop(config)
    expect(result.iterations).toHaveLength(3)
    for (const entry of result.iterations) {
      expect(entry.kept).toBe(false)
      expect(entry.targetReached).toBe(false)
    }
  })
})

describe('autoresearch loop — model-generator contract', () => {
  test('malformed model output (not a valid Thread) → discarded without crashing', async () => {
    // A generator that returns a malformed object (not a valid Thread).
    const malformedGenerator = async (_current: Thread): Promise<unknown> => ({
      label: 'malformed',
      // missing required 'rules' field
    })

    const config: LoopConfig = {
      currentThread: BROKEN_THREAD,
      triggers: GATE_TRIGGERS,
      maxDepth: 20,
      space: SPACE,
      maxIterations: 3,
      generator: malformedGenerator as () => Promise<Thread>,
      promote: async () => {},
    }

    const result = await runAutoresearchLoop(config)
    // All 3 iterations should be discarded (malformed → not a valid Thread).
    expect(result.iterations).toHaveLength(3)
    for (const entry of result.iterations) {
      expect(entry.kept).toBe(false)
      expect(entry.verifyStatus).toBe('rejected')
    }
  })
})

describe('progressive-disclosure target predicate', () => {
  test('is a function that takes a state graph and returns boolean', () => {
    expect(typeof progressiveDisclosureTargetPredicate).toBe('function')
  })
})

describe('autoresearch loop — JSONL results log', () => {
  test('serializeResultsLog produces valid JSONL with required fields per line', async () => {
    const scriptedGenerator = async (_current: Thread): Promise<Thread> => PROGRESSIVE_DISCLOSURE_THREAD
    const promote = async (): Promise<void> => {}

    const config: LoopConfig = {
      currentThread: BROKEN_THREAD,
      triggers: GATE_TRIGGERS,
      maxDepth: 20,
      space: SPACE,
      maxIterations: 3,
      generator: scriptedGenerator,
      promote,
    }

    const result = await runAutoresearchLoop(config)
    const jsonl = serializeResultsLog(result)
    const lines = jsonl.split('\n')

    expect(lines).toHaveLength(result.iterations.length)

    for (const [i, line] of lines.entries()) {
      const parsed = JSON.parse(line) as {
        iteration: number
        candidate: Thread
        verifyStatus: string
        targetReached: boolean
        kept: boolean
        trace: Record<string, unknown>
      }
      expect(parsed.iteration).toBe(i)
      expect(parsed.candidate).toBeDefined()
      expect(parsed.candidate.label).toBeDefined()
      expect(parsed.candidate.rules).toBeDefined()
      expect(parsed.verifyStatus).toBeDefined()
      expect(typeof parsed.targetReached).toBe('boolean')
      expect(typeof parsed.kept).toBe('boolean')
      expect(parsed.trace).toBeDefined()
      expect(typeof parsed.trace).toBe('object')
    }
  })

  test('serializeResultsLog with all-discarded iterations produces valid JSONL', async () => {
    const alwaysBroken = async (_current: Thread): Promise<Thread> => BROKEN_THREAD
    const config: LoopConfig = {
      currentThread: BROKEN_THREAD,
      triggers: [
        { type: 'user.prompt', space: SPACE },
        { type: 'model.result', space: SPACE },
        { type: 'tool.loaded', space: SPACE },
        { type: 'turn.end', space: SPACE },
      ],
      maxDepth: 20,
      space: SPACE,
      maxIterations: 2,
      generator: alwaysBroken,
      promote: async () => {},
    }

    const result = await runAutoresearchLoop(config)
    const jsonl = serializeResultsLog(result)
    const lines = jsonl.split('\n')

    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { kept: boolean; verifyStatus: string }
      expect(parsed.kept).toBe(false)
    }
  })
})

import { createScriptedModelTools } from '../../workers/use-model.ts'
import { createModelGenerator } from '../autoresearch.ts'

describe('autoresearch loop — model generator', () => {
  test('scripted model generator produces a valid candidate from model output', async () => {
    // Script the model to return the progressive-disclosure thread as JSON text.
    const candidateJson = JSON.stringify(PROGRESSIVE_DISCLOSURE_THREAD)
    const { modelRespond } = createScriptedModelTools({
      script: {
        items: [
          {
            id: 'msg_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: candidateJson }],
          },
        ],
        status: 'completed',
      },
    })

    const generator = createModelGenerator({
      modelRespond,
      provider: 'mock',
      modelId: 'mock-model',
      instructions: 'Generate an improved thread.',
    })

    const candidate = await generator(BROKEN_THREAD)
    expect(candidate.label).toBe(PROGRESSIVE_DISCLOSURE_THREAD.label)
    expect(candidate.rules).toHaveLength(PROGRESSIVE_DISCLOSURE_THREAD.rules.length)

    // The model-generated candidate passes the gate.
    const gateResult = await gateCandidate({
      candidate,
      triggers: GATE_TRIGGERS,
      maxDepth: 20,
      space: SPACE,
    })
    expect(gateResult.kept).toBe(true)
  })

  test('scripted model with markdown fences still produces valid candidate', async () => {
    const candidateJson = JSON.stringify(PROGRESSIVE_DISCLOSURE_THREAD)
    const { modelRespond } = createScriptedModelTools({
      script: {
        items: [
          {
            id: 'msg_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: `\`\`\`json\n${candidateJson}\n\`\`\`` }],
          },
        ],
        status: 'completed',
      },
    })

    const generator = createModelGenerator({
      modelRespond,
      provider: 'mock',
      modelId: 'mock-model',
      instructions: 'Generate an improved thread.',
    })

    const candidate = await generator(BROKEN_THREAD)
    expect(candidate.label).toBe(PROGRESSIVE_DISCLOSURE_THREAD.label)
  })

  test('model generator with error response → discarded (safe fallback)', async () => {
    const { modelRespond } = createScriptedModelTools({
      script: {
        items: [],
        status: 'failed',
      },
    })

    const generator = createModelGenerator({
      modelRespond,
      provider: 'mock',
      modelId: 'mock-model',
      instructions: 'Generate an improved thread.',
    })

    const candidate = await generator(BROKEN_THREAD)
    // Empty items → the generator returns a safe fallback Thread.
    expect(candidate.label).toBe('model-empty')
    // The gate discards it (rules: [] is not a valid progressive-disclosure thread).
    const gateResult = await gateCandidate({
      candidate,
      triggers: GATE_TRIGGERS,
      maxDepth: 20,
      space: SPACE,
    })
    expect(gateResult.kept).toBe(false)
  })

  test('model generator with malformed JSON → discarded (safe fallback)', async () => {
    const { modelRespond } = createScriptedModelTools({
      script: {
        items: [
          {
            id: 'msg_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'this is not json {{{' }],
          },
        ],
        status: 'completed',
      },
    })

    const generator = createModelGenerator({
      modelRespond,
      provider: 'mock',
      modelId: 'mock-model',
      instructions: 'Generate an improved thread.',
    })

    const candidate = await generator(BROKEN_THREAD)
    expect(candidate.label).toBe('model-parse-error')

    const gateResult = await gateCandidate({
      candidate,
      triggers: GATE_TRIGGERS,
      maxDepth: 20,
      space: SPACE,
    })
    expect(gateResult.kept).toBe(false)
  })
})

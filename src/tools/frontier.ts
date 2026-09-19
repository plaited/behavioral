/**
 * Behavioral frontier analysis utilities for replaying, exploring, and verifying
 * behavioral thread frontiers.
 *
 * @remarks
 * These functions work with in-memory {@link Thread} arrays so extensions and agents
 * can analyze behavioral programs without file-IO or a running BP engine.
 *
 * ## Entry points
 *
 * - {@link frontierReplay} — replay one concrete event-selection trace
 * - {@link frontierExplore} — enumerate reachable histories, find deadlocks
 * - {@link frontierVerify} — derive a pass/fail/truncated status from exploration
 *
 * The raw algorithm functions (`replayToFrontierRaw`, `exploreFrontiersRaw`,
 * `verifyFrontiersRaw`) and the graph internals are module-private; the tools
 * above are the public surface.
 *
 * ## Trace kind filters
 *
 * Frontier tools discriminate {@link Trace} messages by their `kind`
 * field (values from {@link TRACE_MESSAGE_KINDS}). The three kinds they
 * filter on:
 *
 * - {@link SelectionTrace} — a concrete event selection
 * - {@link FrontierTrace} — the frontier at a step
 * - {@link DeadlockTrace} — a deadlock at a step
 *
 * @packageDocumentation
 */

import type { JSONSchemaType } from 'ajv'
import { FRONTIER_STATUS, TRACE_MESSAGE_KINDS } from '../behavioral/behavioral.constants.ts'
import type {
  BPEvent,
  CandidateBid,
  Frontier,
  FrontierTrace,
  PendingBid,
  RegisteredBPListener,
  RegisteredIdioms,
  RegisteredTransformListener,
  ReplayToFrontierResult,
  RunningBid,
  SelectionTrace,
  Thread,
  Trace,
} from '../behavioral/behavioral.types.ts'
import { BPEventSchema } from '../behavioral/behavioral.types.ts'
import {
  advanceRunningToPending,
  computeFrontier,
  generateRulesFunctions,
  isListeningFor,
  resumePendingThreadsForSelectedEvent,
  useThread,
} from '../behavioral/behavioral.utils.ts'
import { ueid } from '../utils.ts'
import { defineTool } from './define-tool.ts'

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const countSelectionTraces = ({ messages }: { messages: Trace[] }) =>
  messages.reduce((count, msg) => count + (msg.kind === 'selection' ? 1 : 0), 0)

const createFrontierTrace = ({
  frontier,
  step,
  instanceId,
}: {
  frontier: Frontier
  step: number
  instanceId: string
}): FrontierTrace => ({
  kind: 'frontier',
  timestamp: Date.now(),
  instanceId,
  step,
  status: frontier.status,
  candidates: frontier.candidates.map((candidate) => ({
    priority: candidate.priority,
    type: candidate.type,
    ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
    ...(candidate.ingress === undefined ? {} : { ingress: candidate.ingress }),
    ...(candidate.space === undefined ? {} : { space: candidate.space }),
  })),
  enabled: frontier.enabled.map((candidate) => ({
    priority: candidate.priority,
    type: candidate.type,
    ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
    ...(candidate.ingress === undefined ? {} : { ingress: candidate.ingress }),
    ...(candidate.space === undefined ? {} : { space: candidate.space }),
  })),
})

const createSelectionTrace = ({
  selected,
  step,
  instanceId,
}: {
  selected: CandidateBid
  step: number
  instanceId: string
}): SelectionTrace => ({
  kind: TRACE_MESSAGE_KINDS.selection,
  timestamp: Date.now(),
  instanceId,
  step,
  selected,
})

const createDeadlockTrace = ({ step, instanceId }: { step: number; instanceId: string }): Trace => ({
  kind: TRACE_MESSAGE_KINDS.deadlock,
  timestamp: Date.now(),
  instanceId,
  step,
})

const matchesSelectedEvent = ({ candidate, selected }: { candidate: CandidateBid; selected: CandidateBid }) =>
  candidate.type === selected.type &&
  candidate.space === selected.space &&
  Bun.deepEquals(candidate.detail, selected.detail)

/**
 * @internal
 * Add a synthetic once-thread requesting the selected event so replay can
 * match it. With `ingress: true` this reconstructs an external trigger
 * admission; omitting it reconstructs an internal re-entry — the bridge or
 * transform-daemon once-thread that is not part of the candidate thread set.
 */
const addSyntheticRequestThread = ({
  pending,
  selected,
  ingress,
}: {
  pending: Set<PendingBid>
  selected: CandidateBid
  ingress?: true
}) => {
  const triggerThread = function* () {
    yield {
      request: {
        type: selected.type,
        ...(selected.detail === undefined ? {} : { detail: selected.detail }),
        ...(selected.space === undefined ? {} : { space: selected.space }),
      },
    }
  }
  const generator = triggerThread()
  const yielded = generator.next()

  if (!yielded.done) {
    pending.add({
      priority: 0,
      generator,
      ...(ingress === true ? { ingress: true as const } : {}),
      label: selected.type,
      ...yielded.value,
    })
  }
}

/**
 * @internal
 * Whether a selected event is consumed by a pending bid's wait/interrupt/
 * transform listener. A request-origin selection that is not enabled by the
 * candidate set is reconstructed as an internal re-entry only when some
 * pending bid actually consumes it; otherwise the selection is invalid.
 */
const pendingBidConsumes = ({ pendingBid, selected }: { pendingBid: PendingBid; selected: CandidateBid }) => {
  const listeners = [...(pendingBid.waitFor ?? []), ...(pendingBid.interrupt ?? []), ...(pendingBid.transform ?? [])]
  return listeners.some(isListeningFor(selected))
}

const getSelectedEvents = ({ messages }: { messages: Trace[] }) =>
  messages.flatMap((msg) => (msg.kind === TRACE_MESSAGE_KINDS.selection ? [msg.selected] : []))

/**
 * Compiles an array of {@link Thread} tuples into the generator representations
 * needed by the frontier engine.
 *
 * @param threads - Thread tuples authored as `['label', { rules, once? }]`.
 * @param space - Optional space stamp to pass into {@link generateRulesFunctions}.
 * @returns Compiled entries each with the authored `label` and a started generator.
 */
const compileThreads = (
  threads: Thread[],
  space?: string,
): Array<{ label: string; generator: IterableIterator<RegisteredIdioms> }> =>
  threads.map(({ label, rules, once }) => ({
    label,
    generator: useThread(generateRulesFunctions(rules, space), once)(),
  }))

/**
 * One explored history: trace messages including the final frontier.
 *
 * @public
 */
type TraceRecord = {
  messages: Trace[]
}

/**
 * A deadlock finding discovered during exploration.
 *
 * @public
 */
type DeadlockFinding = {
  code: 'deadlock'
  messages: Trace[]
}

/**
 * Replays a concrete sequence of selection trace messages against a thread
 * set and returns the resulting frontier.
 *
 * @param args.threads - Thread tuples to replay.
 * @param args.messages - Selection trace to replay. Each selection is
 *   checked for enablement at the corresponding step.
 * @param args.space - Optional space stamp applied to all thread rules.
 * @param args.instanceId - Instance id stamped on synthetic interrupt/transform
 *   traces emitted during resumption. Defaults to a minted `ueid('bp_')`.
 * @returns The replay result containing the pending set and final frontier.
 *
 * @throws If a selection event is not enabled at its replay step.
 *
 * @public
 */
const replayToFrontierRaw = ({
  threads,
  messages = [],
  space,
  instanceId = ueid('bp_'),
}: {
  threads: Thread[]
  messages?: Trace[]
  space?: string
  instanceId?: string
}): ReplayToFrontierResult => {
  const pending = new Set<PendingBid>()
  const running = new Set<RunningBid>()

  const entries = compileThreads(threads, space)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    running.add({
      priority: i + 1,
      generator: entry.generator,
      label: entry.label,
    })
  }

  advanceRunningToPending(running, pending)

  for (const [step, selected] of getSelectedEvents({ messages }).entries()) {
    if (selected.ingress === true) {
      addSyntheticRequestThread({ pending, selected, ingress: true })
    }

    const findMatch = () =>
      [...computeFrontier(pending).enabled]
        .sort((left, right) => left.priority - right.priority)
        .find((candidate) => matchesSelectedEvent({ candidate, selected }))

    let matched = findMatch()
    if (
      !matched &&
      selected.ingress !== true &&
      [...pending].some((pendingBid) => pendingBidConsumes({ pendingBid, selected }))
    ) {
      // Request-origin re-entry whose producer (bridge/transform daemon) is a
      // harness thread absent from the candidate set: reconstruct the
      // once-thread it added and retry the enablement check.
      addSyntheticRequestThread({ pending, selected })
      matched = findMatch()
    }

    if (!matched) {
      throw new Error(`Selected event "${selected.type}" was not enabled at replay step ${step}.`)
    }

    const resumed = new Set<RunningBid>()
    resumePendingThreadsForSelectedEvent({
      running: resumed,
      pending,
      selectedEvent: matched,
      instanceId,
      step,
    })
    advanceRunningToPending(resumed, pending)
  }

  return {
    pending,
    frontier: computeFrontier(pending),
  }
}

/**
 * @internal
 * How a trigger event would affect a pending bid, split by provenance channel.
 *
 * External admission (`ingress: true`) wakes listeners with `ingressMatch`
 * absent or `true`; internal re-entry (request-origin, `ingress` absent) wakes
 * listeners with `ingressMatch` absent or `false`. A bid's own matching
 * `request` is channel-independent. `requestOnly` flags that some listener is
 * exclusively internal, so an external admission alone would leave it parked.
 */
const triggerChannelMatch = ({ pendingBid, trigger }: { pendingBid: PendingBid; trigger: BPEvent }) => {
  if (pendingBid.ingress === true) {
    return { external: false, request: false, requestOnly: false }
  }

  const base = {
    priority: 0,
    type: trigger.type,
    ...(trigger.detail === undefined ? {} : { detail: trigger.detail }),
    ...(trigger.space === undefined ? {} : { space: trigger.space }),
  }
  const externalCandidate: CandidateBid = { ...base, ingress: true }
  const requestCandidate: CandidateBid = base
  const listeners = [...(pendingBid.waitFor ?? []), ...(pendingBid.interrupt ?? []), ...(pendingBid.transform ?? [])]
  const matches = (candidate: CandidateBid) => listeners.some(isListeningFor(candidate))
  const requestMatches =
    pendingBid.request !== undefined &&
    pendingBid.request.type === trigger.type &&
    pendingBid.request.space === trigger.space &&
    Bun.deepEquals(pendingBid.request.detail, trigger.detail)

  return {
    external: requestMatches || matches(externalCandidate),
    request: matches(requestCandidate),
    requestOnly: listeners.some((listener) => listener.ingressMatch === false),
  }
}

const getRequestSuccessors = ({
  frontier,
  selectionPolicy,
  step,
  instanceId,
}: {
  frontier: Frontier
  selectionPolicy: 'all-enabled' | 'scheduler'
  step: number
  instanceId: string
}) => {
  if (frontier.status !== FRONTIER_STATUS.ready) {
    return []
  }

  const enabled =
    selectionPolicy === 'scheduler'
      ? [...frontier.enabled].sort((left, right) => left.priority - right.priority).slice(0, 1)
      : frontier.enabled

  return enabled.map((candidate) => createSelectionTrace({ selected: candidate, step, instanceId }))
}

const getTriggerSuccessors = ({
  pending,
  messages,
  threads,
  step,
  triggers,
  space,
  instanceId,
}: {
  pending: Set<PendingBid>
  messages: Trace[]
  threads: Thread[]
  step: number
  triggers: BPEvent[]
  space?: string
  instanceId: string
}) => {
  const successors: SelectionTrace[] = []

  for (const trigger of triggers) {
    let external = false
    let request = false
    let requestOnly = false
    for (const pendingBid of pending) {
      const match = triggerChannelMatch({ pendingBid, trigger })
      external ||= match.external
      request ||= match.request
      requestOnly ||= match.requestOnly
    }

    // External admission first (backward compatible). A request-origin
    // successor is added only when needed: when no external listener matched,
    // or when an `ingressMatch: false` listener would otherwise stay parked.
    const channels: (true | undefined)[] = []
    if (external) channels.push(true)
    if (request && (requestOnly || !external)) channels.push(undefined)

    for (const ingress of channels) {
      const selection = createSelectionTrace({
        step,
        instanceId,
        selected: {
          priority: 0,
          type: trigger.type,
          ...(trigger.detail === undefined ? {} : { detail: trigger.detail }),
          ...(trigger.space === undefined ? {} : { space: trigger.space }),
          ...(ingress === true ? { ingress: true as const } : {}),
        },
      })

      try {
        replayToFrontierRaw({
          threads,
          messages: [...messages, selection],
          space,
          instanceId,
        })
        successors.push(selection)
      } catch {
        // selection not valid for this frontier — skip
      }
    }
  }

  return successors
}

/**
 * @internal
 * Canonicalizes a listener set into a content-sorted array of JSON strings.
 *
 * Each listener (`waitFor`/`block`/`interrupt`/`transform`) is projected to its
 * JSON-only form — the zod `detailSchema` instance is converted to JSON Schema
 * — and serialized. The resulting strings are sorted so two listener sets that
 * differ only by declaration order produce the same array. This is what lets
 * {@link frontierStateKey} treat structurally-equal pending sets as the same
 * state.
 *
 * @param listener - Listeners to canonicalize.
 * @returns A sorted array of JSON strings, one per projected listener.
 */
const normalizeListeners = (listener: RegisteredBPListener[] | RegisteredTransformListener[]) =>
  // Raw-JSON-Schema listeners serialize without conversion.
  listener.map((l) => JSON.stringify(l)).sort()

/**
 * Derive a canonical string key for a BP pending set.
 *
 * Two pending sets collapse to the same key when they are structurally
 * identical — same threads parked at the same sync points, yielding the same
 * idioms with the same constraints — regardless of bid insertion order or the
 * identity of the underlying generator closures. This is the abstraction that
 * lets `exploreFrontiersRaw` close the state graph for looping programs instead
 * of chasing ever-growing traces.
 *
 * @remarks
 * - Drops instance-identity and non-serializable artifacts: the `generator`
 *   closure and each listener's zod `detailSchema` instance (serialized to
 *   JSON Schema in its place).
 * - `request` is projected to `{ type, detail, space }`. Bid order and listener
 *   order are canonicalized by sorting on serialized content, yielding a total
 *   order independent of input order.
 *
 * MINIMAL: relies on object-key insertion order being stable across paths
 * (true while `advanceRunningToPending` constructs bids consistently). A
 * reordered-keys `detail`/`detailSchema` would produce a different key for a
 * semantically-equal state. Upgrade path: swap `JSON.stringify` for a
 * recursive canonical-JSON serializer (an in-progress `canonicalJsonStringify`
 * is referenced by `src/utils/tests/canonical-json.spec.ts`).
 *
 * @param pending - The pending bid set to canonicalize.
 * @returns A stable string key; equal keys imply structurally-equal states.
 *
 * @public
 */
const frontierStateKey = ({ pending }: { pending: Set<PendingBid> }): string =>
  JSON.stringify(
    [...pending]
      .map(({ waitFor, block, interrupt, request, transform, generator: _gen, ...rest }) =>
        JSON.stringify({
          ...rest,
          // request is field-picked to { type, detail, space } so non-trace
          // fields never enter the state key (frontier invariant).
          ...(request && {
            request: {
              space: request.space,
              type: request.type,
              ...(request.detail === undefined ? {} : { detail: request.detail }),
            },
          }),
          ...(waitFor && { waitFor: normalizeListeners(waitFor) }),
          ...(block && { block: normalizeListeners(block) }),
          ...(interrupt && { interrupt: normalizeListeners(interrupt) }),
          ...(transform && { transform: normalizeListeners(transform) }),
        }),
      )
      .sort(),
  )

type StateNode = {
  stateKey: string
  /** The frontier at this state; Step 3 reads enabled/candidates here. */
  frontier: Frontier
  /** Selection depth at first discovery (BFS-shortest under bfs; arbitrary under dfs). */
  step: number
  /** Labeled outgoing edges: the event selected to reach each successor state. */
  successors: Array<{ selection: CandidateBid; to: string }>
}

/**
 * An SCC is a cycle iff it has more than one node, or a single node with a
 * self-edge. Single-node SCCs without a self-edge are DAG leaves, not cycles.
 *
 * @param scc - One strongly connected component (array of state keys).
 * @param graph - The graph the SCC came from, used to detect self-edges.
 * @returns `true` when the SCC represents a reachable cycle.
 *
 * @public
 */
const isCycle = (scc: string[], graph: Map<string, StateNode>): boolean =>
  scc.length > 1 || (scc.length === 1 && graph.get(scc[0]!)!.successors.some((e) => e.to === scc[0]!))

/**
 * Partition a labeled state graph into its strongly connected components via
 * iterative Tarjan.
 *
 * Returns EVERY SCC, including trivial single-node components that are not
 * cycles (a DAG yields one trivial SCC per node). Cycle interpretation is a
 * separate concern handled by {@link isCycle}; this finder deliberately does
 * not filter, so callers can inspect raw component structure and so the SCC
 * algorithm stays independently testable.
 *
 * @remarks
 * Iterative (explicit work stack) rather than recursive, so a large single
 * cycle does not overflow the JS stack. Depends only on node adjacency
 * (`successors: Array<{ to }>`), so it accepts the state graph built by
 * `exploreFrontiersRaw` as well as hand-constructed fake graphs for testing.
 *
 * @param graph - Graph keyed by state key; each node carries its successor edges.
 * @returns One array per SCC, each containing the state keys in that component.
 *
 * @public
 */
const findStronglyConnectedComponents = (graph: Map<string, StateNode>): string[][] => {
  let index = 0
  const indices = new Map<string, number>()
  const lowlinks = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  const work: { node: string; cursor: number }[] = [] // explicit recursion stack

  for (const root of graph.keys()) {
    if (indices.has(root)) continue // already processed by an earlier DFS

    // DISCOVER root: assign index, lowlink, push onto SCC stack, push work frame
    indices.set(root, index)
    lowlinks.set(root, index)
    onStack.add(root)
    stack.push(root)
    work.push({ node: root, cursor: 0 })

    index++
    while (work.length > 0) {
      const frame = work[work.length - 1]! // peek, don't pop yet
      const succ = graph.get(frame.node)!.successors

      if (frame.cursor < succ.length) {
        const w = succ[frame.cursor]!.to
        frame.cursor++

        if (!indices.has(w)) {
          // Case 1: descend. (cursor already advanced)
          indices.set(w, index)
          lowlinks.set(w, index)
          index++
          onStack.add(w)
          stack.push(w)
          work.push({ node: w, cursor: 0 })
        } else if (onStack.has(w)) {
          // Case 2: back-edge to an ancestor — use INDEX (this rule is now only
          // ever reached for genuine back-edges, never for child-returns, because
          // child-returns no longer revisit the edge).
          lowlinks.set(frame.node, Math.min(lowlinks.get(frame.node)!, indices.get(w)!))
        }
        continue
      }

      // CURSOR EXHAUSTED
      if (lowlinks.get(frame.node) === indices.get(frame.node)) {
        const scc: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          scc.push(w)
        } while (w !== frame.node)
        sccs.push(scc)
      }
      work.pop()

      // ← CHILD-RETURN PROPAGATION: the frame we just popped is a child of the new
      // top frame. Propagate the child's LOWLINK (not its index) into the parent.
      if (work.length > 0) {
        const parent = work[work.length - 1]!
        lowlinks.set(parent.node, Math.min(lowlinks.get(parent.node)!, lowlinks.get(frame.node)!))
      }
    }
  }
  return sccs
}

/**
 * A livelock finding: a reachable cycle in which no progress event is ever
 * selected. The program can spin forever inside the cycle without
 * accomplishing anything the caller declared meaningful.
 *
 * @remarks
 * `states` is the set of state keys in the cycle (a strongly connected
 * component). `progressTypes` records the caller-supplied progress set, so a
 * consumer replaying or reporting the finding knows what was being checked.
 *
 * @public
 */
type LivelockFinding = {
  code: 'livelock'
  states: string[]
  progressTypes: string[]
}

/**
 * Detect livelocks in a labeled state graph.
 *
 * A livelock is a cycle (per {@link isCycle}) in which no edge is labeled by a
 * progress event. "Progress" is whatever the caller declares meaningful — this
 * is the specification pillar: the caller supplies the property, and this
 * function checks that every reachable cycle selects at least one progress
 * event. A cycle that never does can spin forever without accomplishing
 * anything.
 *
 * @remarks
 * Only edges whose endpoints both lie in the SCC count toward progress — an
 * edge that *leaves* the cycle is an escape, not progress made *inside* the
 * cycle, and is not credited. This is the non-obvious correctness condition:
 * escapes don't redeem a livelock.
 *
 * `sccs` is expected to come from {@link findStronglyConnectedComponents} over
 * the same `graph`.
 *
 * @param args.graph - The labeled state graph (as built by `exploreFrontiersRaw`).
 * @param args.sccs - Strongly connected components of `graph`.
 * @param args.progress - Event types that count as progress (the specification).
 * @returns One {@link LivelockFinding} per cycle that never selects a progress event.
 *
 * @public
 */
const findLivelocks = ({
  graph,
  sccs,
  progress,
}: {
  graph: Map<string, StateNode>
  sccs: string[][]
  progress: string[]
}): LivelockFinding[] => {
  const findings: LivelockFinding[] = []
  for (const scc of sccs) {
    if (!isCycle(scc, graph)) continue
    const stateKeys = new Set<string>(scc)
    const cycleEventTypes = new Set<string>()
    for (const stateKey of scc) {
      const node = graph.get(stateKey)!
      for (const edge of node.successors) {
        if (stateKeys.has(edge.to)) {
          cycleEventTypes.add(edge.selection.type)
        }
      }
    }
    const makesProgress = [...cycleEventTypes].some((t) => progress.includes(t))
    if (!makesProgress) {
      findings.push({
        code: 'livelock',
        states: [...scc],
        progressTypes: [...progress],
      })
    }
  }
  return findings
}

/**
 * Arguments for {@link exploreFrontiersRaw} and {@link verifyFrontiersRaw}.
 *
 * @public
 */
type ExploreFrontiersArgs = {
  /** Thread tuples to analyze. */
  threads: Thread[]
  /** Prior trace prefix to replay before exploring. */
  messages?: Trace[]
  /** External trigger events that may wake pending threads. */
  triggers?: BPEvent[]
  /** Exploration strategy: `'bfs'` (breadth-first) or `'dfs'` (depth-first). Default: `'bfs'`. */
  strategy?: 'bfs' | 'dfs'
  /** How to select among enabled candidates: `'all-enabled'` (all branches) or `'scheduler'` (priority order, one at a time). Default: `'all-enabled'`. */
  selectionPolicy?: 'all-enabled' | 'scheduler'
  /** Maximum selection depth before truncating exploration. */
  maxDepth?: number
  /** Space stamp applied to all thread rules. */
  space?: string
  /** Instance id stamped on synthetic traces. Defaults to a minted `ueid('bp_')` — pass the analyzed kernel's id to make joins natural. */
  instanceId?: string
}

/**
 * Result of an {@link exploreFrontiersRaw} call.
 *
 * @public
 */
type ExploreFrontiersResult = {
  traces: TraceRecord[]
  findings: DeadlockFinding[]
  report: {
    strategy: 'bfs' | 'dfs'
    selectionPolicy: 'all-enabled' | 'scheduler'
    visitedCount: number
    findingCount: number
    truncated: boolean
    maxDepth?: number
  }
  stateGraph: Map<string, StateNode>
}

type WorkItem = {
  messages: Trace[] // what you already push
  from?: string // stateKey of the state this item was pushed FROM
  via?: CandidateBid // the selection that was appended to get here
}

/**
 * Explores reachable frontiers from an initial trace prefix, collecting
 * traces and deadlock findings.
 *
 * @param args - {@link ExploreFrontiersArgs}
 * @returns {@link ExploreFrontiersResult}
 *
 * @public
 */
const exploreFrontiersRaw = ({
  threads,
  messages = [],
  triggers = [],
  strategy = 'bfs',
  selectionPolicy = 'all-enabled',
  maxDepth,
  space,
  instanceId = ueid('bp_'),
}: ExploreFrontiersArgs): ExploreFrontiersResult => {
  if (strategy !== 'bfs' && strategy !== 'dfs') {
    throw new Error(`Unsupported frontier exploration strategy "${String(strategy)}".`)
  }

  const pending: WorkItem[] = [{ messages }]
  const visited = new Set<string>()
  const stateGraph = new Map<string, StateNode>()
  const traces: TraceRecord[] = []
  const findings: DeadlockFinding[] = []
  let truncated = false

  while (pending.length > 0) {
    const current = strategy === 'bfs' ? pending.shift()! : pending.pop()!
    const { frontier, pending: currentPending } = replayToFrontierRaw({
      threads,
      messages: current.messages,
      space,
      instanceId,
    })

    const stateKey = frontierStateKey({ pending: currentPending })

    if (current.from !== undefined && current.via !== undefined) {
      const parent = stateGraph.get(current.from)
      if (parent) {
        parent.successors.push({ selection: current.via, to: stateKey })
      }
    }

    if (visited.has(stateKey)) continue
    visited.add(stateKey)
    const step = countSelectionTraces({ messages: current.messages })

    stateGraph.set(stateKey, {
      stateKey,
      frontier,
      step,
      successors: [],
    })

    const frontierTrace = createFrontierTrace({ frontier, step, instanceId })

    traces.push({
      messages: [...current.messages, frontierTrace],
    })

    const requestSuccessors = getRequestSuccessors({
      frontier,
      selectionPolicy,
      step,
      instanceId,
    })
    const triggerSuccessors = getTriggerSuccessors({
      pending: currentPending,
      messages: current.messages,
      threads,
      step,
      triggers,
      space,
      instanceId,
    })
    const successors = [...requestSuccessors, ...triggerSuccessors]

    if (frontier.status === FRONTIER_STATUS.deadlock && triggerSuccessors.length === 0) {
      findings.push({
        code: 'deadlock',
        messages: [...current.messages, frontierTrace, createDeadlockTrace({ step, instanceId })],
      })
    }

    if (maxDepth !== undefined && step >= maxDepth) {
      if (successors.length > 0) {
        truncated = true
      }
      continue
    }

    for (const successor of successors) {
      pending.push({
        messages: [...current.messages, successor],
        from: stateKey,
        via: successor.selected,
      })
    }
  }

  return {
    traces,
    findings,
    report: {
      strategy,
      selectionPolicy,
      visitedCount: traces.length,
      findingCount: findings.length,
      truncated,
      ...(maxDepth === undefined ? {} : { maxDepth }),
    },
    stateGraph,
  }
}

/**
 * Result of a {@link verifyFrontiersRaw} call.
 *
 * @public
 */
type VerifyFrontiersResult = {
  status: 'verified' | 'failed' | 'truncated'
  findings: DeadlockFinding[]
  report: ExploreFrontiersResult['report']
  livelocks: LivelockFinding[]
}

type VerifyFrontiersArgs = ExploreFrontiersArgs & { progress?: string[] }

/**
 * Verifies a thread set by exploring its frontiers and deriving a
 * pass/fail/truncated status.
 *
 * @param args - {@link ExploreFrontiersArgs}
 * @returns {@link VerifyFrontiersResult}
 *
 * @public
 */
const verifyFrontiersRaw = ({ progress, ...args }: VerifyFrontiersArgs): VerifyFrontiersResult => {
  const { findings, report, stateGraph } = exploreFrontiersRaw(args)
  const livelocks: LivelockFinding[] = []
  if (progress !== undefined) {
    livelocks.push(
      ...findLivelocks({
        progress,
        graph: stateGraph,
        sccs: findStronglyConnectedComponents(stateGraph),
      }),
    )
  }
  if (findings.length > 0 || livelocks.length > 0) {
    return {
      status: 'failed',
      findings,
      report,
      livelocks,
    }
  }

  if (report.truncated) {
    return {
      status: 'truncated',
      findings,
      report,
      livelocks,
    }
  }

  return {
    status: 'verified',
    findings,
    report,
    livelocks,
  }
}

// ---------------------------------------------------------------------------
// defineTool wrappers — the public interface
// ---------------------------------------------------------------------------
//
// The interface IS the tool. The raw algorithm functions above
// (replayToFrontierRaw, exploreFrontiersRaw, verifyFrontiersRaw) and every
// graph internal (frontierStateKey, findStronglyConnectedComponents,
// findLivelocks, isCycle, StateNode, the *Args/*Result/*Finding/*Record types)
// are the implementation; the three tools below are the only public surface.

/**
 * Serialized {@link Frontier} for JSON output. CandidateBid is JSON-safe
 * (priority/type/detail/space — no generator or compiled validator), so the
 * frontier crosses the boundary verbatim.
 */
const frontierJsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'deadlock', 'idle'] },
    candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
    enabled: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['status', 'candidates', 'enabled'],
  additionalProperties: false,
} as const

// threads — structural (label + rules); idiom internals permissive so a
// caller's detailSchema (JSON Schema) reaches the runtime validator verbatim
// (generateRulesFunctions compiles it). The permissive idiom items can't be
// statically verified for JSONSchemaType<Idioms>, so the sub-schema is cast
// through `unknown` below — same pattern read.ts uses for Zod-derived
// sub-schemas. AJV validates the structural shape at runtime.
const threadsJsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      label: { type: 'string', minLength: 1 },
      once: { type: 'boolean', enum: [true], nullable: true },
      rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    required: ['label', 'rules'],
    additionalProperties: false,
  },
} as const

// messages — a selection-trace prefix. Validated as array-of-object; the
// runtime discriminates by `kind` and reads `selected`. CandidateBid's
// `ingress?: true` literal exceeds JSONSchemaType's static power.
const messagesJsonSchema = {
  type: 'array',
  items: { type: 'object', additionalProperties: true },
  description: 'selection-trace prefix: { kind: "selection", timestamp, instanceId, step, selected: CandidateBid }[]',
} as const

export type FrontierReplayInput = {
  threads: Thread[]
  messages?: SelectionTrace[]
  space?: string
  instanceId?: string
}

export type FrontierReplayOutput = {
  frontier: Frontier | null
  stateKey: string | null
  pendingCount: number | null
  isError?: boolean
  message?: string
}

export const FrontierReplayInputSchema = {
  type: 'object',
  properties: {
    threads: threadsJsonSchema,
    messages: { ...messagesJsonSchema, nullable: true },
    space: { type: 'string', nullable: true, description: 'space stamp applied to all thread rules' },
    instanceId: {
      type: 'string',
      nullable: true,
      description: 'instance id stamped on synthetic traces; defaults to a minted ueid("bp_")',
    },
  },
  required: ['threads'],
  additionalProperties: false,
  description: 'Replay one concrete event-selection trace against a thread set and return the resulting frontier.',
} as unknown as JSONSchemaType<FrontierReplayInput>

export const FrontierReplayOutputSchema = {
  type: 'object',
  properties: {
    frontier: { ...frontierJsonSchema, nullable: true, description: 'the resulting frontier; null on error' },
    stateKey: { type: 'string', nullable: true, description: 'canonical state key for the pending set; null on error' },
    pendingCount: { type: 'integer', nullable: true, description: 'count of pending bids; null on error' },
    isError: {
      type: 'boolean',
      nullable: true,
      description: 'true when a selection was not enabled at its replay step',
    },
    message: { type: 'string', nullable: true, description: 'error detail when isError' },
  },
  required: ['frontier', 'stateKey', 'pendingCount'],
  additionalProperties: false,
} as unknown as JSONSchemaType<FrontierReplayOutput>

/**
 * Replay one concrete event-selection trace and return the resulting frontier.
 *
 * Wraps the raw replay: the pending `Set` (with generator closures) is
 * serialized to `stateKey` (canonical) + `pendingCount`; the frontier crosses
 * verbatim. If a selection was not enabled at its replay step the raw fn
 * throws — the tool catches it and returns `{ isError: true, message }` so the
 * throw never crosses the model channel.
 */
export const frontierReplay = defineTool(
  {
    name: 'frontier-replay',
    description:
      'Replay one concrete event-selection trace against a thread set and return the resulting frontier, the canonical pending-state key, and the pending-bid count. Use to inspect a known event sequence and prove it was valid — a disabled selection returns isError instead of throwing.',
    inputSchema: FrontierReplayInputSchema,
    outputSchema: FrontierReplayOutputSchema,
  },
  ({ threads, messages, space, instanceId }) => {
    try {
      const { pending, frontier } = replayToFrontierRaw({ threads, messages, space, instanceId })
      return {
        frontier,
        stateKey: frontierStateKey({ pending }),
        pendingCount: pending.size,
      }
    } catch (err) {
      return {
        frontier: null,
        stateKey: null,
        pendingCount: null,
        isError: true,
        message: (err as Error).message,
      }
    }
  },
)

// Serialized reachable state in the explored graph. StateNode (module-private)
// has the identical shape; this is the JSON-public mirror so consumers don't
// depend on an internal type. StateNode fields are JSON-safe (stateKey, the
// frontier, step, and successor edges labeled by CandidateBid — no generator
// or compiled validator).
export type FrontierStateNode = {
  stateKey: string
  frontier: Frontier
  step: number
  successors: Array<{ selection: CandidateBid; to: string }>
}

// Exploration report — shared by the frontier-explore and frontier-verify
// outputs.
export type FrontierReport = {
  strategy: 'bfs' | 'dfs'
  selectionPolicy: 'all-enabled' | 'scheduler'
  visitedCount: number
  findingCount: number
  truncated: boolean
  maxDepth?: number
}

// Serialize the internal Map<string, StateNode> to a plain object keyed by
// stateKey for JSON output. Object.fromEntries preserves Map insertion order
// (root first), so the step-0 state is Object.values(graph)[0].
const serializeStateGraph = (graph: Map<string, StateNode>): Record<string, FrontierStateNode> =>
  Object.fromEntries(graph)

export type FrontierExploreInput = {
  threads: Thread[]
  messages?: SelectionTrace[]
  triggers?: BPEvent[]
  strategy?: 'bfs' | 'dfs'
  selectionPolicy?: 'all-enabled' | 'scheduler'
  maxDepth: number
  space?: string
  instanceId?: string
}

export type FrontierExploreOutput = {
  traces: Array<{ messages: Trace[] }>
  findings: Array<{ code: 'deadlock'; messages: Trace[] }>
  report: FrontierReport
  stateGraph: Record<string, FrontierStateNode>
  isError?: boolean
  message?: string
}

export const FrontierExploreInputSchema = {
  type: 'object',
  properties: {
    threads: threadsJsonSchema,
    messages: { ...messagesJsonSchema, nullable: true },
    triggers: {
      type: 'array',
      items: BPEventSchema,
      nullable: true,
      description: 'external trigger events that may wake pending threads',
    },
    strategy: {
      type: 'string',
      enum: ['bfs', 'dfs'],
      nullable: true,
      default: 'bfs',
      description: "exploration strategy: 'bfs' (breadth-first) or 'dfs' (depth-first). Default 'bfs'.",
    },
    selectionPolicy: {
      type: 'string',
      enum: ['all-enabled', 'scheduler'],
      nullable: true,
      default: 'all-enabled',
      description:
        "'all-enabled' branches on every enabled candidate; 'scheduler' takes only the highest-priority one. Default 'all-enabled'.",
    },
    maxDepth: {
      type: 'integer',
      minimum: 1,
      description:
        'Required. Maximum selection depth. Finite-state programs close their state graph and terminate before this; unbounded-state programs (e.g. a counter whose detail grows each loop) never close — maxDepth bounds them and sets report.truncated when it cuts off. Never treat truncated as a pass.',
    },
    space: { type: 'string', nullable: true, description: 'space stamp applied to all thread rules' },
    instanceId: {
      type: 'string',
      nullable: true,
      description: 'instance id stamped on synthetic traces; defaults to a minted ueid("bp_")',
    },
  },
  required: ['threads', 'maxDepth'],
  additionalProperties: false,
  description:
    'Enumerate every reachable frontier of a thread set, collecting traces, deadlock findings, and the labeled state graph (serialized to a plain object keyed by stateKey).',
} as unknown as JSONSchemaType<FrontierExploreInput>

export const FrontierExploreOutputSchema = {
  type: 'object',
  properties: {
    traces: { type: 'array', items: { type: 'object', additionalProperties: true } },
    findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
    report: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['bfs', 'dfs'] },
        selectionPolicy: { type: 'string', enum: ['all-enabled', 'scheduler'] },
        visitedCount: { type: 'integer' },
        findingCount: { type: 'integer' },
        truncated: { type: 'boolean' },
        maxDepth: { type: 'integer', nullable: true },
      },
      required: ['strategy', 'selectionPolicy', 'visitedCount', 'findingCount', 'truncated'],
      additionalProperties: false,
    },
    stateGraph: {
      type: 'object',
      additionalProperties: true,
      description:
        'reachable states keyed by canonical stateKey; each value is { stateKey, frontier, step, successors }',
    },
    isError: {
      type: 'boolean',
      nullable: true,
      description: 'true when exploration threw (e.g. an unsupported strategy slipped past the schema)',
    },
    message: { type: 'string', nullable: true, description: 'error detail when isError' },
  },
  required: ['traces', 'findings', 'report', 'stateGraph'],
  additionalProperties: false,
} as unknown as JSONSchemaType<FrontierExploreOutput>

/**
 * Enumerate every reachable frontier of a thread set.
 *
 * Wraps the raw explorer: the internal `Map<string, StateNode>` is serialized
 * to a plain object keyed by stateKey; traces, findings, and report cross
 * verbatim (all JSON-safe). State-keyed deduplication means finite-state
 * looping programs terminate without relying on maxDepth. Any throw (an
 * unsupported strategy slipping past the enum, etc.) is caught into
 * `{ isError, message }` with empty structural defaults.
 */
export const frontierExplore = defineTool(
  {
    name: 'frontier-explore',
    description:
      'Enumerate every reachable frontier of a thread set — traces, deadlock findings, and the labeled state graph (serialized to a plain object keyed by stateKey). maxDepth bounds unbounded-state programs; finite-state loops terminate via state-key dedup. Use to answer "can this deadlock?" across all reachable states, not sampled runs.',
    inputSchema: FrontierExploreInputSchema,
    outputSchema: FrontierExploreOutputSchema,
  },
  ({ threads, messages, triggers, strategy, selectionPolicy, maxDepth, space, instanceId }) => {
    try {
      const { traces, findings, report, stateGraph } = exploreFrontiersRaw({
        threads,
        messages,
        triggers,
        strategy,
        selectionPolicy,
        maxDepth,
        space,
        instanceId,
      })
      return {
        traces,
        findings,
        report,
        stateGraph: serializeStateGraph(stateGraph),
      }
    } catch (err) {
      return {
        traces: [],
        findings: [],
        report: {
          strategy: strategy ?? 'bfs',
          selectionPolicy: selectionPolicy ?? 'all-enabled',
          visitedCount: 0,
          findingCount: 0,
          truncated: false,
          maxDepth,
        },
        stateGraph: {},
        isError: true,
        message: (err as Error).message,
      }
    }
  },
)

export type FrontierVerifyInput = {
  threads: Thread[]
  messages?: SelectionTrace[]
  triggers?: BPEvent[]
  strategy?: 'bfs' | 'dfs'
  selectionPolicy?: 'all-enabled' | 'scheduler'
  maxDepth: number
  progress?: string[]
  space?: string
  instanceId?: string
}

export type FrontierVerifyOutput = {
  status: 'verified' | 'failed' | 'truncated'
  findings: Array<{ code: 'deadlock'; messages: Trace[] }>
  report: FrontierReport
  livelocks: Array<{ code: 'livelock'; states: string[]; progressTypes: string[] }>
  isError?: boolean
  message?: string
}

export const FrontierVerifyInputSchema = {
  type: 'object',
  properties: {
    threads: threadsJsonSchema,
    messages: { ...messagesJsonSchema, nullable: true },
    triggers: {
      type: 'array',
      items: BPEventSchema,
      nullable: true,
      description: 'external trigger events that may wake pending threads',
    },
    strategy: {
      type: 'string',
      enum: ['bfs', 'dfs'],
      nullable: true,
      default: 'bfs',
      description: "exploration strategy: 'bfs' (breadth-first) or 'dfs' (depth-first). Default 'bfs'.",
    },
    selectionPolicy: {
      type: 'string',
      enum: ['all-enabled', 'scheduler'],
      nullable: true,
      default: 'all-enabled',
      description:
        "'all-enabled' branches on every enabled candidate; 'scheduler' takes only the highest-priority one. Default 'all-enabled'.",
    },
    maxDepth: {
      type: 'integer',
      minimum: 1,
      description:
        'Required. Maximum selection depth. Finite-state programs close their state graph and terminate before this; unbounded-state programs never close — maxDepth bounds them and yields status "truncated" when it cuts off. Never treat truncated as a pass.',
    },
    progress: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description:
        'Event types that count as progress. When provided, a reachable cycle that never selects a progress event is a livelock (status "failed"). Omit to skip livelock detection (deadlock-only). An empty array flags every cycle as a livelock.',
    },
    space: { type: 'string', nullable: true, description: 'space stamp applied to all thread rules' },
    instanceId: {
      type: 'string',
      nullable: true,
      description: 'instance id stamped on synthetic traces; defaults to a minted ueid("bp_")',
    },
  },
  required: ['threads', 'maxDepth'],
  additionalProperties: false,
  description:
    'Verify a thread set: explore every reachable frontier and derive a verified/failed/truncated status. With the progress spec, also detects livelocks (cycles that never select a progress event).',
} as unknown as JSONSchemaType<FrontierVerifyInput>

export const FrontierVerifyOutputSchema = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['verified', 'failed', 'truncated'],
      description:
        'the verdict: verified (clean, fully-explored, finding-free), failed (deadlock or livelock found), or truncated (maxDepth cut off — not a pass)',
    },
    findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
    report: {
      type: 'object',
      properties: {
        strategy: { type: 'string', enum: ['bfs', 'dfs'] },
        selectionPolicy: { type: 'string', enum: ['all-enabled', 'scheduler'] },
        visitedCount: { type: 'integer' },
        findingCount: { type: 'integer' },
        truncated: { type: 'boolean' },
        maxDepth: { type: 'integer', nullable: true },
      },
      required: ['strategy', 'selectionPolicy', 'visitedCount', 'findingCount', 'truncated'],
      additionalProperties: false,
    },
    livelocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', enum: ['livelock'] },
          states: { type: 'array', items: { type: 'string' } },
          progressTypes: { type: 'array', items: { type: 'string' } },
        },
        required: ['code', 'states', 'progressTypes'],
        additionalProperties: false,
      },
    },
    isError: { type: 'boolean', nullable: true, description: 'true when verification threw unexpectedly' },
    message: { type: 'string', nullable: true, description: 'error detail when isError' },
  },
  required: ['status', 'findings', 'report', 'livelocks'],
  additionalProperties: false,
} as unknown as JSONSchemaType<FrontierVerifyOutput>

/**
 * Verify a thread set: explore every reachable frontier and derive a
 * pass/fail/truncated status.
 *
 * Wraps the raw verifier. The raw result — `{ status, findings, report,
 * livelocks }` — is already verdict-shaped and JSON-safe (no Set/Map/generator),
 * so it crosses the boundary verbatim. Any unexpected throw is caught into
 * `{ isError, message }` with a `failed` status (never throw into the model
 * channel).
 */
export const frontierVerify = defineTool(
  {
    name: 'frontier-verify',
    description:
      'Verify a thread set across every reachable state — is it deadlock- or livelock-free? Returns verified/failed/truncated. With the progress spec, a reachable cycle that never selects a progress event is a livelock (failed). Never treat truncated as a pass.',
    inputSchema: FrontierVerifyInputSchema,
    outputSchema: FrontierVerifyOutputSchema,
  },
  ({ threads, messages, triggers, strategy, selectionPolicy, maxDepth, progress, space, instanceId }) => {
    try {
      const { status, findings, report, livelocks } = verifyFrontiersRaw({
        threads,
        messages,
        triggers,
        strategy,
        selectionPolicy,
        maxDepth,
        progress,
        space,
        instanceId,
      })
      return { status, findings, report, livelocks }
    } catch (err) {
      return {
        status: 'failed' as const,
        findings: [],
        report: {
          strategy: strategy ?? 'bfs',
          selectionPolicy: selectionPolicy ?? 'all-enabled',
          visitedCount: 0,
          findingCount: 0,
          truncated: false,
          maxDepth,
        },
        livelocks: [],
        isError: true,
        message: (err as Error).message,
      }
    }
  },
)

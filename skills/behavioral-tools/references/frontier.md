# frontier — behavioral frontier analysis

Three tools for analyzing behavioral-programming thread sets without running
a model: replay a concrete event-selection trace, enumerate every reachable
state, or verify deadlock/livelock freedom. Inputs use the serialized thread
idiom (`{ label, rules }[]`) plus an optional selection-trace prefix
(`messages`).

## Tools

| Tool | Returns |
|------|---------|
| `frontier-replay` | The resulting frontier, the canonical pending-state key, and the pending-bid count for one concrete trace |
| `frontier-explore` | Every reachable frontier: traces, deadlock findings, and the labeled state graph (BFS/DFS, `strategy` default `bfs`) |
| `frontier-verify` | `verified` / `failed` / `truncated` across every reachable state — deadlock and livelock checks |

## When to use which

| Need | Tool |
|------|------|
| Prove a known event sequence was valid | `frontier-replay` (a disabled selection returns `isError` instead of throwing) |
| Map the full reachable state graph | `frontier-explore` |
| Gate a candidate thread set (safety) | `frontier-verify` |
| Livelock detection | `frontier-verify` with the progress spec (a reachable cycle that never selects a progress event is a livelock) |

## Examples

```bash
# Replay a trace against a thread set
behavioral tools '{"tool":"frontier-replay","input":{"threads":[{"label":"greet","rules":[{"await":[{"type":"greet"}],"request":[{"type":"greet"}],"block":[]}]}]}}'

# Explore with DFS
behavioral tools '{"tool":"frontier-explore","input":{"threads":[...],"strategy":"dfs","maxDepth":10}}'

# Verify with a progress spec
behavioral tools '{"tool":"frontier-verify","input":{"threads":[...],"progress":["step-done"]}}'
```

## Notes

- A disabled selection during replay returns `{ frontier: null, stateKey:
  null, pendingCount: null, isError: true, message }` — the throw never
  crosses the dispatch boundary.
- `frontier-verify` returns `truncated` when the exploration budget runs out
  — **never treat truncated as a pass**.
- "Progress" is whatever the caller declares meaningful: `progress` is a set
  of event types; a reachable cycle selecting none of them is a livelock.
- `behavioral tools --schema input --tool frontier-explore` — the
  authoritative input schema (thread idiom, policies, depth budget).

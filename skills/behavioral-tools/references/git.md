# git — structured repo context

`behavioral tools '{"tool":"git-<mode>","input":{...}}'` returns structured
JSON instead of raw git output, so an agent can parse repo state directly
without scraping terminal output. It replaces the 8+ raw git commands an
agent would otherwise chain to learn branch, HEAD, upstream, staged/unstaged
files, merge-base, commits-since-base, changed files, and per-path history.

## Tools

| Tool | Returns | Required fields |
|------|---------|-----------------|
| `git-status` | Branch, HEAD, upstream, staged/unstaged/untracked files with counts | — |
| `git-history` | Merge-base, commits since `base`, changed files, per-path history | `base` |
| `git-worktrees` | Parsed worktree list with lock/prune metadata | — |
| `git-context` | Combined status + history + optional worktrees in one call | `base` |

All tools accept optional `cwd` (default `.`). `git-history` and `git-context`
also accept `paths` (default `[]`, scopes per-path history), `limit`
(default 20, max 200, caps commits-per-path), and `git-context` accepts
`includeWorktrees` (default `false`).

## When to use which

| Need | Tool | Notes |
|------|------|-------|
| Full picture in one round-trip | `git-context` | Prefer as the starting point |
| Just staged/unstaged state before editing | `git-status` | No `base` needed; cheap |
| Review what changed on a branch | `git-context` or `git-history` with `base` | `base` is the integration branch |
| Enumerate `.worktrees/<task-slug>/` | `git-worktrees`, or `git-context` with `includeWorktrees:true` | Parsed lock/prune metadata included |
| Deep per-path history | `git-history` with raised `limit` | Capped at 200 to bound output |

## Examples

```bash
# Status only (no merge-base needed)
behavioral tools '{"tool":"git-status","input":{"cwd":"."}}'

# History since the dev branch, scoped to two paths
behavioral tools '{"tool":"git-history","input":{"cwd":".","base":"dev","paths":["src","tests"],"limit":50}}'

# Combined context with worktrees
behavioral tools '{"tool":"git-context","input":{"cwd":".","base":"main","includeWorktrees":true}}'
```

## Gotchas

**Forgetting `base` on `git-history` or `git-context`.** Both compute the
merge-base against an integration branch, and `base` is required — without it
the dispatch fails input validation (exit 2). Use the branch the current work
integrates into (`main`, `dev`, etc.), not the current branch. If you only
need working-tree state, use `git-status` or `git-worktrees`, which don't
require `base`.

**Treating `limit` as a cap on the total commit list.** It caps per-path
history depth, not the overall commit list — raising it pulls more history
per changed file, not a broader set of commits. Raise it for deep per-path
analysis; leave the default for a review summary.

Output warnings carry diagnostic signals: dirty worktrees, missing upstream,
broad change surfaces, truncated file lists (capped at 200 entries), and
deleted-file counts.

## Inspecting the contract

- `behavioral tools --schema input --tool git-history` — the input schema,
  the authoritative field list.
- `behavioral tools --schema output --tool git-status` — the output schema.

---
name: behavioral-tools
description: Invoke the behavioral agent tool fleet via the `behavioral tools` CLI dispatcher — git (git-status, git-history, git-worktrees, git-context), TypeScript LSP (typescript-execute, typescript-discover), MCP client (mcp-discover, mcp-call-tool, mcp-list-tools, mcp-get-prompt, mcp-list-resources, mcp-read-resource), HTML validation/rendering (html-render, html-validate-and-escape, html-scale-check), frontier analysis (frontier-replay, frontier-explore, frontier-verify), discovery catalog CRUD (discovery-create/read/update/delete/search), skill client (skill-discover, skill-read, skill-list-resources, skill-extract-links, skill-validate-links), and plugin loading (plugin-client). JSON in / JSON out over stdio, one subprocess call per invocation. Use when an agent needs structured git context, semantic TypeScript queries, remote MCP operations, HTML/CSS validation, behavioral frontier analysis, or skill/plugin inspection instead of raw shell commands.
license: ISC
compatibility: Requires bun and the behavioral CLI
allowed-tools: Bash
---

# Behavioral Tools

Reference for an agent using the `behavioral tools` CLI — the single dispatcher
fronting the tool fleet. Every tool is JSON-in / JSON-out over stdio: pass a
stringified JSON object as the positional argument (or via stdin), parse the
stdout JSON. One subprocess call per invocation; the tool never writes a store
unless its description says so.

## Operator surface

```bash
behavioral tools '{"tool":"<name>","input":{...}}'
```

The envelope is strict: `tool` (the tool name) and `input` (the tool input
object). Dispatch validates `input` against the named tool's input schema and
the result against its output schema, then prints the result JSON.

```bash
# Full context in one round-trip
behavioral tools '{"tool":"git-context","input":{"cwd":".","base":"main"}}'

# Stream from stdin
echo '{"tool":"typescript-discover","input":{}}' | behavioral tools
```

## Discovery loop

Never guess a tool's input shape — the contract is exposed by flags:

- `behavioral tools --help` — usage plus every tool name with its description.
- `behavioral tools --schema` — the fleet index as JSON: one
  `{ name, description }` per tool.
- `behavioral tools --schema input --tool <name>` — that tool's input schema
  (the authoritative field list, with per-field descriptions and defaults).
- `behavioral tools --schema output --tool <name>` — that tool's output schema.
- `behavioral tools --dry-run '<json>'` — print the resolved envelope without
  executing; useful to confirm wiring before an expensive call.

## Exit codes

- `0` — the tool ran. Per-request failures inside a tool (e.g. an unsupported
  LSP method) may still be reported inline in the result JSON — inspect the
  output rather than relying on the exit code alone.
- `1` — the tool ran but its result failed output validation, or the process
  crashed. The error JSON prints to stderr.
- `2` — bad input: invalid JSON, an unknown tool name, or input that fails the
  named tool's input schema. The validation errors print to stderr.

## Module references

Each module's tools, when-to-use guidance, examples, and gotchas:

- [discovery](references/discovery.md) — `discovery-create`,
  `discovery-read`, `discovery-update`, `discovery-delete`,
  `discovery-search`. Unified catalog CRUD for remote MCP tools and local
  skills.
- [frontier](references/frontier.md) — `frontier-replay`,
  `frontier-explore`, `frontier-verify`. Behavioral-programming frontier
  analysis: replay traces, explore reachable state graphs, verify
  deadlock/livelock freedom.
- [git](references/git.md) — `git-status`, `git-history`, `git-worktrees`,
  `git-context`. Structured repo context; replaces chaining 8+ raw git
  commands.
- [html](references/html.md) — `html-validate-and-escape`,
  `html-validate-attribute-value`, `html-render`, `html-update-attributes`,
  `html-scale-check`. HTML/CSS validation and render-tree surgery per the
  behavioral design-system spec.
- [mcp-client](references/mcp-client.md) — `mcp-discover`, `mcp-call-tool`,
  `mcp-list-tools`, `mcp-list-prompts`, `mcp-get-prompt`,
  `mcp-list-resources`, `mcp-read-resource`. Remote MCP server operations.
- [plugin-client](references/plugin-client.md) — `plugin-client`. Load and
  validate an Agent Plugins v1 package (plugin.json, mcp.json, skills/, the
  sh.behavioral extension).
- [skill-client](references/skill-client.md) — `skill-discover`,
  `skill-read`, `skill-list-resources`, `skill-extract-links`,
  `skill-validate-links`. Local skill progressive disclosure plus markdown
  link extraction/validation.
- [typescript](references/typescript.md) — `typescript-execute`,
  `typescript-discover`. LSP-style queries (documentSymbol, hover,
  completion, definition) over the TypeScript 7 native API.

## Routing quick-start

| Need | Module |
|------|--------|
| Repo state before editing/reviewing | [git](references/git.md) |
| Type info, symbols, definitions, completions | [typescript](references/typescript.md) |
| Call/list tools on a remote MCP server | [mcp-client](references/mcp-client.md) |
| Validate or render behavioral HTML | [html](references/html.md) |
| Prove a thread set is deadlock-free | [frontier](references/frontier.md) |
| Catalog CRUD for MCP tools / skills | [discovery](references/discovery.md) |
| Read a local skill or its bundled files | [skill-client](references/skill-client.md) |
| Load a plugin package | [plugin-client](references/plugin-client.md) |

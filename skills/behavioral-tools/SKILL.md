---
name: behavioral-tools
description: Invoke the behavioral agent CLI fleet via the `behavioral tools` dispatcher — skill client (skill-discover, skill-read, skill-list-resources, skill-extract-links, skill-validate-links) and plugin loading (plugin-client). JSON in / JSON out over stdio, one subprocess call per invocation. Use when an agent needs skill/plugin inspection instead of raw shell commands. Remote MCP operations are a worker family (mcp_request wire) — see references/mcp-client.md; git and raw shell belong to the shell worker; HTML validation belongs to the controller floors + the classifier story (prompts/html-classifier-gate.md); TypeScript LSP is a future satellite family (TS 7.1 stable API).
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
# Invoke by name
behavioral tools '{"tool":"skill-discover","input":{"cwd":"."}}'

# Stream from stdin
echo '{"tool":"skill-discover","input":{"cwd":"."}}' | behavioral tools
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

- [mcp-client](references/mcp-client.md) — the remote MCP **worker family**
  (`mcp_request` / `mcp_request_result` / `mcp_cancel` wire, seven ops,
  typed `authorization_required` results, the auth replay spine). Not CLI
  fleet tools — hosts mount the family in the `useWorkers` map.
- [plugin-client](references/plugin-client.md) — `plugin-client`. Load and
  validate an Agent Plugins v1 package (plugin.json, mcp.json, skills/,
  threads/ — portable surface only, extension namespaces unread).
- [skill-client](references/skill-client.md) — `skill-discover`,
  `skill-read`, `skill-list-resources`, `skill-extract-links`,
  `skill-validate-links`. Local skill progressive disclosure plus markdown
  link extraction/validation.

## Routing quick-start

| Need | Module |
|------|--------|
| Call/list tools on a remote MCP server | [mcp-client](references/mcp-client.md) — the mcp worker family |
| Read a local skill or its bundled files | [skill-client](references/skill-client.md) |
| Load a plugin package | [plugin-client](references/plugin-client.md) |

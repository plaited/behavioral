---
name: behavioral-tools
description: Remote MCP operations for the behavioral agent via the mcp worker family — the mcp_request/mcp_request_result/mcp_cancel event wire (seven ops, typed authorization_required results, the auth replay spine) plus the auth/broker binding rules. The CLI tool fleet is retired: skills and plugins run through the skill-conventions skill (threads + recipes + store), git and raw shell belong to the shell worker, HTML validation belongs to the controller floors + the classifier story (prompts/html-classifier-gate.md), TypeScript LSP is a future satellite family (TS 7.1 stable API).
license: ISC
compatibility: Requires bun and the behavioral CLI
allowed-tools: Bash
---

# Behavioral Tools

Reference for the behavioral agent's compiled operator surfaces. As of the
ICL conversion, **every compiled surface is a worker family or the shell** —
the CLI tool fleet is retired:

- **Remote MCP** is the mcp worker family: requests ride the behavioral
  event wire (`mcp_request` / `mcp_request_result` / `mcp_cancel`), seven
  ops, typed `authorization_required` results with request echo, auth bound
  at the worker's module scope (broker env-data + keychain floor — per-call
  credentials are retired). See
  [references/mcp-client.md](references/mcp-client.md).
- **Skills and plugins** (discovery, reading, frontmatter validation, link
  extraction/validation) run through threads + the shell worker (`bun run -`)
  + the store — taught by the **skill-conventions** skill.
- **Git and raw shell** belong to the shell worker (`shell_request`, bun-direct —
  `run` op TS scripts, `shell` op Bun Shell commands).
- **HTML validation** belongs to the controller floors and the classifier
  story ([prompts/html-classifier-gate.md](../../prompts/html-classifier-gate.md)).

## Module references

- [mcp-client](references/mcp-client.md) — the mcp worker family: wire,
  ops, typed results, auth binding, the replay spine, composing.

---
name: behavioral-tools
description: Remote MCP operations for the behavioral agent via the remote-mcp thread pack — the MCP layering over the shell faculty's generic `rpc` op (the 2026-07-28 stateless era: stamped `_meta` envelope, discovery, tools/call, the MRTR elicitation loop, bounded retry), with auth via the credential seam. The CLI tool fleet is retired: skills and plugins run through the skill-conventions skill (threads + recipes + store), git and raw shell belong to the shell faculty, HTML validation belongs to the controller floors + the classifier story , TypeScript LSP is a future faculty (TS 7.1 stable API).
license: ISC
compatibility: Requires bun and the behavioral CLI
allowed-tools: Bash
---

# Behavioral Tools

Reference for the behavioral agent's compiled operator surfaces. As of the
ICL conversion, **every compiled surface is a faculty or the shell** —
the CLI tool fleet is retired:

- **Remote MCP** is the remote-mcp thread pack over the shell faculty's
  generic `rpc` op (the 2026-07-28 stateless era: stamped `_meta` envelope,
  discovery, tools/call, the MRTR elicitation loop, bounded retry; auth via
  the credential seam). See
  [references/remote-mcp.md](references/remote-mcp.md).
- **Skills and plugins** (discovery, reading, frontmatter validation, link
  extraction/validation) run through threads + the shell faculty (`bun run -`)
  + the store — taught by the **skill-conventions** skill.
- **Git and raw shell** belong to the shell faculty (`shell_request`, bun-direct —
  `run` op TS scripts, `shell` op Bun Shell commands).
- **HTML validation** belongs to the controller floors and the classifier
  story (`src/controller/css.schemas.ts` doubles as classifier context — the
  gate design is a local working doc, `.prompts/html-classifier-gate.md`).

## Module references

- [remote-mcp](references/remote-mcp.md) — the remote-mcp thread pack:
  the rpc op layering, trusted response shapes, the ctx join lane,
  MRTR, composing.

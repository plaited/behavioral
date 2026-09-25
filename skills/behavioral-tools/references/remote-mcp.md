# remote-mcp — the remote MCP thread pack

Remote MCP is no longer a faculty. It is a **thread pack** over the shell
faculty's generic `rpc` op (`src/faculties/shell/remote-mcp.threads.ts`):
the op is transport-shaped (one stateless HTTP JSON-RPC POST per call), and
this pack is where "MCP" lives — the protocol envelope, discovery, tool
execution, the multi-round-trip elicitation loop, and bounded retry.

The pack speaks the MCP 2026-07-28 stateless era: no handshake, no session
id — every request carries the protocol stamp in-band (`_meta` envelope:
`io.modelcontextprotocol/protocolVersion` + `clientInfo` +
`clientCapabilities`, plus the `MCP-Protocol-Version` header), and
server→client interactions arrive **in-band** as `input_required` results
(no server→client JSON-RPC channel on this revision).

## The events

| Event | Detail | Direction |
|-------|--------|-----------|
| `remote_mcp_discover` | `{ id, input: { url } }` | program → pack (host/config ingress) |
| `remote_mcp_discovered` | `{ id, ok, input?: { url, tools } }` or `{ id, ok: false, error }` | pack → program |
| `remote_mcp_call` | `{ id, input: { url, tool, args } }` | program → pack |
| `remote_mcp_call_result` | `{ id, ok: true, result }` or `{ id, ok: false, error }` | pack → program |
| `remote_mcp_elicitation` | `{ id, input: { url, tool, args, round, inputRequests, requestState } }` | pack → program (host surfaces) |
| `remote_mcp_elicitation_response` | the elicitation detail echoed + `inputResponses` | host → pack (ingress) |

All of the pack's remote work rides `shell_request` events (`op: 'rpc'`)
and comes back on `shell_request_result`; registration rides
`store_request` (the `remote-mcp` collection, keyed by server URL — the
tools sit alongside the skills/plugins tenants in the shell registry).

## The join lane: `ctx`

Cross-event state rides the shell wire's `detail.ctx` — the out-of-band
lane beside `input` (the you.com MCP `_meta` pattern: host-supplied,
round-tripped verbatim, never a model-facing field). The pack stamps
`ctx.echo { source, url, leg, round, attempt }` on every op it issues; the
shell faculty echoes `ctx` on the result; the pack's transforms join on it.
Auth rides the credential seam (`shell/rpc-auth.threads.ts`): a remote 401
challenge maps to the typed `credential_required`, and the seam vends
(broker first, keychain floor second — issuer-bound via `ctx.issuer`) and
replays the call with the vended bearer.

## Trusted response shapes

The pack AJV-validates ONLY the four responses it acts on
(`server/discover`, `tools/list`, `tools/call`, `InputRequiredResult`) —
exported from `remote-mcp.threads.ts` as `REMOTE_MCP_*_SCHEMA`. A response
failing its trusted shape silently no-matches the acting transform (the
result stays visible as an unmatched event in the frontier traces) —
fail-closed, not silently-wrong.

## Multi-round-trip (MRTR)

A `tools/call` result carrying the reserved `inputRequests` / `requestState`
members (at-least-one) is an `input_required` answer: the pack surfaces
`remote_mcp_elicitation`, the host answers with
`remote_mcp_elicitation_response` (echo + bare `inputResponses`), and the
pack retries `tools/call` with the answers plus a byte-exact `requestState`
echo, on a fresh request id, up to `REMOTE_MCP_MAX_ROUNDS` — the cap
exhausts as a typed `round_cap` error on `remote_mcp_call_result`.

## Composition

`bProgram` mounts the pack when **shell + security + store** are all on
(executor + vending leg + registry). The retired `mcp` faculty's replay
spine is gone; its capture-on-auth-required pattern lives on in the
credential seam.

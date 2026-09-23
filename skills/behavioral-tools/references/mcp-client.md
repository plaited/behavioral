# mcp-client — the remote MCP behavior

Remote MCP server operations are a spawned **behavior**, not CLI fleet tools:
`src/workers/mcp-client.worker.ts` (spawned by URL) holds the connections,
and the engine speaks to it over the behavioral event wire. The
`src/threads/mcp-client.ts` thread spine orchestrates cross-turn auth
replay.

## The wire

| Event | Detail | Direction |
|-------|--------|-----------|
| `mcp_request` | `{ id, op, input }` | program → behavior |
| `mcp_request_result` | `{ id, result }` | behavior → program |
| `mcp_cancel` | `{ id }` | program → behavior |

The seven ops (`detail.op`): `discover`, `list-tools`, `call-tool`,
`list-prompts`, `get-prompt`, `list-resources`, `read-resource`. Each op
input carries the server `url` plus the op's own fields (`tool`/`args` for
call-tool, `name` for get-prompt, `uri` for read-resource) and an optional
`timeoutMs` wall-clock deadline for the whole call.

## The result envelope

`detail.result` is a typed envelope — errors-as-data, never a throw:

```json
{ "id": "…", "status": "…", "durationMs": 42 }
```

- `completed` — `output` carries the remote MCP data (loose; consumers gate
  with their own `detailSchema`).
- `authorization_required` — the call hit a 401; `message` holds the reason
  and `request` echoes `{ op, input }` (the replay spine's capture payload).
- `timeout` / `canceled` — the two stop doors: the input `timeoutMs` (default
  30s) or a `mcp_cancel` mid-flight.
- `error` — invalid op input (the message names the AJV errors) or a failed
  call/connection.

## Auth

Per-call input credentials are **retired** — the wire carries the server
URL only. Auth binds at the worker's module scope: broker env-data
(`MCP_BROKER_URL` + `MCP_BROKER_BOOT_SECRET`, seeded by the spawning host)
with the OS-keychain floor beneath it. Neither yields a token → the call
goes unauthenticated → the server's 401 → typed `authorization_required`.

## The auth replay spine (threads)

An `authorization_required` result is captured in the store (`mcp-calls`,
keyed by call id, value = the echoed request), surfaced to the host as
`mcp_authorization_required { id, reason }` (the shell's "authorize X"
prompt), and after the host re-enters `mcp_authorization_granted { id }`,
the captured request is replayed and the capture deleted. Successful calls
never touch the store.

## Composing

Threads request `mcp_request` events like any other worker family; hosts
mount the family by adding `mcp: new Worker(new URL('./mcp-client.worker.ts', import.meta.url))`
to the `useBehavioral` workers map. Schema-reflect the op inputs via
`src/workers/mcp-client.types.ts` (`MCP_*_OP_INPUT_SCHEMA`) when model-facing
context is needed.

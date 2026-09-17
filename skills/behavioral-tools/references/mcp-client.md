# mcp-client — remote MCP server operations

Seven tools fronting a remote MCP server: discover its surface in one call,
or call tools, list/fetch prompts, and list/read resources individually.
Every tool returns remote MCP data only — the dispatcher never writes a
store.

## Tools

| Tool | Returns |
|------|---------|
| `mcp-discover` | Tools, prompts, and resources in one call (missing capabilities → empty arrays) |
| `mcp-call-tool` | The result of calling a named tool on the server |
| `mcp-list-tools` | The tools the server exposes |
| `mcp-list-prompts` | The prompts the server exposes |
| `mcp-get-prompt` | A rendered prompt |
| `mcp-list-resources` | The resources the server exposes |
| `mcp-read-resource` | A resource's contents |

## Lifecycle

Start with `mcp-discover` to learn a server's full surface (name, tools,
prompts, resources) in one round-trip, then narrow to the specific operation
(`mcp-call-tool`, `mcp-get-prompt`, `mcp-read-resource`). The list operations
are cheap fallbacks when you already know the category.

## Examples

```bash
# One round-trip surface discovery
behavioral tools '{"tool":"mcp-discover","input":{"server":"https://api.example.com/mcp"}}'

# Call a remote tool
behavioral tools '{"tool":"mcp-call-tool","input":{"server":"https://api.example.com/mcp","tool":"search","args":{"query":"behavioral"}}}'
```

## Notes

- Server identity: the `server` field addresses the remote MCP server
  (streamable-http URL). Check the tool's input schema for the exact field
  names — `behavioral tools --schema input --tool mcp-discover` is
  authoritative.
- A failed connection or MCP handshake surfaces as the process error (exit
  1) with the failure message on stderr — it is not an inline result.
- `behavioral tools --schema output --tool mcp-discover` — the discovery
  output shape.

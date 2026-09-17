# discovery — unified catalog CRUD

The discovery catalog unifies remote MCP tools and local skills into one
searchable index (tier 1 of progressive disclosure). Five tools: full CRUD
plus substring search. A row's `kind` is `"mcp-tool"` or `"skill"`; `handle`
is the server URL for an MCP tool or the SKILL.md path for a skill.

## Tools

| Tool | Returns |
|------|---------|
| `discovery-create` | The created row |
| `discovery-read` | One row by `id`; `row: null` when absent |
| `discovery-update` | The updated row; omitted fields unchanged; `row: null` + `isError` when absent |
| `discovery-delete` | `{ deleted }` — false when absent |
| `discovery-search` | Matching rows — case-insensitive substring over name/description |

`discovery-create` requires `cwd`, `kind`, `name`, `description`, and
`handle` (plus optional `metadata`). `discovery-search` takes a `query` (empty
matches all), optional `kind` filter, and `limit`.

## Examples

```bash
# Register a remote MCP tool
behavioral tools '{"tool":"discovery-create","input":{"cwd":".","kind":"mcp-tool","name":"you-web","description":"Web search + content extraction","handle":"https://api.you.com/mcp"}}'

# Search tier 1
behavioral tools '{"tool":"discovery-search","input":{"cwd":".","query":"search","limit":10}}'

# Update a row's description
behavioral tools '{"tool":"discovery-update","input":{"cwd":".","id":"row-id","description":"updated description"}}'
```

## Notes

- The catalog lives under the provisioned `cwd` — the same cwd discipline as
  the skill-client tools.
- `discovery-search` with an empty query is the "list everything" form.
- `behavioral tools --schema input --tool discovery-create` — the
  authoritative field list for creation.

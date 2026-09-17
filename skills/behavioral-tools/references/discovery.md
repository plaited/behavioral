# discovery — unified catalog CRUD

The discovery catalog unifies MCP tools, skills, learned threads, and html
artifacts into one searchable index (tier 1 of progressive disclosure). Five
tools: full CRUD plus substring search. A row's `kind` is `"mcp-tool"`,
`"skill"`, `"thread"`, or `"html"`; `handle` is the server URL for an MCP
tool, the SKILL.md path for a skill, or the artifact path for a thread/html
artifact.

## Tools

| Tool | Returns |
|------|---------|
| `discovery-create` | The created row |
| `discovery-read` | One row by `id`; `row: null` when absent |
| `discovery-update` | The updated row; omitted fields unchanged; `row: null` + `isError` when absent |
| `discovery-delete` | `{ deleted }` — false when absent |
| `discovery-search` | Matching rows — case-insensitive substring over name/description |

`discovery-create` takes `kind`, `name`, `description`, and `handle` (plus
optional `metadata`). `discovery-search` takes a `query` (empty matches all),
optional `kind` filter, and `limit`. No location input: the store is the
single `~/.behavioral/db.sqlite`, and its path is never agent-suppliable.

## Space scoping

Space identity is **provisioner-injected, never agent-supplied** — there is no
`space` field in any input schema, so a fabricated cross-space query fails at
the schema boundary. Every row carries a `space`; `root` is the unscoped
identity and sees every space's rows. A provisioned space sees its own rows
plus root's (the shared global catalog) — never another project space's.

## Examples

```bash
# Register a remote MCP tool
behavioral tools '{"tool":"discovery-create","input":{"kind":"mcp-tool","name":"you-web","description":"Web search + content extraction","handle":"https://api.you.com/mcp"}}'

# Search tier 1
behavioral tools '{"tool":"discovery-search","input":{"query":"search","limit":10}}'

# Update a row's description
behavioral tools '{"tool":"discovery-update","input":{"id":"row-id","description":"updated description"}}'
```

## Notes

- The store is the growth-model home's `~/.behavioral/db.sqlite` (WAL mode) —
  regenerable, not git-tracked; the reconcile scan is the sole writer once it
  lands (uncommitted artifacts are unlearned).
- Plugin-shipped components are indexed with a `source: plugin` metadata
  marker.
- `discovery-search` with an empty query is the "list everything in scope"
  form.
- `behavioral tools --schema input --tool discovery-create` — the
  authoritative field list for creation.

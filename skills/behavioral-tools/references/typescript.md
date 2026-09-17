# typescript — LSP-style queries over the TypeScript 7 native API

`typescript-execute` uses TypeScript's built-in checker directly (TS7
`typescript/unstable/async`) — no `typescript-language-server` process, no
`tsserver.js`, no JSON-RPC lifecycle. You supply a method and params, get the
result. Use it when you need semantic understanding of TypeScript/JavaScript
code: type info, symbol lists, definitions, or completions.

## Tools

| Tool | Returns | Required fields |
|------|---------|-----------------|
| `typescript-execute` | Results array (one per request) for LSP method requests against a file | `file`, `requests` |
| `typescript-discover` | The supported method→capability list | — |

Only four methods are supported: `textDocument/documentSymbol`,
`textDocument/hover`, `textDocument/completion`,
`textDocument/definition`. Unsupported methods return
`"error": "Unsupported method: <method>"` inline.

## Method map

| Task | Method |
|------|--------|
| Type signature + TSDoc at position | `textDocument/hover` |
| Go to definition of a symbol | `textDocument/definition` |
| List all symbols in a file | `textDocument/documentSymbol` |
| Autocomplete at position | `textDocument/completion` |

## Examples

```bash
# Hover + documentSymbol in one session
behavioral tools '{"tool":"typescript-execute","input":{"file":"src/utils/key-mirror.ts","rootDir":".","requests":[
  {"method":"textDocument/hover","params":{"textDocument":{"uri":"file:///abs/path/src/utils/key-mirror.ts"},"position":{"line":10,"character":13}}},
  {"method":"textDocument/documentSymbol","params":{"textDocument":{"uri":"file:///abs/path/src/utils/key-mirror.ts"}}}
]}}'

# List the supported methods
behavioral tools '{"tool":"typescript-discover","input":{}}'
```

Fields: `file` (path to the file), `rootDir` (workspace root for `file://`
URI resolution, default `.`), `requests` (non-empty array of
`{ method, params? }`). Construct URIs as `file://<absolute-path-to-file>`.

## Output shape

`typescript-execute` returns `{ file, results }` where each result
corresponds to the request at the same index. Failed requests (including
unsupported methods) carry an `error` field instead of `result`; other
requests still run.

**Method-specific output shapes vary.** `hover` returns a flattened
`{ name, kind, type, documentation, tags }` (not the LSP-standard
`{ contents, range }`). `documentSymbol` returns entries with a flat
`range: [start, end]` offset pair. `definition` returns the standard LSP
array of `{ uri, range: { start, end } }`. Inspect actual fields per method
rather than assuming a single shape.

## Notes

- All positions are 0-indexed (line 0 = first line, character 0 = first column).
- The file is opened and parsed automatically — no `didOpen` notifications.
- Exit code `0` means the tool ran; per-request failures are reported inline
  as `"error"` on the corresponding result. Inspect `results[].error` to
  detect partial failures.
- For method names and parameter shapes beyond these four, consult the
  [LSP Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).
- `behavioral tools --schema input --tool typescript-execute` — the
  authoritative input schema.

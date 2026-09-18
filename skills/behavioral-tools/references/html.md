# html — behavioral HTML validation and render surgery

Five stateless tools implementing the behavioral design-system contract:
validate markup (attributes + CSS), escape it, insert/replace content at
`b-target` selectors, merge attributes, and resolve the structural scale a
render would nest inside. They enforce the behavioral rules — event handlers
must use `b-trigger` (never `on*`), attributes validate against per-tag
schemas, CSS values against the generated CSS schema.

## Tools

| Tool | Returns |
|------|---------|
| `html-validate-and-escape` | The validated + escaped markup, or every HTML/CSS violation (null markup on failure) |
| `html-validate-attribute-value` | `{ valid: true }` or the violation(s) as data for one tag/attr/value triple |
| `html-render` | The document with the fragment inserted/replaced at every `b-target` match |
| `html-update-attributes` | The document with the attribute map merged into every `b-target` match |
| `html-scale-check` | The most restrictive effective scale a render beside/into a `b-target` would nest inside |
| `html-meta-read` | The validated BMeta extracted from the document's `script[b-meta]` block, or isError when there is none / it fails the schema |
| `html-meta-validate` | `{ ok: true }` or `{ ok: false, message }` for b-meta block content held in-hand (the JSON text, not a document) |
| `html-meta-stamp` | The document with a verified keep-decision appended to its b-meta block (optional status transition), or the original with isError on failure |

**Stateless threading:** `html` is both the input document and the output's
resulting document. Thread each output `html` back in as the next call's
`html` input — the tools hold no session state.

## Examples

```bash
# Validate + escape in one pass
behavioral tools '{"tool":"html-validate-and-escape","input":{"html":"<div id=\\"app\\" class=\\"b-app\\">hi</div>"}}'

# Render a fragment at a target
behavioral tools '{"tool":"html-render","input":{"html":"<body><div b-target=\\"slot\\"></div></body>","fragment":"<p b-trigger=\\"tap\\">hi</p>"}}'

# Check the scale a render would nest inside
behavioral tools '{"tool":"html-scale-check","input":{"html":"...","target":"slot"}}'
```

## Notes

- Validation failures return the original document unchanged plus the
  violations — they are not thrown across the dispatch boundary.
- `on*` event handlers are blocklisted (security: events must use
  `b-trigger`); the violation data names the offending attribute.
- The per-tag attribute schemas and the CSS properties schema are generated
  (`scripts/css-schemas`); the tools are the enforcement point, not the
  source.
- `behavioral tools --schema input --tool html-render` — the authoritative
  field list (html, fragment/target selectors, options).

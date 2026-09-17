# skill-client — local skills, progressive disclosure, and markdown links

Five tools: the three-tier agentskills.io progressive-disclosure pattern over
local skills (search-on-demand — no static catalog), plus the markdown link
tools for validating a skill's own cross-references. All return data only;
`cwd` is provisioner-supplied.

## Tools

| Tool | Tier | Returns |
|------|------|---------|
| `skill-discover` | 1 — metadata | Scan `.agents/skills/` at project + user level; parse frontmatter into `{ name, description, location, ... }` records + warnings |
| `skill-read` | 2 — instructions | The SKILL.md body with frontmatter stripped (`{ name, body }`), or `{ isError, message }` |
| `skill-list-resources` | 3 — resources | Bundled files under the skill directory as relative paths (SKILL.md excluded) |
| `skill-extract-links` | — | Sorted, de-duplicated local `{ value, text }` links from markdown text (markdown links + inline HTML `<a>`/`<img>`; external and fragment-only dropped) |
| `skill-validate-links` | — | `{ present, missing }` — each local link resolved against `cwd` |

## Examples

```bash
# Tier 1: what skills exist here
behavioral tools '{"tool":"skill-discover","input":{"cwd":"."}}'

# Tier 2: read one skill's instructions
behavioral tools '{"tool":"skill-read","input":{"cwd":".","location":".agents/skills/behavioral/SKILL.md"}}'

# Tier 3: what files bundle with it
behavioral tools '{"tool":"skill-list-resources","input":{"cwd":".","location":".agents/skills/behavioral/SKILL.md"}}'

# Validate a skill's own cross-references
behavioral tools '{"tool":"skill-validate-links","input":{"cwd":".agents/skills/behavioral","markdownBody":"See [the reference](references/REFERENCE.md)"}}'
```

## Gotchas

**`rootRelative` on `skill-validate-links` (default `false`).** A leading
`/` in a markdown link has two meanings; the flag selects:

- `false` (default) — `path.resolve` semantics: a leading `/` is the
  **filesystem root**, so `cwd` is discarded for that link.
- `true` — a leading `/` marks a **project/bundle-root-relative** path,
  resolved against `cwd` (OKF bundles, Docusaurus, VitePress, GitHub
  repo-root conventions). The symptom of forgetting it: a docs tree you know
  is healthy shows every root-relative link as `missing`.

`cwd` for `skill-validate-links` is the **link root** the leading `/` is
measured from, not the source file's own directory. For relative-link
conventions (`./guide.md`), pass the file's own directory.

**Frontmatter leniency.** `skill-discover` skips a skill with unparseable
frontmatter (a warning notes it); `skill-read` returns the whole file as the
body when no frontmatter block is present, but `isError` when a malformed
block exists. An unquoted value containing a colon is the common breakage.

## Notes

- `behavioral tools --schema input --tool skill-validate-links` — the
  authoritative input schema including `rootRelative`'s description.

---
name: skill-conventions
description: >
  The ICL conventions for the behavioral agent's skill and plugin domains:
  how to discover, read, validate, and compose over local skills and plugins
  through threads, the shell worker (bun run -), and the store — not fleet
  tools. Covers the scan recipes (frontmatter fence-slicing, lenient
  validation), the store catalog/manifest/recipe tenants, links_request
  dispatching, and how to author your own piped scripts for exploratory
  operations. Use when working with .agents/skills or .agents/plugins, when
  composing bun run - scripts over skill data, or when wiring skill/plugin
  discovery threads.
license: ISC
compatibility: Requires bun and the behavioral runtime (threads + shell worker + store worker)
allowed-tools: Bash Read
---

# Skill Conventions (ICL)

This skill teaches the **context layer** for the skill and plugin domains:
discovery, reading, validation, and composition all run through **threads +
the shell worker (`bun run -`) + the store** — there are no fleet tools for
this domain. Everything below is a convention the runtime and the model
share; the model cannot fall back on training for these mechanics, so this
document is deliberately precise.

## The architecture in one paragraph

Boot threads run **scan recipes** through the shell worker; the results are
schema-gated and land in the **store** as tenants (`skills/catalog`,
`plugins/manifests`, `skill-recipes`). The model (or a host) reads those
tenants to discover what exists, fires **`links_request`** for the
contract-pinned operations, and composes its own `bun run -` scripts for
exploratory work. Skills are discovered *progressively* — tier 1 metadata
first (name/description/location from the catalog), then a skill's body on
demand, then its bundled files.

## The store tenants

| Collection | Key | Value | Gated by |
|------------|-----|-------|----------|
| `skills` | `catalog` | `{ skills: [record…], warnings: [string…] }` | `SKILL_CATALOG_SCHEMA` |
| `plugins` | `manifests` | `{ plugins: [manifest…], warnings: [string…] }` | `PLUGIN_MANIFESTS_SCHEMA` |
| `skill-recipes` | `extract-links` / `validate-links` | the recipe script (verbatim string) | — (written by the seeder) |

Records are open — frontmatter fields beyond `name`/`description`/`location`
ride along verbatim. Catalogs are space-scoped (the store's PK is
`(space, collection, key)`); two spaces never see each other's tenants.
The scan re-runs at every cold boot, so catalogs are never stale.

## Frontmatter parsing (the contract)

A SKILL.md is markdown with a YAML frontmatter block. The parse contract:

1. The file **must start** with `---` (plus optional trailing spaces) on the
   first line.
2. The closing `---` must be alone on its own line (whitespace-trailing ok).
3. Slice out ONLY the fence content. **Never `YAML.parse` the whole file** —
   the body is markdown and will not parse.
4. `YAML.parse` (from `import { YAML } from 'bun'`) the slice. It throws
   `SyntaxError` on invalid YAML — catch it; unparseable means *skip with a
   warning*, never a crash.
5. Multi-document YAML (`---` separators inside) returns an array — treat a
   non-plain-object result as unparseable.

### Lenient per-skill validation (the recipe rules)

| Condition | Action |
|-----------|--------|
| Unparseable/absent frontmatter | **Skip**; warning `"Skipped skill "<dir>" at <path>: unparseable YAML frontmatter"` |
| Missing or empty `name` / `description` | **Skip**; warning naming the field |
| `name` ≠ parent directory name | **Load anyway**; warning |
| `name` > 64 chars | **Load anyway**; warning |
| Same `name` at user and project scope | **Project wins**; warning `"project-level overrides user-level"` |

Warnings are catalog *data* (`warnings: []`), not stderr — a skipped skill is
visible to the model, which can act on it.

## Scan roots

- Project skills: `<cwd>/.agents/skills/`
- User skills: `<HOME>/.agents/skills/`
- Plugins (both scopes): `.agents/plugins/` — each subdirectory a package
  with `plugin.json` (+ optional `mcp.json`, `skills/`, `threads/`)

Scan order: user scope first, then project, so project overrides on name
collision. Directories without a `SKILL.md`/`plugin.json` are skipped
silently.

## Discovering: read the tenants

Tier-1 discovery is a **store read**, not a tool call:

```ts
// inside a bun run - script (or via a catalog_request thread)
const catalog = /* store get skills/catalog */
catalog.skills // → [{ name, description, location, …frontmatter }]
```

Then progressive disclosure, tier by tier: read `location`'s file for the
full instructions (slice the frontmatter off the body — same fence rules);
list bundled files with `Bun.Glob`/`readdirSync` inside the skill directory.
`SKILL.md` is the instruction file, not a bundled resource.

## The contract pair: links_request

Link extraction/validation semantics are **test-pinned contracts** — do not
recompose them by hand; request them:

```
{ type: 'links_request', detail: {
    id: '<correlation id>',
    recipe: 'extract-links' | 'validate-links',
    input: { markdown: '<body>', rootRelative?: boolean }  // rootRelative: validate only
} }
```

The dispatcher threads turn this into the `shell_request` (`run` op) automatically — the
recipe text is static thread data and never enters model context. The result
re-enters as the correlated `shell_request_result` with `jsonData`:

- extract → `{ links: [{ value, text }] }` — sorted, de-duplicated, local
  links only (external http/mailto and fragment-only `#` dropped)
- validate → `{ present: [...], missing: [...] }` resolved against the
  worker's `cwd`; with `rootRelative: true`, leading-`/` links resolve
  against cwd, otherwise against the filesystem root (legacy default)

Extraction order (the pinned contract): inline markdown links first (display
text from the first occurrence), then inline `<a href>` (stripped of tags),
then `<img src alt>` — over BOTH the raw markdown and
`HTMLRewriter(Bun.markdown.html(body))`. Escapes are honored (`\[` is not a
link opener); destinations terminate at `)` unescaped or a newline.

## Authoring your own recipe (the ICL flavor)

For exploratory operations over skill data, compose a `bun run -` script
yourself. The shape every built-in recipe follows:

```ts
// bun run - reads ITS SCRIPT from stdin — so per-call data rides env:
const markdown = process.env.LINKS_INPUT ?? ''
import { YAML } from 'bun'      // YAML.parse for fences
import { readdirSync } from 'node:fs'
// … do the work, dependencies-free (node: + bun builtins only — the
//    shell worker does not guarantee node_modules resolution in cwd) …
console.log(JSON.stringify(result))  // stdout = JSON, exactly one object
```

Conventions: read config from `process.env`; write errors as caught data
into the result; never assume a package can be imported from the cwd. Store
a script worth keeping as a recipe tenant (`skill-recipes` collection) so it
replays verbatim — zero tokens, zero variance.

## Plugin manifests (the reader contract)

The plugin scan carries the Agent Plugins v1 §11.3 posture:

- **Fatal** (plugin rejected, no components discovered): wrong/missing
  `$schema` (must be `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`),
  missing/invalid `name` (§5.5: 1–64 chars, lowercase alnum + `-`/`.`,
  no `--`/`..`), wrong metadata field types, non-object `extensions`.
- **Report-and-ignore**: unknown top-level plugin.json fields (§5.2) — the
  plugin loads, with a warning.
- **Skipped with isolation**: a bad `mcp.json` server entry (siblings still
  load); `mcp.json` `$schema` version ≠ plugin.json's (MCP disabled, skills
  still load). §7.2.1: stdio `command` is a single token (bare name or
  `./`-prefixed); `cwd` is `./`-prefixed or `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`
  -rooted and stays inside the root; remote `url` is absolute http(s) with
  no userinfo/fragment, https unless loopback; header names are RFC 7230
  tokens without case-insensitive duplicates.
- **Ignored**: `extensions` namespaces — unread client-owned annexes; never
  validated, never interpreted.

The manifest value is the governor's admission input; this scan is a
**reader** — no gating policy lives here.

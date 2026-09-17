# plugin-client — Agent Plugins v1 loading and validation

One tool that loads a plugin package as a conformant
[Agent Plugins](https://agent-plugins.org/specification) v1 client: validates
`plugin.json` (closed manifest schema, name constraints), `mcp.json`
(two-stage, per-entry failure isolation), discovers `skills/` from the fixed
location, and reads the `sh.behavioral` client extension (models, gating,
spaces). Read-only — no writes, no provisioning, no subprocess launch.

## Tool

`plugin-client` takes `{ path, cwd }` — the plugin.json path resolved against
the provisioned cwd — and returns the normalized manifest:
`{ name, version, mcps, skills, models, threads, spaces, warnings }`, or
`{ isError: true, message }` on fatal failure.

```bash
behavioral tools '{"tool":"plugin-client","input":{"path":"plugin.json","cwd":"./src/plugin"}}'
```

## Failure boundaries (the useful part)

Per the spec's resilience model:

- **Fatal** (plugin rejected, nothing loads): missing/wrong `$schema`,
  invalid `name` (§5.5 constraints), wrong metadata field types, non-object
  `extensions`, malformed `sh.behavioral` model declarations (e.g. a raw
  `apiKey` — must be `apiKeyRef`).
- **Skipped** (siblings still load): a bad `mcp.json` server entry —
  wrong variant fields, a shell-string `command` (must be one bare token or
  `./`-prefixed), a `cwd` outside the closed `./`/`${PLUGIN_ROOT}`/
  `${PLUGIN_DATA}` forms, a non-HTTPS remote URL on a non-loopback host,
  invalid or duplicate (case-insensitive) header names; a non-conformant
  skill directory.
- **MCP disabled** (skills still load): unparseable `mcp.json`, top-level
  schema violation, or `$schema` version mismatch with `plugin.json`.
- **Reported and ignored**: unknown `plugin.json` top-level fields.

Every skipped/disabled/ignored case appends a diagnostic to the output's
`warnings` array — check `warnings` before assuming a component list is
complete.

## Notes

- Gating (`sh.behavioral` mcps/skills/threads include/exclude lists) is
  applied to the discovered components before output; thread include paths
  are containment-checked against the plugin root (§4.1).
- The `mcps` output is the post-gating map of valid server entries.
- `behavioral tools --schema output --tool plugin-client` — the manifest
  output schema.

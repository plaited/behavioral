# Migration prompt: the `~/.behavioral` growth model

Task: migrate the codebase to the 2026-09-17 growth-model amendment. **Read
the 2026-09-17 entry in `plan.md`'s Decision Log first — it is the authority
for this prompt.** Every phase below cites it.

Ground rules: TDD red-green per slice; `bun --bun tsc --noEmit` + targeted
specs per phase (broad run at the end); one conventional commit per phase;
`AGENTS.md` conventions throughout (AJV `JSONSchemaType`, `useTool`, kebab
tool names, no mode discriminants, `test`/`describe`). Note: the untracked
`plugin.json`/`mcp.json` in the repo root are test droppings — leave them.

## Phase 0 — strip `sh.behavioral` interpretation from plugin-client

The amendment removes ALL client-extension reading. RED first: update the
manifest-output assertions, watch them fail.

- `src/tools/plugin-client.ts`: delete `ShBehavioralExtension`, the
  `sh.behavioral` schema + `validateShBehavioral`, the raw-apiKey check,
  mcps/skills gating, thread gating + plugin-root containment checks, and
  spaces/models extraction. KEEP: manifest + mcp.json conformance, all
  §7.2.1 server rules (command/cwd/url/headers), skills discovery, plain
  ungated `threads/` discovery, the `warnings` channel.
- Output schema becomes `{ name, version, mcps, skills, threads, warnings }`.
- `src/plugin/plugin.json`: drop the `extensions` block entirely.
- `src/cli/init.ts` + `src/cli/tests/init.spec.ts`: no extension block
  installed; manifest assertions follow the new output shape.
- `src/tools/tests/plugin-client.spec.ts`: remove the `sh.behavioral`
  describe blocks; every conformance test stays green.
- `skills/behavioral-tools/references/plugin-client.md`: document the
  portable-only surface (remove the gating/failure-boundary rows that no
  longer apply).

## Phase 1 — `~/.behavioral` skeleton + `config.json`

- Resolve the user-home root `~/.behavioral` (precedent: skill-client's
  user-level scan uses `Bun.env.HOME ?? Bun.env.USERPROFILE`). Constants for
  the tree: `root/` + `<space>/` folders each holding `threads/`, `html/`,
  `logs/`, `logs/archive/`; `db.sqlite` at the top.
- `config.json` + its AJV schema: `{ models: [{ provider, modelId,
  endpointUrl, apiKeyRef?, locality? }] }` — **raw `apiKey` is rejected**
  (the rule moves here from `sh.behavioral`). Host-side loader (kernel
  reads it at provisioning; NOT a fleet tool — host config is not
  agent-facing surface).
- `behavioral init` gains idempotent provisioning: create the skeleton,
  `git init ~/.behavioral` if absent, write `.gitignore` (`db.sqlite`,
  `logs/`) and a seed `config.json` if absent.
- Specs: skeleton creation, git-init idempotency, config validation (raw
  apiKey rejected; valid models load).

## Phase 2 — `BMeta` shared schema + the two carriers

- `BMeta` as a shared `JSONSchemaType` (OKF vocabulary per the amendment:
  `type`, `title`, `description`, `tags`, `generated: {by, at}`,
  `verified: [{by, at}]`, `status: draft|stable|deprecated`, `stale_after`,
  `sources`).
- HTML carrier: `html-validate-and-escape` gains a rule — locate
  `<script type="application/json" b-meta>` in `<head>`, parse, validate
  against the BMeta schema; report violations through the existing
  violation channel. (`b-meta` joins the `b-*` prefix vocabulary.)
- Thread carrier: `export const meta: BMeta = {...}` convention (typed; no
  comment-block parsing).
- Specs: b-meta block located/validated/rejected per malformed cases.

## Phase 3 — discovery kinds + provisioner space scoping

- New kinds `thread` and `html` join `skill`/`mcp-tool`; plugin-shipped
  components indexed with a `source: plugin` metadata marker.
- **Space binding is provisioner-side**: the discovery tools bind
  `WHERE space = :identity` server-side — no `space` field in the
  agent-facing input schemas; root is the unscoped identity.
- The db lives at `~/.behavioral/db.sqlite` (WAL mode); `dbPath` derives
  from the home root.
- Specs: kind CRUD/search; a fabricated cross-space query fails at the
  schema boundary.

## Phase 4 — reconcile scan + governor threads

- A kernel thread, post-turn/at-provisioning: walk
  `~/.behavioral/<space>/{threads,html}`, `.agents/skills/`, and installed
  plugins; derive rows from BMeta + `git log -1` per artifact (commitSha
  into metadata); upsert/delete via the discovery tools. The scan is the
  **sole writer** — uncommitted artifacts are unlearned and correctly
  absent. Root's scan indexes all spaces.
- Governor pattern: learned threads in `root/threads/` that block
  `discovery-create`/`discovery-update`/`discovery-delete` calls outside
  the scan (write-policy), gate plugin-asset usage, rate-limit. Block at
  the behavioral event layer (observable in the deadlock trace's candidate
  set). No special casing — governors pass `frontier-verify` like every
  learned thread.
- Specs: scan round-trip (artifact → row → artifact deleted → row gone);
  governor block/relinquish both observable.

## Phase order rationale

Phase 0 is pure deletion (nothing consumes the extension logic — remove
first so later phases don't build on it). Phase 1 fixes the paths everything
else uses. Phase 2's metadata is what Phase 3's rows derive from. Phase 4
composes all of it. Final gate: broad `bun test` + tsc clean.

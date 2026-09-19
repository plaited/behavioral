/**
 * Conformant Agent Plugins v1 client — validates a plugin package's
 * plugin.json + mcp.json, discovers skills/ from the fixed location, and
 * discovers threads/ as a plain ungated component dir.
 *
 * @remarks
 * A stateless `defineTool` unit: input `{ path, cwd }` (plugin.json path
 * resolved against the provisioned cwd), output the normalized manifest
 * `{ name, version, mcps, skills, threads, warnings }`. Loading is
 * read-only — no writes, no provisioning.
 *
 * **Portable-only surface (growth-model amendment):** ALL client-extension
 * interpretation is removed. `extensions` namespaces are unread,
 * client-owned annexes (§8.1) — never validated, never interpreted.
 * Gating is host structure + governor threads, not plugin self-description.
 *
 * **Validation posture (§11.3):**
 * - **Fatal** — missing/wrong `$schema`, missing/invalid `name`, invalid
 *   metadata field types, non-object extensions. The plugin is rejected; no
 *   components are discovered.
 * - **Report-and-ignore** — unknown top-level fields in plugin.json (§5.2).
 *   The plugin still loads.
 * - **Skipped** — a bad mcp.json server entry (siblings still load); a
 *   non-conformant skill dir (other skills still load); mcp.json $schema
 *   mismatch (MCP disabled, skills still load).
 * - **Ignored** — unknown extension namespaces (§8.1 — contents not
 *   validated, not read).
 *
 * @packageDocumentation
 */

import * as path from 'node:path'
import type { JSONSchemaType } from 'ajv'
import { ajv, defineTool } from './define-tool.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpServerConfig = {
  type: 'stdio' | 'streamable-http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

/** Normalized manifest — the contract the provisioning thread consumes. */
export type PluginManifest = {
  /** Non-fatal diagnostic signals (§5.2/§7.2.2/§11.3 SHOULD-report). */
  warnings: string[]
  name: string
  version?: string
  mcps: Record<string, McpServerConfig>
  skills: string[]
  threads: string[]
}

export type PluginClientInput = { path: string; cwd: string }

export type PluginClientOutput = PluginManifest | { isError: true; message: string }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLUGIN_CLIENT_TOOL_NAME = 'plugin-client'

const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

// §5.5: 1–64 chars, lowercase alnum + - + ., start/end alnum, no --/..
const NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/
const NAME_NO_DOUBLE = /(--|\.\.)/

// ---------------------------------------------------------------------------
// plugin.json schema — closed top-level; unknown fields are *report-and-
// ignore* so we validate the known fields individually and collect unknowns
// separately rather than using additionalProperties: false at the top level.
// ---------------------------------------------------------------------------

const authorSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', nullable: true },
    email: { type: 'string', nullable: true },
    url: { type: 'string', nullable: true },
  },
  additionalProperties: false,
} as const

// The known top-level fields per §5.2
const KNOWN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
])

// ---------------------------------------------------------------------------
// mcp.json schemas — two-stage: top-level then per-entry
// ---------------------------------------------------------------------------

const mcpTopSchema = {
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    mcpServers: { type: 'object' },
  },
  required: ['$schema', 'mcpServers'],
  additionalProperties: false,
} as const

const stdioServerSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', const: 'stdio' },
    command: { type: 'string', minLength: 1 },
    args: { type: 'array', items: { type: 'string' }, nullable: true },
    env: { type: 'object', additionalProperties: { type: 'string' }, nullable: true },
    cwd: { type: 'string', nullable: true },
  },
  required: ['type', 'command'],
  additionalProperties: false,
} as const

const httpServerSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['streamable-http', 'sse'] },
    url: { type: 'string', minLength: 1 },
    headers: { type: 'object', additionalProperties: { type: 'string' }, nullable: true },
  },
  required: ['type', 'url'],
  additionalProperties: false,
} as const

const validateMcpTop = ajv.compile(mcpTopSchema)
const validateStdioServer = ajv.compile(stdioServerSchema)
const validateHttpServer = ajv.compile(httpServerSchema)

// ---------------------------------------------------------------------------
// Tool input / output JSON schemas
// ---------------------------------------------------------------------------

export const PluginClientInputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'plugin.json path — absolute, or relative to the provisioned cwd' },
    cwd: { type: 'string', minLength: 1, description: "the tool's provisioned cwd" },
  },
  required: ['path', 'cwd'],
  additionalProperties: false,
  description: 'Load + validate a plugin package (plugin.json + mcp.json + skills/ + extensions).',
} as unknown as JSONSchemaType<PluginClientInput>

export const PluginClientOutputSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        name: { type: 'string' },
        version: { type: 'string', nullable: true },
        mcps: { type: 'object' },
        skills: { type: 'array', items: { type: 'string' } },
        threads: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'mcps', 'skills', 'threads', 'warnings'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        isError: { type: 'boolean', const: true },
        message: { type: 'string', minLength: 1 },
      },
      required: ['isError', 'message'],
      additionalProperties: false,
    },
  ],
  description: 'Normalized plugin manifest, or { isError, message } on failure.',
} as unknown as JSONSchemaType<PluginClientOutput>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const validateName = (name: unknown): boolean => {
  if (typeof name !== 'string') return false
  if (name.length < 1 || name.length > 64) return false
  if (!NAME_PATTERN.test(name)) return false
  if (NAME_NO_DOUBLE.test(name)) return false
  return true
}

/** Extract the schema version from a $schema URL for cross-file comparison. */
const schemaVersion = (url: string): string | null => {
  const m = url.match(/\/schemas\/([^/]+)\//)
  return m?.[1] ?? null
}

// §7.2.1: command must be a single executable token — a bare name (no `/`)
// or a plugin-relative path beginning with `./`. Not a shell string, not an
// absolute path, not a nested path without the `./` prefix.
const isValidStdioCommand = (command: string): boolean => {
  if (command.startsWith('/') || /\s/.test(command)) return false
  if (command.startsWith('./')) return true
  return !command.includes('/')
}

const PLUGIN_ROOT_TOKEN = '${PLUGIN_ROOT}'
const PLUGIN_DATA_TOKEN = '${PLUGIN_DATA}'

// §7.2.1: stdio cwd must be `./`-prefixed or ${PLUGIN_ROOT}/${PLUGIN_DATA}-
// rooted, and plugin-rooted values must stay within the root post-resolution.
// ${PLUGIN_DATA} targets a client-managed directory, so any rooted form is
// accepted here.
// §7.2.1: remote server URLs must be absolute HTTP(S), carry no userinfo or
// fragment, and use HTTPS unless the host is a loopback address (exactly
// `localhost` or an IP literal in a loopback range).
const isLoopbackHost = (hostname: string): boolean => {
  if (hostname === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const first = Number(hostname.split('.')[0])
    return first === 127
  }
  return hostname === '::1' || hostname === '[::1]'
}

// RFC 7230 token characters — the legal header-name character set.
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/

// §7.2.1: header names must be valid HTTP tokens, and the same name must not
// appear twice under different casing (names are case-insensitive).
const isValidHeaderSet = (headers: Record<string, string>): boolean => {
  const seen = new Set<string>()
  for (const name of Object.keys(headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) return false
    const lower = name.toLowerCase()
    if (seen.has(lower)) return false
    seen.add(lower)
  }
  return true
}

const isValidHttpUrl = (rawUrl: string): boolean => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.hash !== '') return false
  if (url.protocol === 'https:') return true
  return isLoopbackHost(url.hostname)
}

const isValidStdioCwd = (cwd: string): boolean => {
  if (cwd === PLUGIN_DATA_TOKEN || cwd.startsWith(`${PLUGIN_DATA_TOKEN}/`)) return true

  let relativeToRoot: string | null = null
  if (cwd === PLUGIN_ROOT_TOKEN) relativeToRoot = '.'
  else if (cwd.startsWith(`${PLUGIN_ROOT_TOKEN}/`)) relativeToRoot = cwd.slice(PLUGIN_ROOT_TOKEN.length + 1)
  else if (cwd.startsWith('./')) relativeToRoot = cwd.slice(2)
  else return false

  // A `..` segment at this depth escapes the plugin root — reject it before
  // normalize() silently resolves it.
  return relativeToRoot.split('/').every((segment) => segment !== '..')
}

// ---------------------------------------------------------------------------
// Validation stages
// ---------------------------------------------------------------------------
type FatalResult = { isError: true; message: string }

const validatePluginJson = (
  parsed: unknown,
):
  | FatalResult
  | {
      name: string
      version?: string
      unknownFields: string[]
    } => {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { isError: true, message: 'plugin.json must be a JSON object' }
  }
  const obj = parsed as Record<string, unknown>

  // $schema — required, must match the canonical URL
  if (obj.$schema !== PLUGIN_SCHEMA_URL) {
    return { isError: true, message: `plugin.json $schema must be ${PLUGIN_SCHEMA_URL}` }
  }

  // name — required, §5.5 constraints
  if (!('name' in obj)) {
    return { isError: true, message: 'plugin.json missing required field: name' }
  }
  if (!validateName(obj.name)) {
    return { isError: true, message: `plugin.json name "${obj.name}" violates §5.5 naming constraints` }
  }

  // Validate known metadata fields (fatal if wrong type)
  if ('version' in obj && typeof obj.version !== 'string') {
    return { isError: true, message: 'plugin.json version must be a string' }
  }
  if ('description' in obj && typeof obj.description !== 'string') {
    return { isError: true, message: 'plugin.json description must be a string' }
  }
  if ('homepage' in obj && typeof obj.homepage !== 'string') {
    return { isError: true, message: 'plugin.json homepage must be a string' }
  }
  if ('repository' in obj && typeof obj.repository !== 'string') {
    return { isError: true, message: 'plugin.json repository must be a string' }
  }
  if ('license' in obj && typeof obj.license !== 'string') {
    return { isError: true, message: 'plugin.json license must be a string' }
  }
  if ('keywords' in obj) {
    if (!Array.isArray(obj.keywords) || obj.keywords.some((k) => typeof k !== 'string')) {
      return { isError: true, message: 'plugin.json keywords must be an array of strings' }
    }
  }
  if ('author' in obj) {
    const authorValid = ajv.compile(authorSchema)
    if (!authorValid(obj.author)) {
      return {
        isError: true,
        message: 'plugin.json author must be an object with optional name, email, url string fields',
      }
    }
  }

  // extensions — must be an object if present; its namespaces are unread,
  // client-owned annexes (§8.1)
  if ('extensions' in obj) {
    if (typeof obj.extensions !== 'object' || obj.extensions === null || Array.isArray(obj.extensions)) {
      return { isError: true, message: 'plugin.json extensions must be an object' }
    }
  }

  // Report-and-ignore unknown top-level fields (§5.2, non-fatal)
  const unknownFields = Object.keys(obj).filter((key) => !KNOWN_FIELDS.has(key))

  return { name: obj.name as string, version: obj.version as string | undefined, unknownFields }
}

const loadMcpJson = async (
  mcpPath: string,
  pluginSchemaVersion: string | null,
  warnings: string[],
): Promise<Record<string, McpServerConfig>> => {
  const file = Bun.file(mcpPath)
  if (!(await file.exists())) return {}

  let text: string
  try {
    text = await file.text()
  } catch {
    warnings.push('mcp.json could not be read; MCP disabled')
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    warnings.push('mcp.json is not valid JSON; MCP disabled')
    return {}
  }

  // Stage 1: top-level validation
  if (!validateMcpTop(parsed)) {
    warnings.push('mcp.json failed top-level validation; MCP disabled')
    return {}
  }

  const mcpTop = parsed as { $schema: string; mcpServers: Record<string, unknown> }

  // §10.1: $schema version must match plugin.json's
  const mcpVersion = schemaVersion(mcpTop.$schema)
  if (mcpVersion !== pluginSchemaVersion) {
    warnings.push(
      `mcp.json $schema version (${mcpVersion ?? 'unknown'}) does not match plugin.json (${pluginSchemaVersion}); MCP disabled`,
    )
    return {}
  }

  // Stage 2: per-entry validation with failure isolation
  const result: Record<string, McpServerConfig> = {}
  for (const [name, entry] of Object.entries(mcpTop.mcpServers)) {
    if (validateStdioServer(entry)) {
      const command = (entry as { command: string }).command
      if (!isValidStdioCommand(command)) {
        warnings.push(
          `mcp server "${name}" skipped: command must be a single executable token (bare name or ./-prefixed)`,
        )
        continue
      }
      const rawCwd = (entry as { cwd?: string }).cwd
      if (rawCwd !== undefined && !isValidStdioCwd(rawCwd)) {
        warnings.push(
          `mcp server "${name}" skipped: cwd must be ./-prefixed or ${PLUGIN_ROOT_TOKEN}/${PLUGIN_DATA_TOKEN}-rooted and stay within the plugin root`,
        )
        continue
      }
      result[name] = entry as McpServerConfig
    } else if (validateHttpServer(entry)) {
      const url = (entry as { url: string }).url
      if (!isValidHttpUrl(url)) {
        warnings.push(
          `mcp server "${name}" skipped: url must be absolute http(s), without userinfo/fragment, https for non-loopback hosts`,
        )
        continue
      }
      const headers = (entry as { headers?: Record<string, string> }).headers
      if (headers !== undefined && !isValidHeaderSet(headers)) {
        warnings.push(
          `mcp server "${name}" skipped: header names must be valid HTTP tokens without case-insensitive duplicates`,
        )
        continue
      }
      result[name] = entry as McpServerConfig
    } else {
      warnings.push(`mcp server "${name}" skipped: invalid server entry`)
    }
    // Bad entry skipped, siblings continue
  }
  return result
}

const discoverSkills = async (skillsDir: string): Promise<string[]> => {
  // missing skills/ = valid absence
  try {
    const entries = await Array.fromAsync(new Bun.Glob('*/SKILL.md').scan({ cwd: skillsDir, onlyFiles: true }))
    return entries.map((e) => e.split('/')[0] as string)
  } catch {
    return []
  }
}

const discoverThreads = async (threadsDir: string): Promise<string[]> => {
  // missing threads/ = valid absence; plain ungated discovery — no gating
  try {
    const allFiles = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: threadsDir, onlyFiles: true }))
    return allFiles.sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Tool run — stateless, read-only; errors → { isError, message }
// ---------------------------------------------------------------------------

const run = async (input: PluginClientInput): Promise<PluginClientOutput> => {
  const resolved = path.resolve(input.cwd, input.path)
  const pluginRoot = path.dirname(resolved)

  // 1. Read + parse plugin.json
  const file = Bun.file(resolved)
  if (!(await file.exists())) {
    return { isError: true, message: `plugin.json not found at ${input.path}` }
  }

  let text: string
  try {
    text = await file.text()
  } catch (err) {
    return { isError: true, message: `Could not read plugin.json at ${input.path}: ${errMessage(err)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { isError: true, message: `Invalid JSON in plugin.json at ${input.path}: ${errMessage(err)}` }
  }

  // 2. Validate plugin.json
  const pluginResult = validatePluginJson(parsed)
  if ('isError' in pluginResult) return pluginResult

  const { name, version, unknownFields } = pluginResult

  // §5.2: unknown top-level fields are reported and ignored (non-fatal).
  const warnings: string[] = []
  if (unknownFields.length > 0) {
    warnings.push(`plugin.json: ignoring unknown top-level field(s): ${unknownFields.join(', ')}`)
  }

  // 3. Load mcp.json
  const pVersion = schemaVersion(PLUGIN_SCHEMA_URL)
  const mcps = await loadMcpJson(path.join(pluginRoot, 'mcp.json'), pVersion, warnings)

  // 4. Discover skills
  const skills = await discoverSkills(path.join(pluginRoot, 'skills'))

  // 5. Discover threads (plain, ungated)
  const threads = await discoverThreads(path.join(pluginRoot, 'threads'))

  return {
    name,
    version,
    mcps,
    skills,
    threads,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// defineTool registration
// ---------------------------------------------------------------------------

/**
 * Load and validate a plugin package as a conformant Agent Plugins v1 client.
 * Validates plugin.json (closed schema, §5.2/§5.5), mcp.json (two-stage,
 * failure isolation), discovers skills/ from the fixed location, and
 * discovers threads/ as a plain ungated component dir. Extension namespaces
 * are unread, client-owned annexes (portable-only surface). Returns the
 * normalized manifest `{ name, version, mcps, skills, threads, warnings }`,
 * or `{ isError, message }` on failure.
 */
export const pluginClient = defineTool(
  {
    name: PLUGIN_CLIENT_TOOL_NAME,
    description:
      'Load and validate a plugin package (Agent Plugins v1 conformant ' +
      'client). Validates plugin.json + mcp.json, discovers skills/ and ' +
      'threads/. Returns { name, version, mcps, skills, threads, warnings } ' +
      'or { isError, message }.',
    inputSchema: PluginClientInputSchema,
    outputSchema: PluginClientOutputSchema,
  },
  run,
)

/**
 * The plugin-client thread library — the ICL replacement for the plugin-client
 * tool: a boot thread requests the manifest-scan recipe through the tools
 * worker (`bun run -`, the recipe on stdin, `format: 'json'`), and a transform
 * threads the result into the store as the PLUGINS manifest tenant.
 *
 * The recipe carries the Agent Plugins v1 §11.3 validation posture verbatim:
 * fatal (bad `$schema`/`name`/metadata types — the plugin is rejected, no
 * components discovered), report-and-ignore (unknown top-level fields,
 * §5.2), skipped (a bad mcp.json server entry with siblings still loading;
 * mcp.json `$schema` version mismatch — MCP disabled, skills still load),
 * ignored (unknown extension namespaces — unread annexes, §8.1).
 *
 * Hand-rolled, not ajv-compiled: `bun run -` executes in arbitrary cwds
 * where node_modules resolution is not guaranteed, so the recipe is
 * dependency-free (node:fs + Bun builtins only) with the §5.2/§7.2.1 checks
 * hand-rolled to the same semantics. Fixture-porting against the tool's
 * spec cases is the equivalence proof.
 *
 * MINIMAL: the scan roots are the conventional `.agents/plugins/` at project
 * + user scope — the mirrors of the skills domain (the tool took explicit
 * paths; a boot scan needs a root). No dedup/precedence across scopes: the
 * recipe is a READER; admission policy (name collisions, gating) belongs to
 * the governor threads per the ruling. The whole manifest set is ONE store
 * value (`plugins`/`manifests`) — per-plugin row fan-out deferred with the
 * same one-target-per-transform rule as the skills catalog.
 *
 * @packageDocumentation
 */

import type { Thread } from '../behavioral/behavioral.types.ts'
import { WORKER_MESSAGE_KINDS } from '../workers/workers.constants.ts'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The logical scan executor name — routes through the tools worker (`bun run -`). */
export const PLUGIN_SCAN_TOOL = 'plugin-scan'

/** The boot scan call's correlation id. */
export const PLUGIN_SCAN_CALL_ID = 'plugin-scan-manifests'

/** The store collection holding the plugin manifests. */
export const PLUGIN_MANIFESTS_COLLECTION = 'plugins'

/** The manifests' store key — one value, the whole manifest set (v1). */
export const PLUGIN_MANIFESTS_KEY = 'manifests'

// ── The manifest schemas — schema-data: one shape, three uses (thread gate,
// store admission / governor consumption, future model-facing context) ───────

/** A normalized plugin manifest — the governor's admission input. */
export const PLUGIN_MANIFEST_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    version: { type: 'string' },
    mcps: {
      type: 'object',
      // Per-server configs are loose here — their strict shape was validated
      // by the recipe (§7.2.1); the wire payload stays payloads-loose.
      additionalProperties: true,
    },
    skills: { type: 'array', items: { type: 'string' } },
    threads: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'mcps', 'skills', 'threads', 'warnings'],
  additionalProperties: false,
} as const

/**
 * The recipe→store contract: the coarse manifest-set envelope, enforced by
 * the manifests transform's detailSchema BEFORE the put — validate-before-put
 * as a hard gate (fail-closed, never partial admission). Strictness is scoped
 * to `jsonData`; the surrounding ToolsResult fields stay loose (their schema
 * home is the tools family).
 */
export const PLUGIN_MANIFESTS_SCHEMA = {
  type: 'object',
  properties: {
    plugins: { type: 'array', items: PLUGIN_MANIFEST_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['plugins', 'warnings'],
  additionalProperties: false,
} as const

// ── The manifest-scan recipe (stored-recipe flavor: contract-pinned,
//    replayed verbatim — the §11.3 posture is zero-variance logic) ───────────

/**
 * The plugin-scan recipe — executed by the tools worker as `bun run -` stdin.
 *
 * Scans `<cwd>/.agents/plugins/` (project) and `<HOME>/.agents/plugins/`
 * (user); for each plugin dir: read + parse plugin.json → fatal validation
 * (a fatal plugin is skipped with a scan-level warning, others load) →
 * mcp.json two-stage validation with failure isolation → skills/ + threads/
 * discovery. Output is one JSON object on stdout:
 * `{ plugins: [manifest…], warnings: [scan-level…] }`, sorted by name.
 */
export const PLUGIN_SCAN_SCRIPT = `
import { readdirSync } from 'node:fs'
import * as path from 'node:path'

const PLUGIN_DIR_NAME = '.agents/plugins'
const PLUGIN_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/
const NAME_NO_DOUBLE = /(--|\\.\\.)/
const KNOWN_FIELDS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'])
const AUTHOR_FIELDS = new Set(['name', 'email', 'url'])
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd'])
const HTTP_FIELDS = new Set(['type', 'url', 'headers'])
const PLUGIN_ROOT_TOKEN = '$' + '{PLUGIN_ROOT}'
const PLUGIN_DATA_TOKEN = '$' + '{PLUGIN_DATA}'

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const msg = (err) => (err instanceof Error ? err.message : String(err))

const validateName = (name) =>
  typeof name === 'string' &&
  name.length >= 1 &&
  name.length <= 64 &&
  NAME_PATTERN.test(name) &&
  !NAME_NO_DOUBLE.test(name)

const schemaVersion = (url) => {
  const m = url.match(/\\/schemas\\/([^/]+)\\//)
  return m === null ? null : m[1]
}

// §7.2.1: a single executable token — a bare name or a ./-prefixed path.
const isValidStdioCommand = (command) => {
  if (command.startsWith('/') || /\\s/.test(command)) return false
  if (command.startsWith('./')) return true
  return !command.includes('/')
}

const isLoopbackHost = (hostname) => {
  if (hostname === 'localhost') return true
  if (/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(hostname)) return Number(hostname.split('.')[0]) === 127
  return hostname === '::1' || hostname === '[::1]'
}

// RFC 7230 token characters.
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/

const isValidHeaderSet = (headers) => {
  const seen = new Set()
  for (const name of Object.keys(headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) return false
    const lower = name.toLowerCase()
    if (seen.has(lower)) return false
    seen.add(lower)
  }
  return true
}

// §7.2.1: absolute http(s), no userinfo/fragment, https unless loopback.
const isValidHttpUrl = (rawUrl) => {
  let url
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

// §7.2.1: ./-prefixed or token-rooted, staying within the plugin root.
const isValidStdioCwd = (cwd) => {
  if (cwd === PLUGIN_DATA_TOKEN || cwd.startsWith(PLUGIN_DATA_TOKEN + '/')) return true
  let relativeToRoot = null
  if (cwd === PLUGIN_ROOT_TOKEN) relativeToRoot = '.'
  else if (cwd.startsWith(PLUGIN_ROOT_TOKEN + '/')) relativeToRoot = cwd.slice(PLUGIN_ROOT_TOKEN.length + 1)
  else if (cwd.startsWith('./')) relativeToRoot = cwd.slice(2)
  else return false
  return relativeToRoot.split('/').every((segment) => segment !== '..')
}

const validStdioEntry = (entry) => {
  if (!isPlainObject(entry)) return false
  if (!Object.keys(entry).every((k) => STDIO_FIELDS.has(k))) return false
  if (entry.type !== 'stdio') return false
  if (typeof entry.command !== 'string' || entry.command.length === 0) return false
  if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === 'string'))) return false
  if (entry.env !== undefined && !(isPlainObject(entry.env) && Object.values(entry.env).every((v) => typeof v === 'string'))) return false
  if (entry.cwd !== undefined && typeof entry.cwd !== 'string') return false
  return true
}

const validHttpEntry = (entry) => {
  if (!isPlainObject(entry)) return false
  if (!Object.keys(entry).every((k) => HTTP_FIELDS.has(k))) return false
  if (entry.type !== 'streamable-http' && entry.type !== 'sse') return false
  if (typeof entry.url !== 'string' || entry.url.length === 0) return false
  if (entry.headers !== undefined && !(isPlainObject(entry.headers) && Object.values(entry.headers).every((v) => typeof v === 'string'))) return false
  return true
}

const validMcpTop = (parsed) =>
  isPlainObject(parsed) &&
  typeof parsed.$schema === 'string' &&
  isPlainObject(parsed.mcpServers) &&
  Object.keys(parsed).every((k) => k === '$schema' || k === 'mcpServers')

// Fatal plugin.json validation — same posture as the tool (§5.2/§5.5).
const validatePluginJson = (parsed) => {
  if (!isPlainObject(parsed)) return { isError: true, message: 'plugin.json must be a JSON object' }
  if (parsed.$schema !== PLUGIN_SCHEMA_URL) {
    return { isError: true, message: 'plugin.json $schema must be ' + PLUGIN_SCHEMA_URL }
  }
  if (!('name' in parsed)) {
    return { isError: true, message: 'plugin.json missing required field: name' }
  }
  if (!validateName(parsed.name)) {
    return { isError: true, message: 'plugin.json name "' + String(parsed.name) + '" violates naming constraints' }
  }
  if ('version' in parsed && typeof parsed.version !== 'string') {
    return { isError: true, message: 'plugin.json version must be a string' }
  }
  if ('description' in parsed && typeof parsed.description !== 'string') {
    return { isError: true, message: 'plugin.json description must be a string' }
  }
  if ('homepage' in parsed && typeof parsed.homepage !== 'string') {
    return { isError: true, message: 'plugin.json homepage must be a string' }
  }
  if ('repository' in parsed && typeof parsed.repository !== 'string') {
    return { isError: true, message: 'plugin.json repository must be a string' }
  }
  if ('license' in parsed && typeof parsed.license !== 'string') {
    return { isError: true, message: 'plugin.json license must be a string' }
  }
  if ('keywords' in parsed && !(Array.isArray(parsed.keywords) && parsed.keywords.every((k) => typeof k === 'string'))) {
    return { isError: true, message: 'plugin.json keywords must be an array of strings' }
  }
  if ('author' in parsed) {
    const author = parsed.author
    if (!isPlainObject(author) || !Object.keys(author).every((k) => AUTHOR_FIELDS.has(k)) || !Object.values(author).every((v) => typeof v === 'string')) {
      return { isError: true, message: 'plugin.json author must be an object with optional name, email, url string fields' }
    }
  }
  if ('extensions' in parsed && !isPlainObject(parsed.extensions)) {
    return { isError: true, message: 'plugin.json extensions must be an object' }
  }
  return {
    name: parsed.name,
    version: parsed.version,
    unknownFields: Object.keys(parsed).filter((key) => !KNOWN_FIELDS.has(key)),
  }
}

const loadMcpJson = async (mcpPath, pluginSchemaVersion, warnings) => {
  const file = Bun.file(mcpPath)
  if (!(await file.exists())) return {}

  let text
  try {
    text = await file.text()
  } catch {
    warnings.push('mcp.json could not be read; MCP disabled')
    return {}
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    warnings.push('mcp.json is not valid JSON; MCP disabled')
    return {}
  }

  if (!validMcpTop(parsed)) {
    warnings.push('mcp.json failed top-level validation; MCP disabled')
    return {}
  }

  const mcpVersion = schemaVersion(parsed.$schema)
  if (mcpVersion !== pluginSchemaVersion) {
    warnings.push('mcp.json $schema version (' + String(mcpVersion) + ') does not match plugin.json (' + String(pluginSchemaVersion) + '); MCP disabled')
    return {}
  }

  // Per-entry validation with failure isolation — a bad entry is skipped,
  // siblings still load.
  const result = {}
  for (const name of Object.keys(parsed.mcpServers)) {
    const entry = parsed.mcpServers[name]
    if (validStdioEntry(entry)) {
      if (!isValidStdioCommand(entry.command)) {
        warnings.push('mcp server "' + name + '" skipped: command must be a single executable token (bare name or ./-prefixed)')
        continue
      }
      if (entry.cwd !== undefined && !isValidStdioCwd(entry.cwd)) {
        warnings.push('mcp server "' + name + '" skipped: cwd must be ./-prefixed or ' + PLUGIN_ROOT_TOKEN + '/' + PLUGIN_DATA_TOKEN + '-rooted and stay within the plugin root')
        continue
      }
      result[name] = entry
    } else if (validHttpEntry(entry)) {
      if (!isValidHttpUrl(entry.url)) {
        warnings.push('mcp server "' + name + '" skipped: url must be absolute http(s), without userinfo/fragment, https for non-loopback hosts')
        continue
      }
      if (entry.headers !== undefined && !isValidHeaderSet(entry.headers)) {
        warnings.push('mcp server "' + name + '" skipped: header names must be valid HTTP tokens without case-insensitive duplicates')
        continue
      }
      result[name] = entry
    } else {
      warnings.push('mcp server "' + name + '" skipped: invalid server entry')
    }
  }
  return result
}

const discoverSkills = async (skillsDir) => {
  try {
    const entries = await Array.fromAsync(new Bun.Glob('*/SKILL.md').scan({ cwd: skillsDir, onlyFiles: true }))
    return entries.map((e) => e.split('/')[0])
  } catch {
    return []
  }
}

const discoverThreads = async (threadsDir) => {
  try {
    const allFiles = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: threadsDir, onlyFiles: true }))
    return allFiles.sort()
  } catch {
    return []
  }
}

// One plugin: manifest on success, a skip message on fatal, null when the
// directory is not a plugin (no plugin.json — skipped silently).
const scanPlugin = async (pluginJsonPath) => {
  const pluginRoot = path.dirname(pluginJsonPath)
  const file = Bun.file(pluginJsonPath)
  if (!(await file.exists())) return null
  let text
  try {
    text = await file.text()
  } catch (err) {
    return { skip: 'Could not read plugin.json: ' + msg(err) }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { skip: 'Invalid JSON in plugin.json: ' + msg(err) }
  }
  const pluginResult = validatePluginJson(parsed)
  if (pluginResult.isError === true) return { skip: pluginResult.message }

  const warnings = []
  if (pluginResult.unknownFields.length > 0) {
    warnings.push('plugin.json: ignoring unknown top-level field(s): ' + pluginResult.unknownFields.join(', '))
  }
  const mcps = await loadMcpJson(path.join(pluginRoot, 'mcp.json'), schemaVersion(PLUGIN_SCHEMA_URL), warnings)
  const skills = await discoverSkills(path.join(pluginRoot, 'skills'))
  const threads = await discoverThreads(path.join(pluginRoot, 'threads'))
  const manifest = { name: pluginResult.name, mcps, skills, threads, warnings }
  if (pluginResult.version !== undefined) manifest.version = pluginResult.version
  return { manifest }
}

const scanRoot = async (pluginsRoot, manifests, warnings) => {
  let entries
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue
    const result = await scanPlugin(pluginsRoot + '/' + entry.name + '/plugin.json')
    if (result === null) continue
    if (result.skip !== undefined) {
      warnings.push('Skipped plugin at ' + pluginsRoot + '/' + entry.name + ': ' + result.skip)
      continue
    }
    manifests.push(result.manifest)
  }
}

const manifests = []
const warnings = []
const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
await scanRoot(home + '/' + PLUGIN_DIR_NAME, manifests, warnings)
await scanRoot(process.cwd() + '/' + PLUGIN_DIR_NAME, manifests, warnings)

manifests.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
console.log(JSON.stringify({ plugins: manifests, warnings }))
`

// ── Threads ───────────────────────────────────────────────────────────────────

/** scan-boot — once: the manifest-scan recipe is requested at boot; the tools worker pipes it. */
const pluginScanBoot: Thread = {
  label: 'plugin/scan-boot',
  once: true,
  rules: [
    {
      request: {
        type: WORKER_MESSAGE_KINDS.tool_call,
        detail: {
          id: PLUGIN_SCAN_CALL_ID,
          tool: PLUGIN_SCAN_TOOL,
          input: { script: 'bun run -', stdin: PLUGIN_SCAN_SCRIPT, format: 'json' },
        },
      },
    },
  ],
}

/** manifests — a scan result carrying plugin manifests is put into the store as one value. */
const pluginManifests: Thread = {
  label: 'plugin/manifests',
  rules: [
    {
      transform: [
        {
          type: WORKER_MESSAGE_KINDS.tool_call_result,
          query:
            '. as $d | select($d.result.jsonData.plugins? != null) | {id: $d.id, op: "put", input: {collection: "plugins", key: "manifests", value: $d.result.jsonData}}',
          target: WORKER_MESSAGE_KINDS.store_request,
          // The validate-before-put gate: the envelope schema nests under
          // jsonData — strict at the payload, loose around it (absent
          // jsonData passes and the query rejects instead).
          detailSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              result: {
                type: 'object',
                properties: { jsonData: PLUGIN_MANIFESTS_SCHEMA },
                required: ['jsonData'],
                additionalProperties: true,
              },
            },
            required: ['id', 'result'],
          },
        },
      ],
    },
  ],
}

/** The plugin-client thread library — add to the program alongside the satellites. */
export const pluginThreads: Thread[] = [pluginScanBoot, pluginManifests]

import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { ajv } from '../define-tool.ts'
import {
  PluginClientInputSchema,
  type PluginClientOutput,
  PluginClientOutputSchema,
  type PluginManifest,
  pluginClient as pluginClientBinder,
} from '../plugin-client.ts'

// Defined once, bound late — the test context carries no capabilities.
const pluginClient = pluginClientBinder(undefined)

const validateInput = ajv.compile(PluginClientInputSchema)
const validateOutput = ajv.compile(PluginClientOutputSchema)

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

// ---------------------------------------------------------------------------
// Helpers — create a temp plugin dir with plugin.json, mcp.json, skills/, threads/
// ---------------------------------------------------------------------------

const tempDir = async (): Promise<string> => (await Bun.$`mktemp -d`.quiet().text()).trim()

type PluginFiles = {
  pluginJson?: unknown
  mcpJson?: unknown
  skills?: Record<string, string> // dir name → SKILL.md content
  threads?: Record<string, string> // file name → content
}

const makePlugin = async (dir: string, files: PluginFiles): Promise<string> => {
  await Bun.write(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      files.pluginJson ?? {
        $schema: PLUGIN_SCHEMA,
        name: 'test-plugin',
      },
    ),
  )
  if (files.mcpJson !== undefined) {
    await Bun.write(path.join(dir, 'mcp.json'), JSON.stringify(files.mcpJson))
  }
  if (files.skills) {
    for (const [skillDir, skillContent] of Object.entries(files.skills)) {
      const skillPath = path.join(dir, 'skills', skillDir)
      await Bun.$`mkdir -p ${skillPath}`.quiet()
      await Bun.write(path.join(skillPath, 'SKILL.md'), skillContent)
    }
  }
  if (files.threads) {
    const threadsDir = path.join(dir, 'threads')
    await Bun.$`mkdir -p ${threadsDir}`.quiet()
    for (const [fileName, content] of Object.entries(files.threads)) {
      await Bun.write(path.join(threadsDir, fileName), content)
    }
  }
  return dir
}

const run = (dir: string): Promise<PluginClientOutput> =>
  pluginClient({ path: 'plugin.json', cwd: dir }) as Promise<PluginClientOutput>

const ok = (r: PluginClientOutput): r is PluginManifest => !('isError' in r)
const err = (r: PluginClientOutput): r is { isError: true; message: string } => 'isError' in r

/** Access a field from a PluginClientOutput, asserting it's a manifest first. */
const manifest = (r: PluginClientOutput): PluginManifest => {
  if ('isError' in r) throw new Error(`expected manifest, got error: ${r.message}`)
  return r
}

/** Access a field from a PluginClientOutput, asserting it's an error first. */
const errorMsg = (r: PluginClientOutput): string => {
  if (!('isError' in r)) throw new Error('expected error, got manifest')
  return r.message
}

// ---------------------------------------------------------------------------
// Input / output schema contract
// ---------------------------------------------------------------------------

describe('plugin-client — input/output schema', () => {
  test('input schema requires path + cwd', () => {
    expect(validateInput({ path: 'plugin.json' })).toBe(false)
    expect(validateInput({ cwd: '/x' })).toBe(false)
    expect(validateInput({ path: 'plugin.json', cwd: '/x' })).toBe(true)
  })

  test('output schema accepts a success manifest', () => {
    expect(
      validateOutput({
        name: 'test',
        version: '0.0.1',
        mcps: {},
        skills: ['behavioral'],
        threads: [],
        warnings: [],
      }),
    ).toBe(true)
  })

  test('output schema rejects legacy sh.behavioral fields (models/spaces)', () => {
    expect(
      validateOutput({
        name: 'test',
        mcps: {},
        skills: [],
        threads: [],
        warnings: [],
        models: [],
        spaces: {},
      }),
    ).toBe(false)
  })

  test('output schema accepts an error', () => {
    expect(validateOutput({ isError: true, message: 'bad' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// plugin.json validation — fatal vs report-and-ignore
// ---------------------------------------------------------------------------

describe('plugin-client — plugin.json validation', () => {
  test('parses a minimal valid plugin.json (only $schema + name)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('test-plugin')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('parses a full valid plugin.json with all metadata fields', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'my.plugin',
          version: '1.2.3',
          description: 'test',
          author: { name: 'dev', email: 'dev@x.com', url: 'https://x.com' },
          homepage: 'https://x.com',
          repository: 'https://github.com/x/y',
          license: 'ISC',
          keywords: ['test'],
          extensions: { 'com.other.client': { arbitrary: true } },
        },
      })
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('my.plugin')
      expect(manifest(result).version).toBe('1.2.3')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects missing $schema (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { name: 'test-plugin' } })
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('schema')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects missing name (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA } })
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('name')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid name — uppercase (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA, name: 'My-Plugin' } })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid name — leading hyphen (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA, name: '-start' } })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid name — consecutive hyphens (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA, name: 'has--double' } })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid name — consecutive periods (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, { pluginJson: { $schema: PLUGIN_SCHEMA, name: 'too.many..dots' } })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('reports and ignores unknown top-level field (non-fatal, plugin still loads)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          unknownField: 'should-be-ignored',
        },
      })
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('test-plugin')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('rejects invalid author object — unknown field in author (fatal)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          author: { name: 'dev', bad: 1 },
        },
      })
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// mcp.json validation — two-stage, failure isolation
// ---------------------------------------------------------------------------

describe('plugin-client — mcp.json validation', () => {
  test('missing mcp.json = valid absence, mcps output is empty', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('parses a valid mcp.json with streamable-http server', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            'web-tools': { type: 'streamable-http', url: 'https://api.example.com/mcp' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        'web-tools': { type: 'streamable-http', url: 'https://api.example.com/mcp' },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('parses a valid mcp.json with stdio server', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            local: { type: 'stdio', command: './bin/server', args: ['--x'] },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        local: { type: 'stdio', command: './bin/server', args: ['--x'] },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('parses a valid mcp.json with sse server', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('empty mcpServers is valid', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: { $schema: MCP_SCHEMA, mcpServers: {} },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('stdio command with shell string is skipped (§7.2.1 single token)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            shell: { type: 'stdio', command: 'bash -c ls' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
      expect(manifest(result).warnings.some((w) => w.includes('shell') && w.includes('command'))).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('stdio command with absolute path is skipped (bare name or ./ only)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            abs: { type: 'stdio', command: '/usr/bin/thing' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('stdio cwd accepts ./, ${PLUGIN_ROOT}, ${PLUGIN_DATA} forms (§7.2.1)', async () => {
    const dir = await tempDir()
    try {
      const valid: Record<string, { type: 'stdio'; command: string; cwd: string }> = {
        a: { type: 'stdio', command: 'bun', cwd: './sub' },
        b: { type: 'stdio', command: 'bun', cwd: '${PLUGIN_ROOT}' },
        c: { type: 'stdio', command: 'bun', cwd: '${PLUGIN_ROOT}/bin' },
        d: { type: 'stdio', command: 'bun', cwd: '${PLUGIN_DATA}' },
        e: { type: 'stdio', command: 'bun', cwd: '${PLUGIN_DATA}/state' },
      }
      await makePlugin(dir, {
        mcpJson: { $schema: MCP_SCHEMA, mcpServers: valid },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual(valid)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('stdio cwd with unanchored or escaping form is skipped', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            rel: { type: 'stdio', command: 'bun', cwd: 'sub' },
            abs: { type: 'stdio', command: 'bun', cwd: '/abs' },
            up: { type: 'stdio', command: 'bun', cwd: '../up' },
            esc: { type: 'stdio', command: 'bun', cwd: '${PLUGIN_ROOT}/../escape' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
      expect(manifest(result).warnings.filter((w) => w.includes('cwd')).length).toBeGreaterThanOrEqual(4)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('http url rules: absolute, no userinfo/fragment, non-loopback needs https', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            goodLocalhost: { type: 'streamable-http', url: 'http://localhost:3000/mcp' },
            goodHttps: { type: 'streamable-http', url: 'https://api.example.com/mcp' },
            plainHttp: { type: 'streamable-http', url: 'http://api.example.com/mcp' },
            userinfo: { type: 'streamable-http', url: 'https://user:pass@api.example.com/mcp' },
            fragment: { type: 'streamable-http', url: 'https://api.example.com/mcp#frag' },
            ftp: { type: 'streamable-http', url: 'ftp://api.example.com/mcp' },
            loopbackIp: { type: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        goodLocalhost: { type: 'streamable-http', url: 'http://localhost:3000/mcp' },
        goodHttps: { type: 'streamable-http', url: 'https://api.example.com/mcp' },
        loopbackIp: { type: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' },
      })
      expect(manifest(result).warnings.filter((w) => w.includes('url')).length).toBe(4)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('header names must be valid HTTP tokens without case-insensitive duplicates (§7.2.1)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            ok: { type: 'streamable-http', url: 'https://x.com/mcp', headers: { 'X-Tenant': 'a', Accept: 'b' } },
            badName: { type: 'streamable-http', url: 'https://x.com/mcp', headers: { 'Bad Header': 'x' } },
            dupCase: {
              type: 'streamable-http',
              url: 'https://x.com/mcp',
              headers: { 'X-A': '1', 'x-a': '2' },
            },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        ok: { type: 'streamable-http', url: 'https://x.com/mcp', headers: { 'X-Tenant': 'a', Accept: 'b' } },
      })
      expect(manifest(result).warnings.filter((w) => w.includes('header')).length).toBe(2)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('bad mcp.json entry is skipped, siblings still load', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            good: { type: 'streamable-http', url: 'https://x.com/mcp' },
            bad: { type: 'streamable-http', url: 'https://y.com/mcp', unknownField: 1 },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({
        good: { type: 'streamable-http', url: 'https://x.com/mcp' },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('mcp.json $schema mismatch with plugin.json $schema → MCP disabled, skills still load', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
        },
        mcpJson: {
          $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
          mcpServers: {
            x: { type: 'streamable-http', url: 'https://x.com/mcp' },
          },
        },
        skills: { echo: '# echo skill' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
      expect(manifest(result).skills).toEqual(['echo'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('mcp.json with unknown top-level field is rejected (fatal for mcp)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {},
          extra: 1,
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('mcp.json missing mcpServers is rejected (fatal for mcp)', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: { $schema: MCP_SCHEMA },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).mcps).toEqual({})
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Skills discovery from skills/
// ---------------------------------------------------------------------------

describe('plugin-client — skills discovery', () => {
  test('missing skills/ = valid absence, skills output is empty', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).skills).toEqual([])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('discovers skill subdirs with SKILL.md', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        skills: { echo: '---\nname: echo\n---\n# Echo', grep: '---\nname: grep\n---\n# Grep' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).skills.sort()).toEqual(['echo', 'grep'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('skips non-conformant skill dirs (no SKILL.md), keeps loading others', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        skills: { echo: '---\nname: echo\n---\n# Echo' },
      })
      // Add a dir without SKILL.md
      await Bun.$`mkdir -p ${path.join(dir, 'skills', 'no-skill-md')}`.quiet()
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).skills).toEqual(['echo'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// extensions — unread, client-owned annexes (growth-model amendment:
// ALL sh.behavioral interpretation removed; the annex slot stays spec-sanctioned)
// ---------------------------------------------------------------------------

describe('plugin-client — extensions are unread client-owned annexes', () => {
  test('unknown extension namespaces are ignored without validating contents', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'com.other.client': { arbitrary: 'data', bad: 123 },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('test-plugin')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('a legacy sh.behavioral extension block is ignored, never interpreted', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': {
              models: [{ provider: 'openai', modelId: 'gpt-4o', endpointUrl: 'https://x/v1', apiKey: 'sk-secret' }],
              mcps: { include: ['other'] },
            },
          },
        },
        mcpJson: {
          $schema: MCP_SCHEMA,
          mcpServers: {
            'web-tools': { type: 'streamable-http', url: 'https://api.example.com/mcp' },
          },
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      // Ungated: mcp.json content survives untouched — the extension is not read
      expect(manifest(result).mcps).toEqual({
        'web-tools': { type: 'streamable-http', url: 'https://api.example.com/mcp' },
      })
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('absent extensions = valid', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('test-plugin')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Threads — plain ungated discovery from threads/
// ---------------------------------------------------------------------------

describe('plugin-client — threads', () => {
  test('absent threads/ + no threads extension → empty threads output', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {})
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).threads).toEqual([])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('threads/ exists but no extension gating → all threads included', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        threads: { 'provision.ts': '// thread', 'cleanup.ts': '// thread' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).threads.sort()).toEqual(['cleanup.ts', 'provision.ts'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('a legacy threads gating block in the extension is ignored — all threads discovered', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          extensions: {
            'sh.behavioral': { threads: { include: ['provision.ts'] } },
          },
        },
        threads: { 'provision.ts': '// thread', 'cleanup.ts': '// thread' },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).threads.sort()).toEqual(['cleanup.ts', 'provision.ts'])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('plugin-client — error cases', () => {
  test('returns isError when plugin.json does not exist', async () => {
    const dir = await tempDir()
    try {
      const result = await run(dir)
      expect(validateOutput(result)).toBe(true)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('not found')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('returns isError when plugin.json is not valid JSON', async () => {
    const dir = await tempDir()
    try {
      await Bun.write(path.join(dir, 'plugin.json'), '{ not json')
      const result = await run(dir)
      expect(err(result)).toBe(true)
      expect(errorMsg(result)).toContain('JSON')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('returns isError when plugin.json is not an object', async () => {
    const dir = await tempDir()
    try {
      await Bun.write(path.join(dir, 'plugin.json'), '[]')
      const result = await run(dir)
      expect(err(result)).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Real default plugin at repo root
// ---------------------------------------------------------------------------

describe('plugin-client — warnings channel', () => {
  test('unknown plugin.json top-level field → warning, plugin still loads', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        pluginJson: {
          $schema: PLUGIN_SCHEMA,
          name: 'test-plugin',
          customField: 'ignored',
        },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).name).toBe('test-plugin')
      expect(manifest(result).warnings.some((w) => w.includes('customField'))).toBe(true)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })

  test('clean plugin → empty warnings', async () => {
    const dir = await tempDir()
    try {
      await makePlugin(dir, {
        mcpJson: { $schema: MCP_SCHEMA, mcpServers: {} },
      })
      const result = await run(dir)
      expect(ok(result)).toBe(true)
      expect(manifest(result).warnings).toEqual([])
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet().nothrow()
    }
  })
})

// (The repo no longer ships a bundled plugin package — the growth model
// keeps plugin packaging as a deferred distribution format. Conformance is
// covered by the makePlugin fixtures above.)
